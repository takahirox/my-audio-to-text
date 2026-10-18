#!/usr/bin/env python3
"""Package the extension with the shared pipeline and prepared local models."""
from pathlib import Path
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parent.parent
SHARED_FILES = (
    "optional-asr-core.js", "optional-asr-node.js", "parakeet-v3-node.js", "parakeet-v3-worker.js", "parakeet-v3-segments.js",
    "moonshine-medium-node.js", "moonshine-medium-worker.js", "moonshine-medium-stream.js",
    "zipformer-node.js", "zipformer-worker.js", "zipformer-core.js", "zipformer-segments.js", "zipformer-config.js",
    "whisper-node.js", "whisper-worker.js", "whisper-config.js", "text-constant-node.js",
    "if-condition-model.js", "if-condition-node.js", "if-condition-policy.js", "if-condition-worker.js",
    "pipeline.js", "port-contracts.js", "text-nodes.js", "number-node.js", "transcription-nodes.js",
    "tts-nodes.js", "tts-worker.js", "synthesized-audio.js", "supertonic3-worker.js", "supertonic3-runtime.js",
    "kokoro-worker.js", "kokoro-english.js", "kokoro-japanese.js", "kokoro-hepburn.js",
    "translation-nodes.js", "translation-models.js", "translation-worker.js", "opus-mt-worker.js", "opus-mt-en-ja-worker.js",
    "audio.js", "capture-worklet.js", "local-asr-core.js", "local-asr-config.js",
    "reazon-simulation.js", "reazon-config.js", "sherpa-worker.js", "silero-worker.js",
    "third-party-notices.txt",
)


def main():
    vendor = ROOT / "web" / "vendor"
    if not (vendor / "sherpa-ja-en" / "sherpa-onnx-wasm-main-vad-asr.data").is_file():
        raise SystemExit("Missing local models. Run npm run prepare:assets first.")
    if any(not (vendor / "translation" / name).is_file() for name in (
            "transformers.js", "ort-wasm-simd-threaded.asyncify.mjs",
            "ort-wasm-simd-threaded.asyncify.wasm", "transformers-LICENSE")):
        raise SystemExit("Missing translation runtime. Run npm run prepare:translation-assets after prepare:assets.")
    decision_runtime = json.loads((ROOT / "scripts/if-condition-runtime.json").read_text())
    for entry in decision_runtime["files"]:
        asset = vendor / "translation" / entry["path"]
        if not asset.is_file() or asset.stat().st_size != entry["bytes"] or hashlib.sha256(asset.read_bytes()).hexdigest() != entry["sha256"]:
            raise SystemExit("Invalid pinned IfCondition runtime. Run npm run prepare:translation-assets.")
    whisper = json.loads((ROOT / "scripts" / "whisper-assets.json").read_text())
    for entry in whisper["files"]:
        asset = vendor / "whisper" / "tiny" / entry["path"]
        if not asset.is_file() or asset.stat().st_size != entry["bytes"] or hashlib.sha256(asset.read_bytes()).hexdigest() != entry["sha256"]:
            raise SystemExit("Missing or invalid pinned Whisper model. Run npm run prepare:whisper-assets after prepare:assets.")
    specification = json.loads((ROOT / "scripts" / "zipformer-assets.json").read_text())
    manifest_path = vendor / "zipformer-en" / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit("Missing English Zipformer. Run npm run prepare:zipformer-assets after prepare:assets.")
    manifest = json.loads(manifest_path.read_text())
    if manifest["specification"] != specification:
        raise SystemExit("Outdated English Zipformer specification; prepare assets again.")
    if manifest["files"] != specification["bundle"]:
        raise SystemExit("English Zipformer bundle manifest differs from pinned checksums.")
    for entry in specification["bundle"]:
        asset = vendor / "zipformer-en" / entry["path"]
        if not asset.is_file() or asset.stat().st_size != entry["bytes"] or hashlib.sha256(asset.read_bytes()).hexdigest() != entry["sha256"]:
            raise SystemExit("Invalid pinned English Zipformer asset; prepare assets again.")
    optional = json.loads((ROOT / "scripts/optional-asr-runtime.json").read_text())
    for entry in optional["files"]:
        asset = vendor / "optional-asr" / entry["path"]
        if not asset.is_file() or hashlib.sha256(asset.read_bytes()).hexdigest() != entry["packagedSha256"]:
            raise SystemExit("Missing or invalid optional ASR runtime. Run npm run prepare:optional-asr-assets.")
    tts = ROOT / "web" / "tts-assets"
    if any(not (tts / name).is_file() for name in (
            "ort.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
            "transformers.js", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm",
            "phonemizer.js", "phonemizer-engine.mjs", "phonemizer-source.tar.gz",
            "openjtalk-wasm-wrapper-D6E3BSJO.js", "openjtalk-wasm.wasm",
            "open_jtalk_dic_utf_8-1.11.tar.gz", "openjtalk-voice.htsvoice")):
        raise SystemExit("Missing TTS runtime/frontend/source. Run npm run prepare:tts-assets.")
    target = ROOT / "dist" / "chrome-extension"
    if target.exists():
        shutil.rmtree(target)
    (target / "web").mkdir(parents=True)
    shutil.copytree(ROOT / "extension", target / "extension")
    shutil.copy2(ROOT / "extension" / "manifest.json", target / "manifest.json")
    for name in SHARED_FILES:
        shutil.copy2(ROOT / "web" / name, target / "web" / name)
    for name in ("vendor", "licenses", "tts-assets"):
        # Runtime code is packaged; OPUS-MT/TTS weights are cached after Save or explicit preparation.
        shutil.copytree(ROOT / "web" / name, target / "web" / name)
    print(f"Load unpacked: {target}")


if __name__ == "__main__":
    main()
