#!/usr/bin/env python3
"""Cache pinned upstream speech fixtures; never stage evaluation audio on Pages."""
import importlib.util
import json
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("prepare_assets", SCRIPT / "prepare-assets.py")
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)

if __name__ == "__main__":
    specification = json.loads((SCRIPT / "reazon-ja-en-assets.json").read_text())
    for fixture in specification["fixtures"]:
        assets.download_verified_bilingual(fixture, specification)
        print(f"Verified {fixture['name']}: {fixture['sha256']}")
