#!/usr/bin/env python3
"""Prepare pinned, weight-free ReazonSpeech/Silero runtimes. No network/model downloads."""
import importlib.util
from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[1]


def main():
    spec = importlib.util.spec_from_file_location('runtime', ROOT / 'scripts/sherpa-runtime.py')
    runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
    runtime.stage(ROOT, 'sherpa-ja-en')
    runpy.run_path(str(ROOT / 'scripts/prepare-model-cache.py'), run_name='__main__')


if __name__ == '__main__':
    main()
