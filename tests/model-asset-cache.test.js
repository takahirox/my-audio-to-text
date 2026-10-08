import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME, HASH_CHUNK_BYTES,
  storagePersistence } from '../extension/model-asset-cache.js';

const digest = data => createHash('sha256').update(data).digest('hex');
const data = [Buffer.from('fixture configuration'), Buffer.from('fixture weights')];
function manifest({ id = 'test/model', revision = 'a'.repeat(40), contents = data } = {}) {
  return defineAssetSet({ id, revision, files: contents.map((bytes, i) => ({
    path: `file-${i}.bin`, bytes: bytes.length,
    sha256Chunks: Array.from({ length: Math.ceil(bytes.length / HASH_CHUNK_BYTES) }, (_, j) =>
      digest(bytes.subarray(j * HASH_CHUNK_BYTES, (j + 1) * HASH_CHUNK_BYTES))),
  })) });
}

// Stores only after consuming the complete stream, matching Cache.put atomicity.
function fixture(set = manifest(), contents = data) {
  const entries = new Map(), calls = [], events = [];
  const cache = {
    async match(key) { return entries.get(key)?.clone(); },
    async delete(key) { return entries.delete(key); },
    async put(key, response) {
      const body = await response.arrayBuffer();
      entries.set(key, new Response(body, { status: response.status, headers: response.headers }));
    },
  };
  const dependencies = { cacheStorage: { async open(name) {
    assert.equal(name, MODEL_CACHE_NAME); return cache;
  } }, async fetchAsset(url, options) {
    calls.push(url);
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
    const i = set.files.findIndex(file => file.sourceURL === url);
    let position = 0;
    return new Response(new ReadableStream({ pull(controller) {
      options.signal.throwIfAborted();
      if (position === contents[i].length) controller.close();
      else { controller.enqueue(contents[i].subarray(position, position + 3)); position += Math.min(3, contents[i].length - position); }
    } }), { status: 200 });
  } };
  const make = () => new ModelAssetCache(set, dependencies);
  return { cache, entries, calls, events, dependencies, make, manager: make(), set,
    onChange: view => events.push(view) };
}

test('first download emits byte progress, verifies every file, and survives manager recreation without fetching', async () => {
  const f = fixture();
  assert.equal((await f.manager.inspect()).state, 'Not downloaded');
  const result = await f.manager.prepare({ onChange: f.onChange });
  assert.equal(result.state, 'Ready'); assert.equal(result.cachedBytes, f.set.bytes);
  assert.ok(f.events.some(event => event.state === 'Downloading' && event.downloadedBytes > 0 && event.downloadedBytes < f.set.bytes));
  assert.equal(f.events.at(-1).state, 'Ready'); assert.equal(f.calls.length, 2);
  assert.deepEqual((await f.make().inspect()).files.map(file => file.cached), [true, true]);
  await f.make().prepare(); assert.equal(f.calls.length, 2);
});

test('partial cached sets never become Ready; failed second file preserves first for retry', async () => {
  const f = fixture(), fetch = f.dependencies.fetchAsset;
  f.dependencies.fetchAsset = async (...args) => {
    if (args[0] === f.set.files[1].url) throw new Error('Network disconnected');
    return fetch(...args);
  };
  const result = await f.make().prepare();
  assert.equal(result.state, 'Error'); assert.match(result.error, /Network disconnected/);
  assert.deepEqual(result.files.map(file => file.cached), [true, false]);
  assert.equal((await f.make().inspect()).state, 'Not downloaded');
  f.dependencies.fetchAsset = fetch;
  assert.equal((await f.make().prepare()).state, 'Ready');
  assert.equal(f.calls.filter(url => url === f.set.files[0].url).length, 1);
});

