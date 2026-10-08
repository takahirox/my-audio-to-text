#!/usr/bin/env python3
"""Stage checksum-pinned browser runtimes; model weights download only on Run."""
import hashlib
import io
import shutil
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = [
    ("transformers", "https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.0.0-next.3.tgz",
     "6a99fc26dc729bc3e94094e9ba77feea3b7597284647e3867f0469b702515d7b",
     {"dist/transformers.min.js": "transformers.js", "LICENSE": "transformers-LICENSE"}),
    ("onnxruntime-web", "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.25.0-dev.20260212-1a71a5f46e.tgz",
     "952de55d06889602ea46462025e0f2dacb4964e2180b37d59ff66f3ce1c68a75",
     {"dist/ort-wasm-simd-threaded.asyncify.mjs": "ort-wasm-simd-threaded.asyncify.mjs",
      "dist/ort-wasm-simd-threaded.asyncify.wasm": "ort-wasm-simd-threaded.asyncify.wasm"}),
]


def main():
    cache = ROOT / ".cache"
    cache.mkdir(exist_ok=True)
    files = {}
    for name, url, digest, members in PACKAGES:
        archive = cache / f"translation-{name}.tgz"
        if not archive.exists():
            with urllib.request.urlopen(url, timeout=120) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise RuntimeError(f"Checksum mismatch: {name}")
            archive.write_bytes(data)
        data = archive.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError(f"Checksum mismatch: {name}")
        with tarfile.open(fileobj=io.BytesIO(data)) as package:
            for source, target in members.items():
                files[target] = package.extractfile("package/" + source).read()
    target = ROOT / "web" / "vendor" / "translation"
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (target / name).write_bytes(data)
    print(f"Staged pinned translation runtime: {sum(map(len, files.values())):,} bytes")


if __name__ == "__main__":
    main()
