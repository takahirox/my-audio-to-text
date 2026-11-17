#!/usr/bin/env python3
"""Stage every standalone page's pinned runtime/manifest, never model weights."""
from pathlib import Path
import runpy
import shutil

ROOT = Path(__file__).resolve().parents[1]


def main():
    shutil.rmtree(ROOT / 'web/vendor', ignore_errors=True)
    for name in ['assets', 'translation-assets', 'tts-assets', 'correction-assets',
                 'optional-asr-assets',
                 'text-summary-assets', 'plamo-assets']:
        runpy.run_path(str(ROOT / 'scripts' / f'prepare-{name}.py'), run_name='__main__')


if __name__ == '__main__':
    main()