for (const mode of ['short', 'long', 'corrupt', 'partial-status', 'stream-error']) {
  test(`${mode} download is rejected without a partial entry and can be retried`, async () => {
    const f = fixture(), fetch = f.dependencies.fetchAsset;
    f.dependencies.fetchAsset = async () => {
      if (mode === 'stream-error') return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(data[0].subarray(0, 3)); controller.error(new Error('Interrupted'));
      } }));
      const body = mode === 'short' ? data[0].subarray(0, 3)
        : mode === 'long' ? Buffer.concat([data[0], Buffer.from('extra')])
          : mode === 'corrupt' ? Buffer.alloc(data[0].length) : data[0];
      return new Response(body, { status: mode === 'partial-status' ? 206 : 200 });
    };
    assert.equal((await f.make().prepare()).state, 'Error'); assert.equal(f.entries.size, 0);
    f.dependencies.fetchAsset = fetch;
    assert.equal((await f.make().prepare()).state, 'Ready');
  });
}

test('corrupt or incomplete cached bytes are revalidated and removed even with matching Content-Length', async () => {
  const f = fixture(); await f.manager.prepare();
  f.entries.set(f.set.files[0].url, new Response(Buffer.alloc(data[0].length), {
    headers: { 'Content-Length': String(data[0].length) },
  }));
  const result = await f.make().inspect();
  assert.equal(result.state, 'Not downloaded');
  assert.deepEqual(result.files.map(file => file.cached), [false, true]);
  assert.equal(f.entries.has(f.set.files[0].url), false);
  await f.make().prepare(); assert.equal(f.calls.length, 3);
});

test('eviction and optional deletion require new downloads and leave unrelated cache entries intact', async () => {
  const f = fixture(); await f.manager.prepare();
  f.entries.delete(f.set.files[1].url);
  assert.equal((await f.make().inspect()).state, 'Not downloaded');
  await f.make().prepare(); assert.equal(f.calls.length, 3);
  const unrelated = 'https://example.com/unrelated'; f.entries.set(unrelated, new Response('keep'));
  assert.equal((await f.manager.remove()).state, 'Not downloaded');
  assert.deepEqual([...f.entries.keys()], [unrelated]);
  await f.make().prepare(); assert.equal(f.calls.length, 5);
  f.entries.clear(); assert.equal((await f.make().inspect()).cachedBytes, 0);
});

test('quota or cache access failures are errors; failed writes are cleaned up and retry succeeds', async () => {
  const f = fixture(), put = f.cache.put;
  f.cache.put = async (key, response) => {
    f.entries.set(key, new Response('partial'));
    await response.body.cancel();
    throw new DOMException('Full disk', 'QuotaExceededError');
  };
  const result = await f.make().prepare();
  assert.equal(result.state, 'Error'); assert.match(result.error, /quota exceeded/); assert.equal(f.entries.size, 0);
  f.cache.put = put; assert.equal((await f.make().prepare()).state, 'Ready');
  const unavailable = new ModelAssetCache(f.set, { cacheStorage: { open() { throw new Error('Cache unavailable'); } } });
  assert.equal((await unavailable.inspect()).state, 'Error');
  assert.equal((await unavailable.prepare()).state, 'Error');
  assert.equal((await unavailable.remove()).state, 'Error');
});

test('explicit cancellation interrupts streaming and retry uses validated completed assets', async () => {
  const f = fixture(), controller = new AbortController();
  const result = await f.manager.prepare({ signal: controller.signal, onChange(view) {
    if (view.downloadedBytes > data[0].length) controller.abort();
  } });
  assert.equal(result.state, 'Error');
  assert.deepEqual(result.files.map(file => file.cached), [true, false]);
  assert.equal(f.entries.size, 1);
  assert.equal((await f.make().prepare()).state, 'Ready');
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  assert.equal((await f.make().prepare({ signal: alreadyAborted.signal })).state, 'Error');
});

