#!/usr/bin/env python3
"""Share the verified asset-only modules with the web/ Playground artifact."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
FILES = ['model-asset-cache.js', 'plamo-cache.js', 'plamo-assets.json', 'japanese-frontend-cache.js', 'optional-asr-cache.js',
         'kokoro-japanese-assets.json',
         'moonshine-small-ja-assets.json', 'moonshine-medium-en-assets.json',
         'if-condition-assets.json', 'meeting-summary-lfm2-assets.json',
         'meeting-summary-qwen35-assets.json', 'qwen3-tts-cache.js',
         'qwen3-tts-assets.json', 'cosyvoice3-cache.js', 'cosyvoice3-assets.json']


def main():
    target = ROOT / 'web/vendor/model-cache'
    if target.exists(): shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        text = (ROOT / 'extension' / name).read_text().replace('../web/', '../../')
        (target / name).write_text(text)


if __name__ == '__main__':
    main()
