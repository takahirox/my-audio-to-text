#!/usr/bin/env python3
"""Stage pinned upstream WASM distributions, without committing model weights."""
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
# The v0.1.5 release WASM supports split-frontend Japanese streaming models.
# The npm 0.1.5 archive contains an older binary despite the identical version.
ASSETS = [
    ("moonshine-v0.1.5-release.tar.gz", "https://github.com/moonshine-ai/moonshine/releases/download/v0.1.5/moonshine-voice-wasm.tar.gz",
     "c515bf7691e12048f70a92cc82b3b0894c16c3773ffcacb7d48944fb150e4837", "moonshine"),
    ("sherpa.tar.bz2", "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-wasm-simd-1.13.2-vad-asr-ja-zipformer_reazonspeech.tar.bz2",
     "49c26de5550b2e1fec3e322b1fa909331ff027a4c0c76954f6d793102a4f4204", "sherpa"),
]


def download_verified_bilingual(entry, specification):
    target = ROOT / ".cache" / "reazon-ja-en" / entry["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        url = f'{specification["source"]}/resolve/{specification["revision"]}/{entry["path"]}'
        print(f"Downloading ReazonSpeech ja-en: {entry['path']}", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            content = response.read()
        # Never retain an incomplete/unverified new download in the cache.
        if hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise RuntimeError(f"Checksum mismatch: {url}")
        target.write_bytes(content)
    content = target.read_bytes()
    if hashlib.sha256(content).hexdigest() != entry["sha256"]:
        raise RuntimeError(f"Checksum mismatch: {target}; remove it before retrying")
    return content


def prepare_bilingual():
    specification = json.loads((ROOT / "scripts" / "reazon-ja-en-assets.json").read_text())
    replacements = {entry["virtualPath"]: download_verified_bilingual(entry, specification)
                    for entry in specification["models"]}
    source = ROOT / "web" / "vendor" / "sherpa"
    target = ROOT / "web" / "vendor" / "sherpa-ja-en"
    target.mkdir(parents=True, exist_ok=True)
    stem = "sherpa-onnx-wasm-main-vad-asr"
    script = (source / f"{stem}.js").read_text()
    # Repackage only Emscripten's preloaded-file table and data. The recognizer
    # wrapper, WASM binary and all runtime code remain the pinned 1.13.2 release.
    pattern = r'loadPackage\(\{files:\[.*?\],remote_package_size:\d+\}\)'
    matches = list(re.finditer(pattern, script))
    if len(matches) != 1:
        raise RuntimeError("Unexpected pinned sherpa preload table")
    files = re.findall(r'\{filename:"([^"]+)",start:(\d+),end:(\d+)\}', matches[0].group())
    if {name for name, _, _ in files} != set(replacements) | {"/silero_vad.onnx"}:
        raise RuntimeError("Unexpected pinned sherpa preloaded files")
    original = (source / f"{stem}.data").read_bytes()
    offset, metadata = 0, []
    with (target / f"{stem}.data").open("wb") as output:
        for name, start, end in files:
            content = replacements[name] if name in replacements else original[int(start):int(end)]
            output.write(content)
            metadata.append({"filename": name, "start": offset, "end": offset + len(content)})
            offset += len(content)
    table = json.dumps({"files": metadata, "remote_package_size": offset}, separators=(",", ":"))
    patched = script[:matches[0].start()] + f"loadPackage({table})" + script[matches[0].end():]
    (target / f"{stem}.js").write_text(patched)
    for name in [f"{stem}.wasm", "sherpa-onnx-asr.js"]:
        shutil.copyfile(source / name, target / name)
    size = sum(p.stat().st_size for p in target.iterdir() if p.is_file())
    print(f"Staged sherpa-ja-en: {size / 1_000_000:.1f} MB", flush=True)
    return {"source": specification["source"], "revision": specification["revision"],
            "models": specification["models"], "runtime": "sherpa (1.13.2)",
            "sha256": hashlib.sha256((target / f"{stem}.data").read_bytes()).hexdigest(), "bytes": size}


def main():
    cache = ROOT / ".cache"
    cache.mkdir(exist_ok=True)
    for filename, url, digest, name in ASSETS:
        archive = cache / filename
        if not archive.exists():
            print(f"Downloading {name}: {url}", flush=True)
            with urllib.request.urlopen(url, timeout=120) as response:
                archive.write_bytes(response.read())
        data = archive.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError(f"Checksum mismatch: {archive}; remove it before retrying")
        target = ROOT / "web" / "vendor" / name
        target.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data)) as package:
            for member in package.getmembers():
                path = Path(member.name)
                if not member.isfile():
                    continue
                # Only stage runtime files; keep upstream names and relative imports.
                if name == "moonshine":
                    if path.parts[:1] != ("dist",):
                        continue
                    relative = Path(*path.parts[1:])
                else:
                    if path.name not in {"sherpa-onnx-asr.js", "sherpa-onnx-vad.js", "sherpa-onnx-wasm-main-vad-asr.js",
                                         "sherpa-onnx-wasm-main-vad-asr.wasm", "sherpa-onnx-wasm-main-vad-asr.data"}:
                        continue
                    relative = Path(path.name)
                if relative.is_absolute() or ".." in relative.parts:
                    raise RuntimeError("Unsafe archive path")
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                content = package.extractfile(member).read()
                if name == "sherpa" and path.name == "sherpa-onnx-vad.js":
                    # Both upstream wrappers define freeConfig globally. Isolate VAD's
                    # helpers so ASR configuration cleanup keeps its original function.
                    content = b"(function () {\n" + content + b"\nself.createVad = createVad;\n})();\n"
                destination.write_bytes(content)
        size = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
        print(f"Staged {name}: {size / 1_000_000:.1f} MB", flush=True)
    manifest = {
        name: {"source": url, "sha256": digest,
               "bytes": sum(p.stat().st_size for p in (ROOT / "web" / "vendor" / name).rglob("*") if p.is_file())}
        for _, url, digest, name in ASSETS
    }
    manifest["sherpa-ja-en"] = prepare_bilingual()
    (ROOT / "web" / "vendor" / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
