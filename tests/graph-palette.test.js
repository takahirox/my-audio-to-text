import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODE_TYPES } from '../extension/graph.js';
import { PALETTE_CATEGORIES, NODE_PALETTE_CATEGORIES, groupPaletteEntries } from '../extension/graph-palette.js';

test('every built-in has an explicit Add Node category; new types must be classified', () => {
  assert.deepEqual(Object.keys(NODE_PALETTE_CATEGORIES).sort(), Object.keys(NODE_TYPES).sort());
  const expected = {
    'Sources / inputs': ['Button', 'ChromeTabAudio', 'MicrophoneAudio', 'Number', 'Text'],
    'AI Models': [
      'CosyVoice3Streaming', 'IfCondition', 'Kokoro', 'OpusMtEnJa', 'OpusMtJaEn',
      'Qwen3TtsStreaming', 'SpeechToTextMoonshineMediumEn', 'SpeechToTextParakeetV3',
      'SpeechToTextReazonSpeech', 'SpeechToTextWhisper', 'SpeechToTextZipformerEn',
      'Supertonic3', 'TextSummaryLfm2', 'TextSummaryQwen35', 'TranslateGemmaEnJa', 'TranslateGemmaJaEn',
    ],
    'Processors': ['Hold', 'KeyedPairedTextAccumulator', 'KeyedTextCoalesce', 'KeyedTextPair', 'TextAccumulator', 'TextFormatter', 'TextSlidingWindow', 'TextWindow'],
    'Outputs': ['AudioOutput', 'Display', 'FocusedInputTextOutputNode', 'SpeakerOutput', 'StreamingSpeakerOutput'],
    'Subgraphs': [],
  };
  assert.deepEqual(PALETTE_CATEGORIES, Object.keys(expected));
  for (const [category, types] of Object.entries(expected)) {
    assert.deepEqual(Object.keys(NODE_TYPES).filter(type => NODE_PALETTE_CATEGORIES[type] === category).sort(), types);
  }
  assert.throws(() => groupPaletteEntries([['FutureInference', { label: 'New model' }]]), /Missing Add Node category/);
});

test('category and label order are independent of registration order and port counts', () => {
  const entries = [...Object.entries(NODE_TYPES), ['Subgraph:z', { label: 'Shared utility' }]];
  const expected = groupPaletteEntries(entries);
  assert.deepEqual([...expected.keys()], PALETTE_CATEGORIES);
  assert.deepEqual(groupPaletteEntries([...entries].reverse()), expected);
  // Presentation classification cannot change with ports or model-like labels.
  const misleading = [
    ['TextFormatter', { label: 'AI inference', inputs: {}, outputs: {} }],
    ['IfCondition', { label: 'Ordinary utility', inputs: {}, outputs: {} }],
    ['Subgraph:ai', { label: 'Whisper ASR', inputs: {}, outputs: {} }],
  ];
  assert.deepEqual([...groupPaletteEntries(misleading).keys()], ['AI Models', 'Processors', 'Subgraphs']);
  assert.deepEqual(expected.get('Sources / inputs').map(([, definition]) => definition.label),
    ['Button', 'Chrome tab audio', 'Microphone audio', 'Number', 'Text']);
  assert.deepEqual(expected.get('Processors').map(([, definition]) => definition.label),
    ['Hold', 'Keyed paired text accumulator', 'Keyed text coalesce', 'Keyed text pair', 'Text accumulator', 'Text formatter', 'Text sliding window', 'Text window']);
});

test('visible Latin/Japanese names use kana order and natural numbers in every category', () => {
  const labels = ['さくら', 'Model 10', 'いちご', 'beta', 'アオイ', 'Model 2', 'あかね', 'Alpha'];
  const expected = ['Alpha', 'beta', 'Model 2', 'Model 10', 'アオイ', 'あかね', 'いちご', 'さくら'];
  for (const category of PALETTE_CATEGORIES) {
    const type = Object.keys(NODE_PALETTE_CATEGORIES).find(type => NODE_PALETTE_CATEGORIES[type] === category);
    // Duplicate type IDs here deliberately ensure labels are the primary key.
    const entries = Object.freeze(labels.map((label, index) => Object.freeze([
      type || `Subgraph:${labels.length - index}`, Object.freeze({ label }),
    ])));
    for (const input of [entries, [...entries].reverse()]) {
      assert.deepEqual(groupPaletteEntries(input).get(category).map(([, definition]) => definition.label), expected);
    }
    assert.deepEqual(entries.map(([, definition]) => definition.label), labels);
  }
});

test('dynamic subgraph names, equivalent kana/case/numbers and equal names have stable ties', () => {
  const entries = [
    ['Subgraph:a', { label: 'alpha' }], ['Subgraph:z', { label: 'Alpha' }],
    ['Subgraph:b', { label: 'Alpha' }], ['Subgraph:n2', { label: 'Model 2' }],
    ['Subgraph:n02', { label: 'Model 02' }], ['Subgraph:kana', { label: 'アオイ' }],
    ['Subgraph:hira', { label: 'あおい' }],
  ];
  const ids = input => groupPaletteEntries(input).get('Subgraphs').map(([type]) => type.slice(9));
  assert.deepEqual(ids(entries), ['b', 'z', 'a', 'n02', 'n2', 'hira', 'kana']);
  assert.deepEqual(ids([...entries].reverse()), ids(entries));
  entries.push(['Subgraph:last-added', { label: 'Model 3' }]);
  assert.deepEqual(ids(entries), ['b', 'z', 'a', 'n02', 'n2', 'last-added', 'hira', 'kana']);
  entries[0] = ['Subgraph:a', { label: 'さくら' }];
  assert.equal(ids(entries).at(-1), 'a');
});

test('category/query filters combine, keep sorted groups, match types or labels and allow zero results', () => {
  const entries = [...Object.entries(NODE_TYPES), ['Subgraph:jp', { label: 'あかね' }]];
  const groups = groupPaletteEntries(entries, { query: '  TEXT  ' });
  assert.deepEqual([...groups.keys()], ['Sources / inputs', 'AI Models', 'Processors', 'Outputs']);
  const summary = groupPaletteEntries(entries, { query: 'text', category: 'AI Models' });
  assert.deepEqual([...summary.keys()], ['AI Models']);
  assert.ok(summary.get('AI Models').every(([type]) => type.startsWith('SpeechToText') || type.startsWith('TextSummary')));
  const processors = groupPaletteEntries(entries, { query: 'text', category: 'Processors' });
  assert.deepEqual(processors.get('Processors'), groups.get('Processors'));
  assert.equal(groupPaletteEntries(entries, { query: 'あか', category: 'Subgraphs' }).get('Subgraphs')[0][0], 'Subgraph:jp');
  assert.equal(groupPaletteEntries(entries, { query: 'Number', category: 'Outputs' }).size, 0);
  assert.equal(groupPaletteEntries(entries, { category: 'Constants / utilities' }).size, 0);
});
