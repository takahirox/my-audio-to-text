import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphModelRequirements, GraphModelPreparation } from '../extension/graph-model-preparation.js';
import { defaultGraph, graphNode } from '../extension/graph.js';

test('saved Nodes select only their direction and distinct weights/voices, including parked Nodes; ASR stays packaged', () => {
  const graph = defaultGraph();
  graph.nodes.push(graphNode('SpeechToTextWhisper', 'whisper'), graphNode('SpeechToTextZipformerEn', 'zipformer'));
  assert.deepEqual(graphModelRequirements(graph), []);
  graph.nodes.push(graphNode('OpusMtEnJa', 'reverse'), graphNode('OpusMtEnJa', 'repeat'));
  assert.deepEqual(graphModelRequirements(graph).map(item => item.key), ['opus-en-ja']);
  for (const [type, voice, language] of [['Supertonic3', 'F1', 'ja'], ['Supertonic3', 'F1', 'en'], ['Supertonic3', 'M1', 'en'], ['Kokoro', 'jf_alpha'], ['Kokoro', 'af_heart'], ['OpusMtJaEn']]) {
    const node = graphNode(type, `node-${graph.nodes.length}`);
    if (voice) node.settings.voice = voice;
    if (language) node.settings.language = language;
    graph.nodes.push(node);
  }
  const before = structuredClone(graph);
  assert.deepEqual(graphModelRequirements(graph).map(item => item.key), ['opus-en-ja', 'supertonic3:F1', 'supertonic3:M1', 'kokoro:jf_alpha', 'kokoro:af_heart', 'opus-ja-en']);
  assert.deepEqual(graph, before);
});

const settled = async () => { await new Promise(resolve => setImmediate(resolve)); };
const graph = () => { const graph = defaultGraph(); graph.nodes.push(graphNode('OpusMtEnJa', 'parked')); return graph; };

test('no work until explicitly scheduled; manifests and preparation failures are retryable and leave saved data intact', async () => {
  let fetched = 0, prepared = 0, failManifest = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; if (failManifest) throw Error('manifest unavailable'); return { ok: true, json: async () => [{ path: 'weights', bytes: 1, sha256Chunks: ['0'.repeat(64)] }] }; };
  try {
    const preparation = new GraphModelPreparation({ createCache: () => ({ prepare: async () => {
      prepared++; return { state: prepared === 1 ? 'Error' : 'Ready', downloadedBytes: 1, totalBytes: 1, error: prepared === 1 ? 'offline' : '' };
    } }) });
    assert.equal(fetched, 0);
    preparation.replace(defaultGraph()); await settled(); assert.equal(fetched, 0);
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
    preparation.replace(graph()); await settled(); const old = preparation.entries[0];
    preparation.replace(defaultGraph()); assert.equal(signals[2].aborted, true);
    finishes[2](); await settled(); assert.deepEqual(preparation.entries, []); assert.equal(old.view.state, 'Downloading');
    preparation.replace(graph()); await settled(); preparation.close(); const count = changes;
    assert.equal(signals[3].aborted, true); finishes[3](); await settled(); assert.equal(changes, count);
    preparation.replace(graph()); assert.equal(signals.length, 4);
  } finally { globalThis.fetch = originalFetch; }
});
