#!/usr/bin/env python3
"""Cache checksum-pinned Japanese speech for the browser threading benchmark."""
import hashlib
from pathlib import Path
import urllib.request

URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/ja.wav"
SHA256 = "780f95a86ba6cc33a4431fcafeacd213417dfa0a6613f93e4400c18f4dd467b0"
TARGET = Path(__file__).resolve().parent.parent / ".cache" / "reazon-ja.wav"


def main():
    TARGET.parent.mkdir(exist_ok=True)
    if not TARGET.exists():
        with urllib.request.urlopen(URL, timeout=120) as response:
            TARGET.write_bytes(response.read())
    if hashlib.sha256(TARGET.read_bytes()).hexdigest() != SHA256:
        raise RuntimeError(f"Checksum mismatch: {TARGET}; remove it before retrying")
    print(f"Verified Japanese benchmark audio: {SHA256}")


if __name__ == "__main__":
    main()
