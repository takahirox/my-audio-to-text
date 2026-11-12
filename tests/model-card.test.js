import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';

const source = readFileSync(new URL('../extension/model-cache.js', import.meta.url), 'utf8');
const cardSource = source.slice(source.indexOf('class ModelCard {'), source.indexOf('for (const definition of definitions)'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const view = (state = 'Not downloaded', error = '') => ({ state, error,
  totalBytes: 20, downloadedBytes: state === 'Ready' ? 20 : 10, cachedBytes: state === 'Ready' ? 20 : 10,
  files: [{ path: 'shared.bin', cached: true }, { path: 'voice.bin', cached: state === 'Ready' }] });

function fixture(cache, manifest = async () => ({})) {
  const { document } = parseHTML('<html><body><main id="models"></main></body></html>');
  const messages = [];
  const ModelCard = runInNewContext(`
    const el = (tag, text) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; };
    const closed = false, cards = [], savedNodes = [];
    ${cardSource}
    ModelCard;
  `, { document, AbortController, ModelAssetCache: class { constructor() { return cache; } }, channel: { postMessage: message => messages.push(message) } });
  const card = new ModelCard({ id: 'test', title: 'Test model', manifest, terms: 'License', url: 'license.txt' });
  return { card, messages };
}

test('initial and subsequent inspections hide actions until verified, including partial caches', async () => {
  let pending = deferred();
  const { card } = fixture({ inspect: () => pending.promise });
  assert.equal(card.prepare.hidden, true);
  pending.resolve(view('Ready')); await tick();
  assert.equal(card.prepare.hidden, true);
  assert.equal(card.remove.disabled, false);
  assert.equal(card.status.textContent, 'Ready · Cached and verified');
  assert.equal(card.root.querySelectorAll('.actions button').length, 3);
  pending = deferred(); const inspection = card.inspect();
  assert.equal(card.prepare.hidden, true);
  pending.resolve(view()); await inspection;
  assert.equal(card.prepare.hidden, false);
  assert.equal(card.prepare.textContent, 'Download');
  assert.match(card.files.textContent, /shared.bin: Cached.*voice.bin: Missing/);
});

test('download hides its action, preserves progress and Cancel, and ignores duplicate preparation', async () => {
  const pending = deferred(); let preparations = 0;
  const cache = { inspect: async () => view(), prepare: async ({ onChange, signal }) => {
    preparations++; onChange(view('Downloading'));
    await pending.promise;
    return signal.aborted ? view('Error', 'Cancelled. Retry preparation.') : view('Ready');
  } };
  const { card, messages } = fixture(cache); await tick();
  const download = card.run('prepare'); await tick();
  assert.equal(card.prepare.hidden, true); assert.equal(card.cancel.hidden, false);
  assert.equal(card.progress.hidden, false); assert.equal(card.progress.value, 10);
  await card.run('prepare'); assert.equal(preparations, 1);
  assert.equal(messages.length, 1);
  card.cancel.onclick(); pending.resolve(); await download;
  assert.equal(card.prepare.textContent, 'Retry'); assert.equal(card.prepare.hidden, false);
  assert.equal(card.cancel.hidden, true); assert.match(card.error.textContent, /Cancelled/);
});

test('focus/update inspection during failure never masks the actionable Retry or its error', async () => {
  const pending = deferred(); let state = 'Not downloaded';
  const cache = { inspect: async () => view(state), prepare: async () => { await pending.promise; return view('Error', 'Corrupt asset. Retry preparation.'); } };
  const { card } = fixture(cache); await tick();
  const download = card.run('prepare'); await tick();
  await card.inspect(); pending.resolve(); await download; await tick();
  await card.inspect();
  assert.equal(card.prepare.hidden, false); assert.equal(card.prepare.textContent, 'Retry');
  assert.match(card.error.textContent, /Corrupt asset/);
  state = 'Ready'; await card.inspect();
  assert.equal(card.prepare.hidden, true); assert.equal(card.error.textContent, '');
});

test('delete re-inspects before showing Download and supports deliberate re-download', async () => {
  let state = 'Ready'; const pending = deferred(); let inspections = 0, downloads = 0;
  const cache = { inspect: async () => { if (++inspections > 1) await pending.promise; return view(state); },
    remove: async () => { state = 'Not downloaded'; return view(); },
    prepare: async () => { downloads++; return view('Ready'); } };
  const { card } = fixture(cache); await tick();
  const removal = card.run('remove'); await tick();
  assert.equal(card.root.dataset.state, 'Checking'); assert.equal(card.prepare.hidden, true);
  pending.resolve(); await removal;
  assert.equal(card.prepare.textContent, 'Download'); assert.equal(card.prepare.hidden, false);
  await card.run('prepare'); assert.equal(downloads, 1); assert.equal(card.prepare.hidden, true);
});

test('a concurrent consumer can restore Ready during deletion without flashing Download', async () => {
  const { card } = fixture({ inspect: async () => view('Ready'), remove: async () => view() });
  await tick(); await card.run('remove');
  assert.equal(card.root.dataset.state, 'Ready'); assert.equal(card.prepare.hidden, true);
});

test('voice changes discard outdated inspections and isolate recoverable failures', async () => {
  const { card } = fixture({ inspect: async () => view('Ready') }); await tick();
  card.voice = { value: 'A', disabled: false };
  const pending = deferred();
  card.caches.set('A', { inspect: () => pending.promise });
  card.caches.set('B', { inspect: async () => view() });
  const old = card.inspect(); await tick();
  card.voice.value = 'B'; const current = card.inspect();
  assert.equal(card.prepare.hidden, true); await current;
  pending.resolve(view('Ready')); await old;
  assert.equal(card.root.dataset.state, 'Not downloaded'); assert.equal(card.prepare.hidden, false);
  card.fail(new Error('B failed')); await card.inspect();
  assert.equal(card.prepare.textContent, 'Retry');
  card.voice.value = 'A'; await card.inspect();
  assert.equal(card.root.dataset.state, 'Ready'); assert.equal(card.prepare.hidden, true);
});

test('failed manifest loading can actually be retried instead of reusing a rejected promise', async () => {
  let attempts = 0;
  const { card } = fixture({ inspect: async () => view(), prepare: async () => view('Ready') }, async () => {
    if (++attempts === 1) throw new Error('Manifest temporarily unavailable'); return {};
  }); await tick();
  assert.equal(card.prepare.textContent, 'Retry'); assert.equal(card.prepare.hidden, false);
  await card.run('prepare');
  assert.equal(attempts, 2); assert.equal(card.root.dataset.state, 'Ready'); assert.equal(card.prepare.hidden, true);
});
