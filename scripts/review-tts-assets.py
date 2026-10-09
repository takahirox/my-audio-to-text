#!/usr/bin/env python3
"""Review pinned TTS assets for extension preparation; explicitly downloads weights.

Compare upstream LFS hashes already reviewed for #73 and record bounded 1 MiB
chunk hashes for extension ModelAssetCache. No runtime or inference registry.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CHUNK = 1024 * 1024
MODELS = (
    ('supertonic-3', 'supertone-oss-archive/supertonic-3', 'supertonic3-assets.json'),
    ('Kokoro-82M-v1.0-ONNX', 'onnx-community/Kokoro-82M-v1.0-ONNX', 'kokoro-assets.json'),
)


def main():
    reviewed = json.loads((ROOT / 'docs/tts-artifacts.json').read_text())
    for key, model, target in MODELS:
        entries = []
        for file in reviewed[key]['files']:
            path = ROOT / '.cache/tts-models' / key / file['path']
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                url = f"https://huggingface.co/{model}/resolve/{reviewed[key]['revision']}/{file['path']}"
                print(f"Downloading {model}/{file['path']}", flush=True)
                with urllib.request.urlopen(url, timeout=120) as response, path.open('wb') as output:
                    while chunk := response.read(CHUNK):
                        output.write(chunk)
            digest, chunks, size = hashlib.sha256(), [], 0
            with path.open('rb') as source:
                while chunk := source.read(CHUNK):
                    digest.update(chunk)
                    chunks.append(hashlib.sha256(chunk).hexdigest())
                    size += len(chunk)
            if size != file['bytes'] or (file['sha256'] and digest.hexdigest() != file['sha256']):
                raise RuntimeError(f"Reviewed size/hash mismatch: {path}")
            entries.append({'path': file['path'], 'bytes': size, 'sha256Chunks': chunks})
        (ROOT / 'extension' / target).write_text(json.dumps(entries, indent=2) + '\n')


if __name__ == '__main__':
    main()
