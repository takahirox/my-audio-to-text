import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphModelRequirements, GraphModelPreparation } from '../extension/graph-model-preparation.js';
import { defaultGraph, graphNode } from '../extension/graph.js';

test('all ASR dependencies and Japanese frontend are explicit and deduplicated, including parked Nodes', () => {
  const graph = defaultGraph();
  graph.nodes.push(graphNode('SpeechToTextWhisper', 'whisper'), graphNode('SpeechToTextZipformerEn', 'zipformer'), graphNode('SpeechToTextReazonSpeech', 'duplicate'));
  assert.deepEqual(graphModelRequirements(graph).map(r => r.key), ['silero', 'reazon', 'whisper', 'zipformer']);
  assert.deepEqual(graphModelRequirements({ nodes: [graphNode('SpeechToTextZipformerEn', 'zip')] }).map(r => r.key), ['zipformer']);
  graph.nodes.push(graphNode('Kokoro', 'jp')); graph.nodes.at(-1).settings.voice = 'jf_alpha';
  assert.deepEqual(graphModelRequirements(graph).map(r => r.key).slice(-2), ['kokoro-japanese', 'kokoro:jf_alpha']);
  assert.deepEqual(graphModelRequirements(modelFreeGraph()), []);
});
const modelFreeGraph = () => ({ ...defaultGraph(), nodes: [graphNode('Text', 'text')] });

const settled = async () => { await new Promise(resolve => setImmediate(resolve)); };
const graph = () => { const graph = modelFreeGraph(); graph.nodes.push(graphNode('OpusMtEnJa', 'parked')); return graph; };

test('no work until explicitly scheduled; manifests and preparation failures are retryable and leave saved data intact', async () => {
  let fetched = 0, prepared = 0, failManifest = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; if (failManifest) throw Error('manifest unavailable'); return { ok: true, json: async () => [{ path: 'weights', bytes: 1, sha256Chunks: ['0'.repeat(64)] }] }; };
  try {
    const preparation = new GraphModelPreparation({ createCache: () => ({ prepare: async () => {
      prepared++; return { state: prepared === 1 ? 'Error' : 'Ready', downloadedBytes: 1, totalBytes: 1, error: prepared === 1 ? 'offline' : '' };
    } }) });
    assert.equal(fetched, 0);
    preparation.replace(modelFreeGraph()); await settled(); assert.equal(fetched, 0);
    const saved = graph(), before = structuredClone(saved);
    preparation.replace(saved); await settled();
    assert.equal(preparation.entries[0].view.state, 'Error'); assert.equal(prepared, 0);
    failManifest = false; await preparation.run(preparation.entries[0]);
    assert.equal(preparation.entries[0].view.state, 'Error');
    await preparation.run(preparation.entries[0]); assert.equal(preparation.entries[0].view.state, 'Ready');
    assert.equal(fetched, 2); assert.deepEqual(saved, before);
    preparation.close();
  } finally { globalThis.fetch = originalFetch; }
});

test('cancel, newer Save and teardown abort active/queued work and ignore late state; retry can recover', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ path: 'weights', bytes: 1, sha256Chunks: ['0'.repeat(64)] }] });
  const signals = [], finishes = []; let changes = 0;
  try {
    const preparation = new GraphModelPreparation({ onChange: () => changes++, createCache: () => ({ prepare: ({ signal, onChange }) => {
      signals.push(signal); onChange({ state: 'Downloading', downloadedBytes: 1, totalBytes: 2, error: '' });
      return new Promise(resolve => finishes.push(() => resolve({ state: 'Ready', downloadedBytes: 2, totalBytes: 2, error: '' })));
    } }) });
    preparation.replace(graph()); await settled(); const entry = preparation.entries[0];
    preparation.cancel(entry); assert.equal(signals[0].aborted, true); finishes[0](); await settled();
    assert.equal(entry.view.state, 'Canceled');
    const retry = preparation.run(entry); await settled(); finishes[1](); await retry; assert.equal(entry.view.state, 'Ready');
    preparation.replace(graph()); await settled(); assert.equal(signals.length, 2, 'same requirements retain the verified entry');
    preparation.replace(modelFreeGraph()); preparation.replace(graph()); await settled(); const old = preparation.entries[0];
    preparation.replace(modelFreeGraph()); assert.equal(signals[2].aborted, true);
    finishes[2](); await settled(); assert.deepEqual(preparation.entries, []); assert.equal(old.view.state, 'Downloading');
    preparation.replace(graph()); await settled(); preparation.close(); const count = changes;
    assert.equal(signals[3].aborted, true); finishes[3](); await settled(); assert.equal(changes, count);
    preparation.replace(graph()); assert.equal(signals.length, 4);
  } finally { globalThis.fetch = originalFetch; }
});


test('text, position and library revisions do not restart an active preparation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ path: 'weights', bytes: 1, sha256Chunks: ['0'.repeat(64)] }] });
  let count = 0, finish;
  try {
    const preparation = new GraphModelPreparation({ createCache: () => ({ prepare: () => { count++; return new Promise(resolve => { finish = resolve; }); } }) });
    const initial = graph(); preparation.replace(initial); await settled(); const entry = preparation.entries[0];
    for (let i = 0; i < 100; i++) { initial.nodes[0].position.x++; preparation.replace(initial); }
    assert.equal(count, 1); assert.equal(preparation.entries[0], entry); assert.equal(entry.controller.signal.aborted, false);
    finish({ state: 'Ready', downloadedBytes: 0, totalBytes: 0, error: '' }); await settled();
    preparation.replace(initial); await settled(); assert.equal(count, 1); preparation.close();
  } finally { globalThis.fetch = originalFetch; }
});
