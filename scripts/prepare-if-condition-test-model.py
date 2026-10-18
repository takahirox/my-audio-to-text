#!/usr/bin/env python3
"""Prepare the real smoke's model fixture, never bundle weights or run inference.

Production downloads these same immutable files through Save graph. This helper
verifies the committed 1 MiB chunk digests and stages a loopback smoke source.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'MoritzLaurer/xtremedistil-l6-h256-zeroshot-v1.1-all-33'
REVISION = 'c07f66d9cbf781191bee66edfe8ad7856f045781'


def main():
    entries = json.loads((ROOT / 'extension/if-condition-assets.json').read_text())
    for entry in entries:
        target = ROOT / '.cache/if-condition' / REVISION / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            print(f"Downloading IfCondition smoke asset: {entry['path']}", flush=True)
            with urllib.request.urlopen(f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{entry['path']}", timeout=180) as response:
                target.write_bytes(response.read())
        data = target.read_bytes()
        hashes = [hashlib.sha256(data[i:i+1048576]).hexdigest() for i in range(0,len(data),1048576)]
        if len(data) != entry['bytes'] or hashes != entry['sha256Chunks']:
            raise SystemExit(f"Invalid IfCondition smoke asset: {target}; remove it and prepare again.")
    print(f"Verified IfCondition smoke model: {sum(e['bytes'] for e in entries):,} bytes")


if __name__ == '__main__':
    main()