test('immutable keys separate models and revisions and match existing pinned Hugging Face URLs', async () => {
  const a = manifest(), b = manifest({ id: 'test/other' }), c = manifest({ revision: 'b'.repeat(40) });
  assert.equal(new Set([a, b, c].map(set => set.files[0].url)).size, 3);
  assert.equal(a.files[0].url, `https://huggingface.co/test/model/resolve/${'a'.repeat(40)}/file-0.bin`);
  for (const options of [{ revision: 'main' }, { id: '../model' }]) assert.throws(() => manifest(options), TypeError);
  assert.throws(() => defineAssetSet({ id: a.id, revision: a.revision, files: [{ path: 'a', bytes: 10 }] }), TypeError);
  assert.throws(() => defineAssetSet({ id: a.id, revision: a.revision, files: [a.files[0], a.files[0]] }), TypeError);
  assert.ok(Object.isFrozen(a.files[0].sha256Chunks));
  const f = fixture(a); await f.manager.prepare();
  const other = new ModelAssetCache(c, f.dependencies);
  assert.equal((await other.inspect()).state, 'Not downloaded');
});

test('multi-chunk assets are streamed and hashed across arbitrary network boundaries without whole-response buffering', async () => {
  const bytes = Buffer.alloc(HASH_CHUNK_BYTES * 2 + 17, 23), set = manifest({ contents: [bytes] });
  const f = fixture(set, [bytes]);
  let reads = 0, maxHashBytes = 0;
  f.dependencies.fetchAsset = async () => {
    let offset = 0;
    const response = new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 333333, bytes.length);
      controller.enqueue(bytes.subarray(offset, end)); offset = end; reads++;
    } }));
    response.arrayBuffer = response.blob = () => { throw new Error('Whole response buffering forbidden'); };
    return response;
  };
  const original = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = (algorithm, bytes) => { maxHashBytes = Math.max(maxHashBytes, bytes.byteLength); return original(algorithm, bytes); };
  try {
    assert.equal((await f.make().prepare()).state, 'Ready');
    assert.ok(reads > 1); assert.equal(maxHashBytes, HASH_CHUNK_BYTES);
  } finally { crypto.subtle.digest = original; }
});

test('simultaneous preparation in one owner serializes and avoids duplicate downloads', async () => {
  const f = fixture();
  const results = await Promise.all([f.manager.prepare(), f.manager.prepare()]);
  assert.ok(results.every(result => result.state === 'Ready')); assert.equal(f.calls.length, 2);
});

test('lock keys cover a model revision regardless of file order, and lock errors are reported', async () => {
  const f = fixture(), names = [];
  f.dependencies.locks = { request(name, options, action) { names.push(name); return action(); } };
  const reordered = defineAssetSet({ id: f.set.id, revision: f.set.revision, files: [...f.set.files].reverse() });
  await f.make().inspect(); await new ModelAssetCache(reordered, f.dependencies).inspect();
  assert.equal(names[0], names[1]);
  f.dependencies.locks = { request() { throw new Error('Lock unavailable'); } };
  assert.equal((await f.make().inspect()).state, 'Error');
  assert.equal((await f.make().prepare()).state, 'Error');
  assert.equal((await f.make().remove()).state, 'Error');
});

test('eviction during preparation never reports Ready and identifies missing files', async () => {
  const f = fixture(), put = f.cache.put;
  f.cache.put = async (...args) => {
    await put(...args);
    if (args[0] === f.set.files[1].url) f.entries.clear();
  };
  const result = await f.manager.prepare();
  assert.equal(result.state, 'Error'); assert.match(result.error, /evicted/);
  assert.deepEqual(result.files.map(file => file.cached), [false, false]);
  assert.equal(result.cachedBytes, 0);
  f.cache.put = put; assert.equal((await f.make().prepare()).state, 'Ready');
});

test('persistence support, existing grants, denials and exceptions are accurately reported', async () => {
  assert.equal(await storagePersistence({}), 'unsupported');
  assert.equal(await storagePersistence({ persisted: async () => false }), 'not granted');
  assert.equal(await storagePersistence({ persisted: async () => false }, true), 'unsupported');
  assert.equal(await storagePersistence({ persisted: async () => true, persist() { throw Error(); } }, true), 'granted');
  assert.equal(await storagePersistence({ persisted: async () => false, persist: async () => false }, true), 'denied');
  assert.equal(await storagePersistence({ persisted: async () => false, persist: async () => true }, true), 'granted');
  assert.equal(await storagePersistence({ persisted() { throw Error(); } }), 'unavailable');
});
