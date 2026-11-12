"""Stage the reviewed weight-free sherpa package without network access."""
import hashlib
import io
from pathlib import Path
import shutil
import tarfile

ROOT = Path(__file__).resolve().parents[1]
SHA256 = '36f841a3934d9859d66af11d262d5424d7db4804a5633319805a1e9677901931'
FAMILIES = {
    'sherpa-ja-en': {'sherpa-onnx-asr.js', 'sherpa-onnx-vad.js',
                     'sherpa-onnx-wasm-main-vad-asr.js', 'sherpa-onnx-wasm-main-vad-asr.wasm'},
    'zipformer-en': {'sherpa-onnx-asr.js', 'sherpa-onnx-wasm-main-asr.js', 'sherpa-onnx-wasm-main-asr.wasm'},
}


def stage(root, family):
    data = (root / 'scripts/sherpa-runtime.tar.gz').read_bytes()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError('Weight-free sherpa runtime checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(data)) as package:
        expected = {f'{key}/{name}' for key, names in FAMILIES.items() for name in names}
        members = package.getmembers()
        if len(members) != len(expected) or {m.name for m in members} != expected or not all(m.isfile() for m in members):
            raise RuntimeError('Unexpected weight-free runtime inventory')
        files = {name: package.extractfile(f'{family}/{name}').read() for name in FAMILIES[family]}
    target = root / 'web/vendor' / family
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (target / name).write_bytes(content)
    print(f'Staged weight-free {family} runtime: {sum(map(len, files.values())):,} bytes')
