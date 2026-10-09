#!/usr/bin/env python3
"""Package the extension with the shared pipeline and prepared local models."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
SHARED_FILES = (
    "pipeline.js", "transcription-nodes.js",
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
        # Runtime code is packaged; OPUS-MT/TTS weights are cached only on request.
        shutil.copytree(ROOT / "web" / name, target / "web" / name)
    print(f"Load unpacked: {target}")


if __name__ == "__main__":
    main()
