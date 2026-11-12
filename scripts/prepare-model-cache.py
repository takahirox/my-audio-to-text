#!/usr/bin/env python3
"""Share the verified asset-only modules with the web/ Playground artifact."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ['model-asset-cache.js', 'local-asr-cache.js', 'optional-asr-cache.js',
         'opus-mt-cache.js', 'opus-mt-manifest.js', 'opus-mt-assets.json',
         'reazon-assets.json', 'silero-assets.json', 'whisper-assets.json',
         'zipformer-assets.json', 'kokoro-japanese-assets.json']


def main():
    target = ROOT / 'web/vendor/model-cache'
    target.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        text = (ROOT / 'extension' / name).read_text().replace('../web/', '../../')
        (target / name).write_text(text)


if __name__ == '__main__':
    main()
