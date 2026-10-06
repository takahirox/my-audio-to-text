#!/usr/bin/env python3
"""Stage the pinned ReazonSpeech ja-en/Silero WASM distribution."""
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
# Use only the runtime and Silero from this release archive. Its ASR weights
# are discarded; no Japanese-only ReazonSpeech distribution is downloaded.
ARCHIVE = "sherpa-runtime.tar.bz2"
URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-wasm-simd-1.13.2-vad-asr-en-moonshine_tiny.tar.bz2"
SHA256 = "c388d09c952557f0aeaf7a3c796d20143a2bbed7cb0fe2eca656c26dc8beb444"
STEM = "sherpa-onnx-wasm-main-vad-asr"
RUNTIME_FILES = {"sherpa-onnx-asr.js", "sherpa-onnx-vad.js", f"{STEM}.js", f"{STEM}.wasm", f"{STEM}.data"}


def download_verified_bilingual(entry, specification):
    target = ROOT / ".cache" / "reazon-ja-en" / entry["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        url = f'{specification["source"]}/resolve/{specification["revision"]}/{entry["path"]}'
        print(f"Downloading ReazonSpeech ja-en: {entry['path']}", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise RuntimeError(f"Checksum mismatch: {url}")
        target.write_bytes(content)
    content = target.read_bytes()
    if hashlib.sha256(content).hexdigest() != entry["sha256"]:
        raise RuntimeError(f"Checksum mismatch: {target}; remove it before retrying")
    return content


def prepare_bundle(runtime, replacements):
    script = runtime[f"{STEM}.js"].decode()
    pattern = r'loadPackage\(\{files:\[.*?\],remote_package_size:\d+\}\)'
    matches = list(re.finditer(pattern, script))
    if len(matches) != 1:
        raise RuntimeError("Unexpected pinned sherpa preload table")
    files = re.findall(r'\{filename:"([^"]+)",start:(\d+),end:(\d+)\}', matches[0].group())
    silero = [(int(start), int(end)) for name, start, end in files if name == "/silero_vad.onnx"]
    original = runtime[f"{STEM}.data"]
    if len(silero) != 1 or not 0 <= silero[0][0] < silero[0][1] <= len(original):
        raise RuntimeError("Unexpected pinned Silero preload entry")
    replacements = {**replacements, "/silero_vad.onnx": original[silero[0][0]:silero[0][1]]}
    # Preserve #41's preload ordering and data identity. Discard all bootstrap
    # ASR weights and rewrite only the Emscripten preload table, as in #41.
    order = ["/silero_vad.onnx", "/tokens.txt", "/transducer-decoder.onnx",
             "/transducer-encoder.onnx", "/transducer-joiner.onnx"]
    if set(replacements) != set(order):
        raise RuntimeError("Unexpected ReazonSpeech ja-en model paths")
    offset, metadata, chunks = 0, [], []
    for name in order:
        content = replacements[name]
        chunks.append(content)
        metadata.append({"filename": name, "start": offset, "end": offset + len(content)})
        offset += len(content)
    table = json.dumps({"files": metadata, "remote_package_size": offset}, separators=(",", ":"))
    patched = script[:matches[0].start()] + f"loadPackage({table})" + script[matches[0].end():]
    return {
        **runtime, f"{STEM}.js": patched.encode(), f"{STEM}.data": b"".join(chunks),
        # Isolate VAD's helpers from ASR's global configuration cleanup helpers.
        "sherpa-onnx-vad.js": b"(function () {\n" + runtime["sherpa-onnx-vad.js"] + b"\nself.createVad = createVad;\n})();\n",
    }


def main():
    cache = ROOT / ".cache"
    cache.mkdir(exist_ok=True)
    archive = cache / ARCHIVE
    if not archive.exists():
        print(f"Downloading sherpa runtime: {URL}", flush=True)
        with urllib.request.urlopen(URL, timeout=120) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != SHA256:
            raise RuntimeError(f"Checksum mismatch: {URL}")
        archive.write_bytes(content)
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError(f"Checksum mismatch: {archive}; remove it before retrying")
    with tarfile.open(fileobj=io.BytesIO(data)) as package:
        runtime = {Path(member.name).name: package.extractfile(member).read()
                   for member in package.getmembers()
                   if member.isfile() and Path(member.name).name in RUNTIME_FILES}
    if set(runtime) != RUNTIME_FILES:
        raise RuntimeError("Missing pinned sherpa runtime files")
    specification = json.loads((ROOT / "scripts" / "reazon-ja-en-assets.json").read_text())
    replacements = {entry["virtualPath"]: download_verified_bilingual(entry, specification)
                    for entry in specification["models"]}
    bundle = prepare_bundle(runtime, replacements)
    # Verify everything before replacing generated assets from old checkouts.
    vendor = ROOT / "web" / "vendor"
    if vendor.exists():
        shutil.rmtree(vendor)
    target = vendor / "sherpa-ja-en"
    target.mkdir(parents=True)
    for name, content in bundle.items():
        (target / name).write_bytes(content)
    size = sum(len(content) for content in bundle.values())
    manifest = {"sherpa-ja-en": {
        "source": specification["source"], "revision": specification["revision"],
        "models": specification["models"], "runtime": {"source": URL, "sha256": SHA256},
        "sha256": hashlib.sha256(bundle[f"{STEM}.data"]).hexdigest(), "bytes": size,
    }}
    (vendor / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Staged ReazonSpeech ja-en/Silero: {size / 1_000_000:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
