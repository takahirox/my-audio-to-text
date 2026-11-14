#!/usr/bin/env python3
"""Share the verified asset-only modules with the web/ Playground artifact."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ['model-asset-cache.js', 'local-asr-cache.js', 'optional-asr-cache.js',
         'opus-mt-cache.js', 'opus-mt-manifest.js', 'opus-mt-assets.json',
         'reazon-assets.json', 'silero-assets.json', 'whisper-assets.json',
         'zipformer-assets.json', 'kokoro-japanese-assets.json',
         'parakeet-v3-assets.json', 'moonshine-medium-en-assets.json',
         'if-condition-assets.json', 'meeting-summary-lfm2-assets.json',
         'meeting-summary-qwen35-assets.json', 'qwen3-tts-cache.js',
         'qwen3-tts-assets.json', 'cosyvoice3-cache.js', 'cosyvoice3-assets.json']


def main():
    target = ROOT / 'web/vendor/model-cache'
    target.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        text = (ROOT / 'extension' / name).read_text().replace('../web/', '../../')
        (target / name).write_text(text)


if __name__ == '__main__':
    main()
