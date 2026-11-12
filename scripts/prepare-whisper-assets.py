#!/usr/bin/env python3
"""Whisper uses the shared translation runtime; no build-time model download.

Its immutable model manifest is extension/whisper-assets.json. Use Models or
save a Whisper graph to prepare weights. Maintainers can reproduce integrity
metadata with scripts/review-local-asr-assets.py.
"""
if __name__ == '__main__':
    print('Whisper weights are prepared on demand. Runtime: npm run prepare:translation-assets.')
