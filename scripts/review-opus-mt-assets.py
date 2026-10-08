#!/usr/bin/env python3
"""Explicit maintainer download to reproduce the reviewed OPUS-MT manifest.

Not part of extension build or installation. No weights are committed/bundled.
Compare the generated manifest diff before accepting a changed checkpoint.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REVISION = '05470cd69b62aa32e3ee64ccfd41279789ee4b1e'
FILES = ['config.json', 'generation_config.json', 'tokenizer_config.json',
         'tokenizer.json', 'special_tokens_map.json',
         'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']


def main():
    entries = []
    for name in FILES:
        path = ROOT / '.cache' / 'opus-mt' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            url = f'https://huggingface.co/onnx-community/opus-mt-ja-en/resolve/{REVISION}/{name}'
            with urllib.request.urlopen(url, timeout=300) as response, path.open('wb') as target:
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
        hashes, size = [], 0
        with path.open('rb') as source:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                hashes.append(hashlib.sha256(chunk).hexdigest())
        entries.append(dict(path=name, bytes=size, sha256Chunks=hashes))
    target = ROOT / 'extension' / 'opus-mt-assets.json'
    target.write_text(json.dumps(entries, indent=2) + '\n')
    print(f'Review {target}: {sum(entry["bytes"] for entry in entries):,} bytes')


if __name__ == '__main__':
    main()
