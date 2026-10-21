#!/usr/bin/env python3
"""Reproduce reviewed model manifests; compare diffs before accepting new pins.

Also seeds .cache for the real MV3 smoke. Model data only, no remote code.
Checks whole-file SHA-256 against upstream LFS before writing 1 MiB chunk pins.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODELS = [
    ('meeting-summary-lfm2', 'LiquidAI/LFM2.5-1.2B-JP-202606-ONNX', '01b5a0a33d22253d5ee52b367d2375eeb113b7cd', ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data']),
    ('meeting-summary-qwen35', 'onnx-community/Qwen3.5-2B-ONNX-OPT', 'ed446636739bf426e73c5a00714fd8e010d36c21', ['onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data', 'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data']),
]


def main():
    for key, model, revision, weights in MODELS:
        metadata = json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/{model}/revision/{revision}?blobs=true'))
        upstream = {f['rfilename']: f for f in metadata['siblings']}
        entries = []
        for name in ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'] + weights:
            target = ROOT / '.cache/meeting-summary' / revision / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                print(f'Downloading {key}: {name}', flush=True)
                partial = target.with_suffix(target.suffix + '.partial')
                with urllib.request.urlopen(f'https://huggingface.co/{model}/resolve/{revision}/{name}', timeout=180) as response, partial.open('wb') as output:
                    while block := response.read(1048576):
                        output.write(block)
                partial.replace(target)
            whole = hashlib.sha256()
            chunks = []
            with target.open('rb') as stream:
                while block := stream.read(1048576):
                    whole.update(block); chunks.append(hashlib.sha256(block).hexdigest())
            info = upstream[name]
            if target.stat().st_size != info['size'] or (info.get('lfs') and whole.hexdigest() != info['lfs']['sha256']):
                raise RuntimeError('Upstream checksum/size mismatch: ' + name)
            entries.append(dict(path=name, bytes=target.stat().st_size, sha256Chunks=chunks))
        output = ROOT / 'extension' / (key + '-assets.json')
        output.write_text(json.dumps(entries, indent=2) + '\n')
        print(f'Review {output.name}: {sum(f["bytes"] for f in entries):,} bytes', flush=True)


if __name__ == '__main__':
    main()
