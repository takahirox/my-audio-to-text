#!/usr/bin/env python3
"""Stage a pinned, weight-free Wllama runtime with static CSP-safe workers."""
import ast
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://registry.npmjs.org/@wllama/wllama/-/wllama-3.13.0.tgz'
SHA256 = 'a9eaac205ff9a1d6fdbea395a48652bd5febc56511a7b66b736d862bf726d2d5'


def stage():
    archive = ROOT / '.cache/plamo-review/wllama.tgz'
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        archive.write_bytes(urllib.request.urlopen(URL, timeout=120).read())
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError('Wllama archive checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(data)) as package:
        source = package.extractfile('package/esm/index.js').read().decode()
        wasm = package.extractfile('package/esm/wasm/wllama.wasm').read()
        license_text = package.extractfile('package/LICENCE').read()
    def literal(name):
        match = re.search(r'var ' + name + r' = (.*);\n', source)
        return ast.literal_eval(match.group(1))
    glue = literal('WLLAMA_EMSCRIPTEN_CODE')
    protocol = literal('LLAMA_CPP_WORKER_CODE')
    stub = re.search(r'var JSPI_STUB = `([\s\S]*?)`;', source).group(1)
    # Fixed single-thread CPU WASM. No runtime-generated executable text, Blob
    # worker URL, CDN loader, or relaxed MV3 CSP. The ABI/glue are unmodified.
    worker = ('const RUN_OPTIONS = {pathConfig: {"wllama.wasm": '
              'new URL("./wllama.wasm", import.meta.url).href}, nbThread: 0, compat: false};\n'
              'function wModuleInit() {\n' + stub +
              'try { Object.defineProperty(WorkerNavigator.prototype, "gpu", '
              '{get: () => ({requestAdapter: async () => null})}); } catch {}\n' +
              glue.replace('var Module', 'var ___Module', 1) +
              '\nreturn Module;\n}\n' + protocol)
    start = source.index('      let moduleCode = JSPI_STUB + (yield this.getModuleCode());')
    end = source.index('      this.worker.onmessage =', start)
    source = source[:start] + ('      const moduleCode = "";\n'
                              '      this.worker = new Worker(new URL("./wllama-worker.js", import.meta.url), {type: "module"});\n') + source[end:]
    old = '      this.worker.onerror = this.logger.error;'
    assert source.count(old) == 1
    source = source.replace(old, '      this.worker.onerror = this.worker.onmessageerror = event => this.abort(event.message || "PLaMo WASM Worker failed", "");')
    target = ROOT / 'web/vendor/plamo'
    target.mkdir(parents=True, exist_ok=True)
    files = {'wllama.js': source.encode(), 'wllama-worker.js': worker.encode(),
             'wllama.wasm': wasm, 'LICENSE': license_text}
    for name, content in files.items():
        (target / name).write_bytes(content)
    # Stage the shared browser cache implementation under the same layout used
    # by the other standalone model pages. Never copy weights.
    cache = ROOT / 'web/vendor/model-cache'
    cache.mkdir(parents=True, exist_ok=True)
    for name in ['model-asset-cache.js', 'model-asset-worker.js', 'plamo-cache.js', 'plamo-assets.json']:
        content = (ROOT / 'extension' / name).read_text().replace('../web/plamo-policy.js', '../../plamo-policy.js')
        (cache / name).write_text(content)
    return [dict(path='vendor/plamo/' + name, bytes=len(content),
                 sha256=hashlib.sha256(content).hexdigest()) for name, content in files.items()]


if __name__ == '__main__':
    print(json.dumps(stage(), indent=2))
