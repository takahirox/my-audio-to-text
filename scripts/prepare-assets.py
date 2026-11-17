#!/usr/bin/env python3
"""Stage weight-free shared model cache readers and pinned manifests."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name('prepare-model-cache.py')), run_name='__main__')
