#!/usr/bin/env python3
"""Stage the pinned Japanese ReazonSpeech/Silero WASM distribution."""
import hashlib
import io
import json
import shutil
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = "sherpa.tar.bz2"
URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-wasm-simd-1.13.2-vad-asr-ja-zipformer_reazonspeech.tar.bz2"
SHA256 = "49c26de5550b2e1fec3e322b1fa909331ff027a4c0c76954f6d793102a4f4204"


def main():
    cache = ROOT / ".cache"
    cache.mkdir(exist_ok=True)
    archive = cache / ARCHIVE
    if not archive.exists():
        print(f"Downloading sherpa: {URL}", flush=True)
        with urllib.request.urlopen(URL, timeout=120) as response:
            archive.write_bytes(response.read())
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError(f"Checksum mismatch: {archive}; remove it before retrying")
    # Rebuild generated assets so reusing an old checkout cannot deploy
    # distributions left behind by removed experiments.
    vendor = ROOT / "web" / "vendor"
    if vendor.exists():
        shutil.rmtree(vendor)
    target = vendor / "sherpa"
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as package:
        for member in package.getmembers():
            path = Path(member.name)
            if not member.isfile():
                continue
            # Only stage runtime files; keep upstream names and relative imports.
            if path.name not in {"sherpa-onnx-asr.js", "sherpa-onnx-vad.js", "sherpa-onnx-wasm-main-vad-asr.js",
                                 "sherpa-onnx-wasm-main-vad-asr.wasm", "sherpa-onnx-wasm-main-vad-asr.data"}:
                continue
            relative = Path(path.name)
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError("Unsafe archive path")
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            content = package.extractfile(member).read()
            if path.name == "sherpa-onnx-vad.js":
                # Both upstream wrappers define freeConfig globally. Isolate VAD's
                # helpers so ASR configuration cleanup keeps its original function.
                content = b"(function () {\n" + content + b"\nself.createVad = createVad;\n})();\n"
            destination.write_bytes(content)
    size = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
    print(f"Staged sherpa: {size / 1_000_000:.1f} MB", flush=True)
    manifest = {"sherpa": {"source": URL, "sha256": SHA256, "bytes": size}}
    (ROOT / "web" / "vendor" / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
