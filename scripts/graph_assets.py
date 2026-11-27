#!/usr/bin/env python3
"""Shared graph resources and pinned runtime verification for packaged hosts."""
from pathlib import Path
import hashlib
import re
import json
import shutil

ROOT = Path(__file__).resolve().parent.parent
SHARED_FILES = (
    "plamo-policy.js", "plamo-worker.js", "plamo-chat-template.jinja",
    "optional-model-assets.js",
    "optional-asr-core.js", "optional-asr-node.js", "moonshine-worker.js", "moonshine-small-ja-node.js", "moonshine-small-ja-worker.js", "moonshine-medium-node.js", "moonshine-medium-worker.js", "moonshine-stream.js",
    "text-constant-node.js", "floating-display-node.js",
    "text-summary-models.js", "text-summary-node.js", "text-summary-policy.js", "text-summary-worker.js", "gpu-lifecycle.js",
    "if-condition-model.js", "if-condition-node.js", "if-condition-policy.js", "if-condition-worker.js",
    "text-sliding-window-node.js", "text-window-node.js", "keyed-text-coalesce-node.js", "keyed-text-pair-node.js", "paired-text.js", "keyed-paired-text-accumulator-node.js", "display-node.js", "hold-node.js", "button-node.js", "pipeline.js", "port-contracts.js", "text-nodes.js", "number-node.js", "transcription-nodes.js",
    "tts-nodes.js", "tts-worker.js", "synthesized-audio.js", "speaker-output.js", "supertonic3-worker.js", "supertonic3-runtime.js",
    "audio-stream.js", "qwen3-tts-node.js", "qwen3-tts-worker.js", "qwen3-tts-runtime.js",
    "streaming-tts-node.js", "cosyvoice3-node.js", "cosyvoice3-worker.js", "cosyvoice3-runtime.js", "cosyvoice3-onnx.js",
    "kokoro-worker.js", "kokoro-english.js", "kokoro-japanese.js", "kokoro-hepburn.js",
    "translation-nodes.js", "translation-models.js", "translation-worker.js", "translategemma-worker.js", "translategemma-context.js", "translategemma-languages.js",
    "local-model-assets.js", "audio.js", "capture-worklet.js", "third-party-notices.txt",
)


FORBIDDEN_SUFFIXES = {'.ort', '.onnx', '.data', '.bin', '.safetensors', '.pt', '.pth', '.tflite', '.htsvoice', '.npz', '.npy', '.gguf', '.ggml', '.ckpt', '.pb', '.model', '.weights'}


def inventory(target):
    """Inventory the completed artifact and reject model files/preload images."""
    entries = []
    for path in sorted(target.rglob('*')):
        if not path.is_file():
            continue
        relative = str(path.relative_to(target))
        if path.suffix.lower() in FORBIDDEN_SUFFIXES or re.search(r'\.onnx_data(?:_\d+)?$', path.name.lower()):
            raise RuntimeError('Model data in artifact: ' + relative)
        data = path.read_bytes()
        if path.suffix in {'.js', '.mjs'} and re.search(rb'''\bloadPackage\s*\(\s*\{\s*["']?files["']?\s*:''', data):
            raise RuntimeError('Automatic model preload in runtime: ' + relative)
        entries.append(dict(path=relative, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    return entries


def copy_graph_resources(target, root=ROOT):
    runtime = json.loads((root / 'scripts/extension-runtime-assets.json').read_text())
    for entry in runtime['files']:
        asset = root / 'web' / entry['path']
        if (not asset.is_file() or asset.stat().st_size != entry['bytes']
                or hashlib.sha256(asset.read_bytes()).hexdigest() != entry['sha256']):
            raise SystemExit('Missing or invalid weight-free runtime: ' + entry['path'] + '. Run npm run prepare:graph-assets.')
    (target / 'web').mkdir(parents=True, exist_ok=True)
    for name in SHARED_FILES:
        shutil.copy2(root / 'web' / name, target / 'web' / name)
    shutil.copytree(ROOT / 'web/licenses', target / 'web/licenses')
    for entry in runtime['files']:
        destination = target / 'web' / entry['path']
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / 'web' / entry['path'], destination)
