import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NODE_TYPES, graphNode, assertGraph, saveGraph } from '../extension/graph.js';
import { groupPaletteEntries, NODE_PALETTE_CATEGORIES } from '../extension/graph-palette.js';
const expected = {
  SpeechToTextReazonSpeech: ['Speech Recognition · JA/EN', 'ReazonSpeech ja-en'],
  SpeechToTextWhisper: ['Speech Recognition · Multilingual', 'Whisper tiny (multilingual)'],
  SpeechToTextZipformerEn: ['Speech Recognition · EN / Streaming', 'Zipformer English'],
  SpeechToTextParakeetV3: ['Speech Recognition', 'Parakeet TDT 0.6B v3'],
  SpeechToTextMoonshineMediumEn: ['Speech Recognition · EN / Streaming', 'Moonshine Medium Streaming English'],
  OpusMtJaEn: ['Translation · JA → EN', 'OPUS-MT'],
  OpusMtEnJa: ['Translation · EN → JA', 'OPUS-MT'],
  TranslateGemmaJaEn: ['Translation · JA → EN', 'TranslateGemma 4B'],
  TranslateGemmaEnJa: ['Translation · EN → JA', 'TranslateGemma 4B'],
  TextSummaryLfm2: ['Text Summarization', 'LFM2.5 1.2B JP'],
  TextSummaryQwen35: ['Text Summarization', 'Qwen3.5 2B'],
  IfCondition: ['Condition Check · Yes/No', 'XtremeDistil'],
  Kokoro: ['Speech Synthesis', 'Kokoro 82M'],
  Supertonic3: ['Speech Synthesis', 'Supertonic 3'],
  Qwen3TtsStreaming: ['Speech Synthesis · Streaming', 'Qwen3-TTS 0.6B CustomVoice'],
  CosyVoice3Streaming: ['Speech Synthesis · Streaming', 'CosyVoice3 0.5B'],
};
test('exactly the 16 AI types have function/model facts, independently of ports or names', () => {
  assert.equal(Object.keys(expected).length, 16);
  for (const [type, definition] of Object.entries(NODE_TYPES)) {
    if (!expected[type]) { assert.equal(definition.ai, undefined, type); continue; }
    assert.deepEqual([definition.label, definition.ai.model], expected[type]);
    assert.ok(definition.ai.languages);
    assert.match(definition.ai.runtime, /WASM|WebGPU/);
    assert.match(NODE_PALETTE_CATEGORIES[type], /^AI Models/);
    for (const query of expected[type]) {
      const matches = [...groupPaletteEntries(Object.entries(NODE_TYPES), { query }).values()].flat();
      assert.ok(matches.some(([id]) => id === type), `${type}: ${query}`);
    }
  }
  assert.match(NODE_TYPES.SpeechToTextWhisper.ai.languages, /English \(en, default\), Japanese \(ja\)/);
  assert.equal(NODE_TYPES.SpeechToTextReazonSpeech.inputs.language, undefined);
  assert.match(NODE_TYPES.SpeechToTextParakeetV3.ai.runtime, /WebGPU.*WASM/);
});
test('colliding functions sort by model name with stable order in each category', () => {
  const entries = Object.entries(NODE_TYPES);
  const grouped = groupPaletteEntries(entries);
  assert.deepEqual(groupPaletteEntries(entries.reverse()), grouped);
  const sameTitle = title => [...grouped.values()].flat().filter(([,d])=>d.label===title).map(([,d])=>d.ai.model);
  assert.deepEqual(sameTitle('Speech Recognition · EN / Streaming'), ['Moonshine Medium Streaming English', 'Zipformer English']);
  assert.deepEqual(sameTitle('Translation · JA → EN'), ['OPUS-MT', 'TranslateGemma 4B']);
  assert.deepEqual(sameTitle('Text Summarization'), ['LFM2.5 1.2B JP', 'Qwen3.5 2B']);
  assert.deepEqual(sameTitle('Speech Synthesis'), ['Kokoro 82M', 'Supertonic 3']);
  assert.deepEqual(sameTitle('Speech Synthesis · Streaming'), ['CosyVoice3 0.5B', 'Qwen3-TTS 0.6B CustomVoice']);
});
test('secondary model names retain Japanese kana/natural-number order and match search', () => {
  const models = ['さくら', 'Model 10', 'いちご', 'beta', 'アオイ', 'Model 2', 'あかね', 'Alpha'];
  const entries = models.map(model => ['TextSummaryLfm2', { label: 'Text Summarization', ai: { model } }]);
  const grouped = input => groupPaletteEntries(input).get('AI Models / Text').map(([,d]) => d.ai.model);
  assert.deepEqual(grouped(entries), ['Alpha', 'beta', 'Model 2', 'Model 10', 'アオイ', 'あかね', 'いちご', 'さくら']);
  assert.deepEqual(grouped([...entries].reverse()), grouped(entries));
  assert.equal(groupPaletteEntries(entries, { query: 'あか' }).get('AI Models / Text')[0][1].ai.model, 'あかね');
});
test('pre-change AI graph JSON and all non-presentation node contracts remain identical', () => {
  // Captured from 5c87735 before presentation metadata was added. Contract
  // hashes include every original field except label (ports, defaults, help, etc.).
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ai-node-compatibility.json', import.meta.url)));
  const serialized = JSON.stringify(fixture.graph);
  assert.equal(JSON.stringify(assertGraph(JSON.parse(serialized))), serialized);
  const storage = new Map(); storage.getItem = key => storage.get(key) ?? null; storage.setItem = (k,v) => storage.set(k,v);
  assert.equal(JSON.stringify(saveGraph(storage, fixture.graph)), serialized);
  assert.equal([...storage.values()][0], serialized);
  for (const node of fixture.graph.nodes) {
    assert.deepEqual(graphNode(node.type, node.id), node);
    const { label, ai, ...contract } = NODE_TYPES[node.type];
    assert.equal(createHash('sha256').update(JSON.stringify(contract)).digest('hex'), fixture.contracts[node.type], node.type);
  }
});
