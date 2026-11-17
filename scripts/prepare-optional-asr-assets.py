#!/usr/bin/env python3
"""Package pinned JS/WASM only. Optional ASR weights are prepared after Save."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / 'scripts/optional-asr-runtime.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    specification = json.loads(SPEC.read_text())
    target = ROOT / 'web/vendor/optional-asr'
    staging = target.with_name('optional-asr-staging')
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    spec = importlib.util.spec_from_file_location('moonshine_csp', ROOT/'scripts/moonshine-csp.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    archive = specification['archive']
    cached = ROOT / '.cache' / archive['cache']
    cached.parent.mkdir(exist_ok=True)
    if not cached.exists():
        partial = cached.with_suffix('.partial')
        try:
            subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--output', str(partial), archive['url']], check=True)
            if partial.stat().st_size != archive['bytes'] or digest(partial) != archive['sha256']:
                raise SystemExit('Moonshine runtime archive integrity mismatch')
            partial.replace(cached)
        finally:
            partial.unlink(missing_ok=True)
    if cached.stat().st_size != archive['bytes'] or digest(cached) != archive['sha256']:
        raise SystemExit('Invalid cached Moonshine runtime archive')
    package = tarfile.open(cached)
    for file in specification['files']:
        content = package.extractfile(file['source']).read()
        if len(content) != file['bytes'] or hashlib.sha256(content).hexdigest() != file['sha256']:
            raise SystemExit(f'Invalid Moonshine runtime member: {file["source"]}')
        if file['path'] == 'moonshine/moonshine.mjs':
            content = module.patch(content.decode()).encode()
        output = staging / file['path']
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)
        if hashlib.sha256(content).hexdigest() != file['packagedSha256']:
            raise SystemExit(f'Unexpected patched runtime: {file["path"]}')
    (staging/'manifest.json').write_text(json.dumps(specification, indent=2)+'\n')
    if target.exists():
        shutil.rmtree(target)
    staging.rename(target)
    print(f'Staged optional ASR runtimes only: {sum(p.stat().st_size for p in target.rglob("*") if p.is_file()):,} bytes')


if __name__ == '__main__':
    main()
