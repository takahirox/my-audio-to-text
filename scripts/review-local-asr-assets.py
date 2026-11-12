#!/usr/bin/env python3
"""Maintainer-only downloads to reproduce immutable cache metadata (never a build step).

Every ASR file is checked against the pre-existing full SHA-256 specification
before deriving streaming 1 MiB hashes. Runtime/voice archives are pinned too.
"""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def verified(path, url, digest):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = path.read_bytes() if path.exists() else urllib.request.urlopen(url, timeout=300).read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError('Checksum mismatch: ' + str(path))
    path.write_bytes(data)
    return data


def entry(path, data, **extra):
    return dict(path=path, bytes=len(data), sha256Chunks=[hashlib.sha256(data[i:i+1048576]).hexdigest()
        for i in range(0, len(data), 1048576)], **extra)


def write(name, spec):
    (ROOT / 'extension' / (name + '-assets.json')).write_text(json.dumps(spec, indent=2) + '\n')


def main():
    for name, filename, key in [('reazon', 'reazon-ja-en-assets.json', 'models'),
                               ('whisper', 'whisper-assets.json', 'files'),
                               ('zipformer', 'zipformer-assets.json', 'files')]:
        spec = json.loads((ROOT / 'scripts' / filename).read_text())
        files = []
        for item in spec[key]:
            if name == 'zipformer' and item['path'] not in ['encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt']:
                continue
            url = f"{spec['source']}/resolve/{spec['revision']}/{item['path']}"
            directory = {'reazon': 'reazon-ja-en', 'whisper': 'whisper/' + spec['revision'], 'zipformer': 'zipformer-en'}[name]
            data = verified(ROOT / '.cache' / directory / item['path'], url, item['sha256'])
            files.append(entry(item['path'], data))
        write(name, dict(id=spec['source'].removeprefix('https://huggingface.co/'), revision=spec['revision'], files=files))
    # Legacy real-inference tests also use these pinned developer-only fixtures.
    zipformer = json.loads((ROOT / 'scripts/zipformer-assets.json').read_text())
    for item in zipformer['files']:
        if item['path'].startswith('test_wavs/'):
            verified(ROOT / '.cache/zipformer-en' / item['path'],
                     f"{zipformer['source']}/resolve/{zipformer['revision']}/{item['path']}", item['sha256'])
    # Preserve the exact Silero binary used by the former preload image.
    digest = '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
    # Immutable CORS-enabled mirror; exact original sherpa binary, not a new model.
    url = 'https://huggingface.co/mobilebytesensei/betterflow-silero-vad/resolve/0ae41137f2cd00de5e8a286fe01bdd5e3644f2da/silero_vad.onnx'
    data = verified(ROOT / '.cache/silero/silero_vad.onnx', url, digest)
    write('silero', dict(id='sherpa-onnx/silero-vad', revision=digest,
        files=[entry('silero_vad.onnx', data, sourceURL=url)]))
    url = 'https://cdn.jsdelivr.net/npm/kokoro-js-jp@0.2.0/dist/openjtalk-voice.htsvoice'
    # This voice is a statistical model even though Kokoro only calls its frontend.
    archive = ROOT / '.cache/tts-kokoro-js-jp-0.2.0.tgz'
    digest = '16223a8fae6ae58f84b62ba457463a8369dd84e9f01050be3287b6833096f59e'
    data = verified(archive, 'https://registry.npmjs.org/kokoro-js-jp/-/kokoro-js-jp-0.2.0.tgz', digest)
    with tarfile.open(fileobj=io.BytesIO(data)) as package:
        voice = package.extractfile('package/dist/openjtalk-voice.htsvoice').read()
    write('kokoro-japanese', dict(id='kokoro-japanese/frontend', revision=digest,
        files=[entry('openjtalk-voice.htsvoice', voice, sourceURL=url)]))
    voicepath = ROOT / '.cache/kokoro-japanese/openjtalk-voice.htsvoice'
    voicepath.parent.mkdir(parents=True, exist_ok=True); voicepath.write_bytes(voice)


if __name__ == '__main__':
    main()
