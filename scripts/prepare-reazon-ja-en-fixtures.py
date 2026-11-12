#!/usr/bin/env python3
"""Cache pinned upstream speech fixtures; never stage evaluation audio on Pages."""
import json
from pathlib import Path
import importlib.util

SCRIPT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('review', SCRIPT / 'review-local-asr-assets.py')
assets = importlib.util.module_from_spec(spec); spec.loader.exec_module(assets)

if __name__ == "__main__":
    specification = json.loads((SCRIPT / "reazon-ja-en-assets.json").read_text())
    for fixture in specification["fixtures"]:
        assets.verified(assets.ROOT / '.cache/reazon-ja-en' / fixture['path'],
                        f"{specification['source']}/resolve/{specification['revision']}/{fixture['path']}", fixture['sha256'])
        print(f"Verified {fixture['name']}: {fixture['sha256']}")
