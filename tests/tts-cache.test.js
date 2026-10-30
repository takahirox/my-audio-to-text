import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ttsAsset, requireWasm } from '../web/tts-worker.js';
import { qwen3TtsAssets } from '../extension/qwen3-tts-cache.js';
import { createHash } from 'node:crypto';

test('TTS asset caching survives eviction, storage failure and offline misses without remote inference', async () => {
  const original = { caches: globalThis.caches, fetch: globalThis.fetch, self: globalThis.self };
  const url = 'https://huggingface.co/model/resolve/' + 'a'.repeat(40) + '/weights.onnx';
  let response, fetches = 0; const progress = [];
  globalThis.self = { postMessage: event => progress.push(event.message) };
  globalThis.caches = { async open() { return {
    async match() { return response?.clone(); },
    async put(key, value) { assert.equal(key, url); response = value; },
  }; } };
  globalThis.fetch = async (key, options) => {
    assert.equal(key, url); assert.equal(options, undefined); fetches++;
    return new Response('immutable asset');
  };
  try {
    requireWasm();
    assert.equal(await (await ttsAsset(url)).text(), 'immutable asset');
    assert.equal(await (await ttsAsset(url)).text(), 'immutable asset'); assert.equal(fetches, 1);
    response = null; // storage eviction is a network refetch, not a stale promise
    await ttsAsset(url); assert.equal(fetches, 2);
    globalThis.caches.open = async () => { throw Error('Storage disabled'); };
    assert.equal(await (await ttsAsset(url)).text(), 'immutable asset');
    globalThis.caches.open = async () => ({ match: async () => { throw Error('Cache unavailable'); },
      put: async () => { throw Error('Quota exceeded'); } });
    assert.equal(await (await ttsAsset(url)).text(), 'immutable asset');
    assert.ok(progress.some(value => /storage unavailable or full/.test(value)));
    globalThis.fetch = async () => { throw Error('Offline'); };
    await assert.rejects(ttsAsset(url), /network\/CORS or offline cache miss/);
    globalThis.fetch = async () => new Response('', { status: 503 });
    await assert.rejects(ttsAsset(url), /HTTP 503/);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('Qwen startup verifies cached bytes, permits only reviewed files, and never downloads a missing/evicted/corrupt weight', async () => {
  const original = { caches: globalThis.caches, fetch: globalThis.fetch };
  const body = Buffer.from('reviewed weights');
  const spec = { id: 'reviewed/qwen3-tts', revision: 'a'.repeat(40), files: [{ path: 'weights.onnx', bytes: body.length,
    sha256Chunks: [createHash('sha256').update(body).digest('hex')] }] };
  let cached = body, requests = 0, deleted = 0;
  globalThis.fetch = async url => {
    assert.ok(String(url).endsWith('/qwen3-tts-assets.json')); requests++;
    return Response.json(spec);
  };
  globalThis.caches = { async open(name) {
    assert.equal(name, 'transformers-cache');
    return { async match(url) {
      assert.equal(url, `https://huggingface.co/${spec.id}/resolve/${spec.revision}/weights.onnx`);
      return cached ? new Response(cached) : undefined;
    }, async delete() { deleted++; cached = null; } };
  } };
  try {
    const read = await qwen3TtsAssets(); assert.deepEqual(await read('weights.onnx'), new Uint8Array(body));
    await assert.rejects(read('unreviewed.bin'), /Unreviewed/);
    cached = null; await assert.rejects(read('weights.onnx'), /evicted during load/);
    await assert.rejects(qwen3TtsAssets(), /missing or evicted/);
    cached = Buffer.alloc(body.length); await assert.rejects(qwen3TtsAssets(), /missing or evicted/); assert.equal(deleted, 1);
    globalThis.caches.open = async () => { throw Error('Cache Storage unavailable'); };
    await assert.rejects(qwen3TtsAssets(), /Cache Storage unavailable/);
    assert.equal(requests, 4); // packaged JSON only; no weight GET/fallback
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('extension cache-only TTS never refetches evicted assets or falls back when storage is unavailable', async () => {
  const { serveTts } = await import('../web/tts-worker.js');
  const original = { caches: globalThis.caches, fetch: globalThis.fetch, self: globalThis.self };
  const url = 'https://huggingface.co/model/resolve/' + 'a'.repeat(40) + '/weights.onnx';
  const replies = []; let hit = new Response('prepared weights'), fetches = 0;
  globalThis.self = { postMessage: message => replies.push(message) };
  globalThis.fetch = async () => { fetches++; throw Error('Unexpected remote request'); };
  globalThis.caches = { async open(name) { assert.equal(name, 'transformers-cache'); return { match: async key => { assert.equal(key, url); return hit?.clone(); } }; } };
  try {
    serveTts({ load: async () => { await ttsAsset(url); }, generate() {} });
    globalThis.self.onmessage({ data: { type: 'load', id: 1, cacheOnly: true } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies[0].type, 'ready'); assert.equal(await (await ttsAsset(url)).text(), 'prepared weights');
    hit = null; await assert.rejects(ttsAsset(url), /missing or evicted/);
    globalThis.caches.open = async () => { throw Error('Storage unavailable'); };
    await assert.rejects(ttsAsset(url), /Storage unavailable/); assert.equal(fetches, 0);
  } finally {
    // Reset module state for other tests through its public Worker load protocol.
    serveTts({ load() {}, generate() {} });
    globalThis.self.onmessage({ data: { type: 'load', id: 2, cacheOnly: false } });
    await new Promise(resolve => setImmediate(resolve));
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
