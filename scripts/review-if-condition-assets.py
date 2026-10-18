#!/usr/bin/env python3
"""Reproduce the reviewed immutable IfCondition manifest; compare the diff.

Maintainer operation, not part of build, Save or recording. Downloads model data
only. The source checkpoint includes an ONNX export and declares an MIT license.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'MoritzLaurer/xtremedistil-l6-h256-zeroshot-v1.1-all-33'
REVISION = 'c07f66d9cbf781191bee66edfe8ad7856f045781'
FILES = ['config.json', 'tokenizer_config.json', 'tokenizer.json',
         'special_tokens_map.json', 'onnx/model_quantized.onnx']


def main():
    entries = []
    for name in FILES:
        path = ROOT / '.cache/if-condition' / REVISION / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            with urllib.request.urlopen(f'https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}', timeout=180) as response:
                path.write_bytes(response.read())
        data = path.read_bytes()
        entries.append(dict(path=name, bytes=len(data), sha256Chunks=[
            hashlib.sha256(data[i:i+1048576]).hexdigest() for i in range(0,len(data),1048576)]))
    target = ROOT / 'extension/if-condition-assets.json'
    target.write_text(json.dumps(entries, indent=2) + '\n')
    print(f'Review {target}: {sum(entry["bytes"] for entry in entries):,} bytes')


if __name__ == '__main__':
    main()
