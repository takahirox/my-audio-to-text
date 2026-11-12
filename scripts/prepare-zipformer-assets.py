#!/usr/bin/env python3
"""Prepare the pinned, weight-free online Zipformer runtime. No model downloads."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    spec = importlib.util.spec_from_file_location('runtime', ROOT / 'scripts/sherpa-runtime.py')
    runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
    runtime.stage(ROOT, 'zipformer-en')


if __name__ == '__main__':
    main()
