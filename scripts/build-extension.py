#!/usr/bin/env python3
"""Package the extension with the shared pipeline and weight-free runtimes."""
from pathlib import Path
import json
import shutil

from graph_assets import copy_graph_resources, inventory

ROOT = Path(__file__).resolve().parent.parent


def main():
    # No weight or model-cache directory is a build input. Copy only reviewed,
    # hash-pinned runtime files, even when a developer has old models in vendor.
    target = ROOT / 'dist/chrome-extension'
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(ROOT / 'extension', target / 'extension', ignore=shutil.ignore_patterns('cache-demo*'))
    shutil.copy2(ROOT / 'extension/manifest.json', target / 'manifest.json')
    copy_graph_resources(target, ROOT)
    entries = inventory(target)
    (target / 'asset-inventory.json').write_text(json.dumps({
        'modelWeights': 0, 'files': entries,
    }, indent=2) + '\n')
    print(f'Verified {len(entries)} packaged files; no model weights. Load unpacked: {target}')


if __name__ == '__main__':
    main()
