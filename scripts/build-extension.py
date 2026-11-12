#!/usr/bin/env python3
"""Package the extension with the shared pipeline and weight-free runtimes."""
from pathlib import Path
import hashlib
import re
import json
import shutil

ROOT = Path(__file__).resolve().parent.parent
SHARED_FILES = (
    "optional-asr-core.js", "optional-asr-node.js", "parakeet-v3-node.js", "parakeet-v3-worker.js", "parakeet-v3-segments.js",
    "moonshine-medium-node.js", "moonshine-medium-worker.js", "moonshine-medium-stream.js",
    "zipformer-node.js", "zipformer-worker.js", "zipformer-core.js", "zipformer-segments.js", "zipformer-config.js",
    "whisper-node.js", "whisper-worker.js", "whisper-config.js", "text-constant-node.js",
    "text-summary-models.js", "text-summary-node.js", "text-summary-policy.js", "text-summary-worker.js", "gpu-lifecycle.js",
    "if-condition-model.js", "if-condition-node.js", "if-condition-policy.js", "if-condition-worker.js",
    "text-sliding-window-node.js", "text-window-node.js", "keyed-text-coalesce-node.js", "keyed-text-pair-node.js", "paired-text.js", "keyed-paired-text-accumulator-node.js", "display-node.js", "hold-node.js", "button-node.js", "pipeline.js", "port-contracts.js", "text-nodes.js", "number-node.js", "transcription-nodes.js",
    "tts-nodes.js", "tts-worker.js", "synthesized-audio.js", "speaker-output.js", "supertonic3-worker.js", "supertonic3-runtime.js",
    "audio-stream.js", "qwen3-tts-node.js", "qwen3-tts-worker.js", "qwen3-tts-runtime.js",
    "streaming-tts-node.js", "cosyvoice3-node.js", "cosyvoice3-worker.js", "cosyvoice3-runtime.js", "cosyvoice3-onnx.js",
    "kokoro-worker.js", "kokoro-english.js", "kokoro-japanese.js", "kokoro-hepburn.js",
    "translation-nodes.js", "translation-models.js", "translation-worker.js", "opus-mt-worker.js", "opus-mt-en-ja-worker.js", "translategemma-worker.js", "translategemma-context.js",
    "local-model-assets.js", "audio.js", "capture-worklet.js", "local-asr-core.js", "local-asr-config.js",
    "reazon-simulation.js", "reazon-config.js", "sherpa-worker.js", "silero-worker.js",
    "third-party-notices.txt",
)


FORBIDDEN_SUFFIXES = {'.onnx', '.data', '.bin', '.safetensors', '.pt', '.pth', '.tflite', '.htsvoice', '.npz', '.npy', '.gguf', '.ggml', '.ckpt', '.pb', '.model', '.weights'}


def inventory(target):
    """Inventory the completed artifact and reject model files/preload images."""
    entries = []
    for path in sorted(target.rglob('*')):
        if not path.is_file():
            continue
        relative = str(path.relative_to(target))
        if path.suffix.lower() in FORBIDDEN_SUFFIXES or re.search(r'\.onnx_data(?:_\d+)?$', path.name.lower()):
            raise RuntimeError('Model data in extension artifact: ' + relative)
        data = path.read_bytes()
        if path.suffix in {'.js', '.mjs'} and re.search(rb'''\bloadPackage\s*\(\s*\{\s*["']?files["']?\s*:''', data):
            raise RuntimeError('Automatic model preload in runtime: ' + relative)
        entries.append(dict(path=relative, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    return entries


def main():
    # No weight or model-cache directory is a build input. Copy only reviewed,
    # hash-pinned runtime files, even when a developer has old models in vendor.
    runtime = json.loads((ROOT / 'scripts/extension-runtime-assets.json').read_text())
    for entry in runtime['files']:
        asset = ROOT / 'web' / entry['path']
        if (not asset.is_file() or asset.stat().st_size != entry['bytes']
                or hashlib.sha256(asset.read_bytes()).hexdigest() != entry['sha256']):
            raise SystemExit('Missing or invalid weight-free runtime: ' + entry['path'] + '. Run npm run setup:extension.')
    target = ROOT / 'dist/chrome-extension'
    if target.exists():
        shutil.rmtree(target)
    (target / 'web').mkdir(parents=True)
    shutil.copytree(ROOT / 'extension', target / 'extension', ignore=shutil.ignore_patterns('cache-demo*'))
    shutil.copy2(ROOT / 'extension/manifest.json', target / 'manifest.json')
    for name in SHARED_FILES:
        shutil.copy2(ROOT / 'web' / name, target / 'web' / name)
    shutil.copytree(ROOT / 'web/licenses', target / 'web/licenses')
    for entry in runtime['files']:
        destination = target / 'web' / entry['path']
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'web' / entry['path'], destination)
    entries = inventory(target)
    (target / 'asset-inventory.json').write_text(json.dumps({
        'modelWeights': 0, 'files': entries,
    }, indent=2) + '\n')
    print(f'Verified {len(entries)} packaged files; no model weights. Load unpacked: {target}')


if __name__ == '__main__':
    main()
