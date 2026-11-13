import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseHTML } from 'linkedom';
import { modelPages } from './browser/model-playground-fixture.js';
import { releaseResources } from '../web/nodes/page-resources.js';

test('page cleanup releases every peer immediately even when another release fails', async () => {
  const released = [];
  const done = releaseResources(
    { dispose() { released.push('worker'); throw Error('worker failure'); } },
    { dispose() { released.push('audio'); return Promise.reject(Error('audio failure')); } },
    { dispose() { released.push('remaining worker'); } },
  );
  assert.deepEqual(released, ['worker', 'audio', 'remaining worker']);
  assert.match((await done).message, /worker failure; audio failure/);
});

test('static primary model navigation is exhaustive and preserves direct/return links', () => {
  const { document } = parseHTML(readFileSync('web/index.html', 'utf8'));
  assert.equal(document.querySelectorAll('section').length, 4);
  assert.deepEqual([...document.querySelectorAll('section a')].map(a => a.getAttribute('href')).sort(), modelPages.map(slug => `./nodes/${slug}/`).sort());
  assert.equal(document.querySelectorAll('script, button').length, 0);
  const catalog = readFileSync('extension/model-cache.js', 'utf8').split('const definitions = [')[1].split('class ModelCard')[0];
  const aliases = { reazon: 'speech-to-text', 'moonshine-medium-en': 'moonshine-medium', 'meeting-summary-lfm2': 'text-summary-lfm2',
    'meeting-summary-qwen35': 'text-summary-qwen35', 'opus-ja-en': 'opus-mt', 'opus-en-ja': 'opus-mt-en-ja' };
  const primary = [...catalog.matchAll(/\{ id: '([\w-]+)'/g)].map(match => match[1])
    .filter(id => !['silero', 'kokoro-japanese'].includes(id)).map(id => aliases[id] || id);
  assert.deepEqual(primary.sort(), [...modelPages].sort(), 'Every current catalog entry has its own test');
  for (const slug of modelPages) {
    const { document: page } = parseHTML(readFileSync(`web/nodes/${slug}/index.html`, 'utf8'));
    assert.ok(page.querySelector('a[href="../../"]'), slug);
    assert.ok(page.querySelector('script[type="module"][src="./app.js"]'), slug);
  }
});

test('web preparation copies production manifests verbatim and publishes no model weights', () => {
  // Exercise staging against a temporary artifact so this check needs no vendor
  // download and cannot alter a concurrently running browser/extension build.
  const result = spawnSync('python3', ['-c', `
import importlib.util, pathlib, tempfile, shutil
spec = importlib.util.spec_from_file_location('prepare', 'scripts/prepare-model-cache.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
source = pathlib.Path.cwd()
with tempfile.TemporaryDirectory() as d:
    root = pathlib.Path(d); (root/'extension').mkdir()
    for name in m.FILES: shutil.copy2(source/'extension'/name, root/'extension'/name)
    m.ROOT = root; m.main()
    target = root/'web/vendor/model-cache'
    assert {p.name for p in target.iterdir()} == set(m.FILES)
    for p in target.glob('*.json'): assert p.read_bytes() == (source/'extension'/p.name).read_bytes()
    assert not any(p.suffix in {'.onnx','.data','.bin','.ort'} for p in target.rglob('*'))
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('deployment stages all required runtimes and extension packaging includes its origin selector', () => {
  const prepare = readFileSync('scripts/prepare-playground-assets.py', 'utf8');
  for (const runtime of ['assets', 'translation-assets', 'tts-assets', 'correction-assets', 'whisper-assets', 'zipformer-assets', 'optional-asr-assets', 'text-summary-assets']) assert.ok(prepare.includes(`'${runtime}'`));
  assert.match(readFileSync('.github/workflows/pages.yml', 'utf8'), /npm ci[\s\S]*npm run prepare:playground-assets/);
  assert.match(readFileSync('scripts/build-extension.py', 'utf8'), /"optional-model-assets.js"/);
});
