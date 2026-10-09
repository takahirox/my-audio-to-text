import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ttsAsset, requireWasm } from '../web/tts-worker.js';

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
