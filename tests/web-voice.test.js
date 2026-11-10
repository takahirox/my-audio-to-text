import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webVoiceGraph, webVoiceError, webVoiceChoices, webVoiceDefault } from '../extension/web-voice-graph.js';
import { voiceEnabled } from '../extension/web-voice-preference.js';
import { graphNode, edge, defaultGraph } from '../extension/graph.js';

function voice() {
  return { version: 15, nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')],
    edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'field', 'text')] };
}
test('enablement requires exact versioned boolean consent; assignment cannot enable it', () => {
  for (const value of [undefined, null, true, {}, { enabled: true }, { version: 1, enabled: 'true' }, { version: 2, enabled: true }, { version: 1, enabled: false }, { assignments: { webVoice: 'saved' } }]) assert.equal(voiceEnabled(value), false);
  assert.equal(voiceEnabled({ version: 1, enabled: true }), true);
});
test('typed executable connectivity, not node presence, names or Live defaults', () => {
  assert.equal(webVoiceError(voice()), '');
  assert.ok(webVoiceError(defaultGraph()));
  const disconnected = voice(); disconnected.edges.pop(); assert.ok(webVoiceError(disconnected));
  const wrongType = voice(); wrongType.edges[1].from[1] = 'finalId'; assert.ok(webVoiceError(wrongType));
  const otherSource = voice(); otherSource.nodes[0] = graphNode('ChromeTabAudio', 'mic'); assert.match(webVoiceError(otherSource), /capture/);
  otherSource.nodes[0] = graphNode('SelectedPageMediaAudio', 'mic'); assert.match(webVoiceError(otherSource), /capture/);
});
test('final processors are allowed, snapshot is detached, and optional side effect branches never execute', () => {
  const graph = voice(); graph.nodes.push({ ...graphNode('TextFormatter', 'format'), settings: { template: 'Said: {1}', inputCount: 4 } }, graphNode('Display', 'display'));
  graph.edges[1] = edge('asr', 'final', 'format', 'input1');
  graph.edges.push(edge('format', 'text', 'field', 'text'), edge('asr', 'provisional', 'display', 'input1'));
  const snapshot = webVoiceGraph(graph);
  assert.ok(snapshot.nodes.some(n => n.id === 'format'));
  assert.ok(!snapshot.nodes.some(n => n.id === 'display'));
  assert.ok(snapshot.edges.every(e => e.from[1] !== 'provisional'));
  graph.nodes[0].id = 'changed'; assert.equal(snapshot.nodes[0].id, 'mic');
  graph.edges.length = 0; assert.equal(snapshot.edges.length, 3);
});
test('provisional, cumulative, startup text, duplicate field sinks and incomplete processors fail with reasons', () => {
  const preview = voice(); preview.edges[1].from[1] = 'provisional'; assert.match(webVoiceError(preview), /committed/);
  const cumulative = voice(); cumulative.nodes.push(graphNode('TextAccumulator', 'sum'));
  cumulative.edges[1] = edge('asr', 'final', 'sum', 'append'); cumulative.edges.push(edge('sum', 'text', 'field', 'text')); assert.match(webVoiceError(cumulative), /snapshots/);
  const startup = voice(); startup.nodes.push(graphNode('TextFormatter', 'fmt'), graphNode('Text', 'constant'));
  startup.edges[1] = edge('asr', 'final', 'fmt', 'input1'); startup.edges.push(edge('constant', 'value', 'fmt', 'input2'), edge('fmt', 'text', 'field', 'text')); assert.match(webVoiceError(startup), /startup text/);
  const duplicate = voice(); duplicate.nodes.push(graphNode('FocusedInputTextOutputNode', 'second')); duplicate.edges.push(edge('asr', 'final', 'second', 'text')); assert.match(webVoiceError(duplicate), /one executable/);
  const incomplete = voice(); incomplete.nodes.push(graphNode('IfCondition', 'gate'));
  incomplete.edges[1] = edge('gate', 'yes', 'field', 'text'); assert.ok(webVoiceError(incomplete));
});

test('existing ASRs, translation, formatting, batching and summary processors retain typed graph flexibility', () => {
  for (const type of ['SpeechToTextReazonSpeech', 'SpeechToTextWhisper', 'SpeechToTextZipformerEn', 'SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn']) {
    const graph = voice(); graph.nodes[1] = graphNode(type, 'asr'); assert.equal(webVoiceError(graph), '', type);
  }
  for (const [type, output] of [['OpusMtJaEn','text'], ['OpusMtEnJa','text'], ['TranslateGemmaJaEn','text'], ['TranslateGemmaEnJa','text'], ['TextWindow','text'], ['TextSummaryLfm2','summary'], ['TextSummaryQwen35','summary']]) {
    const graph = voice(); graph.nodes.push(graphNode(type,'processor'));
    graph.edges[1] = edge('asr','final','processor','text'); graph.edges.push(edge('processor',output,'field','text'));
    assert.equal(webVoiceError(graph), '', type);
    if (type.startsWith('TranslateGemma')) {
      graph.nodes.push(graphNode('Text','context')); graph.edges.push(edge('context','value','processor','context'));
      assert.equal(webVoiceError(graph), '', type + ' context');
    }
  }
});

test('choices validate the executable runtime; defaults migrate once and never choose arbitrarily', () => {
  const bad = voice(); bad.edges.pop();
  const library = { graphs: [{ id: 'a', name: 'A', graph: voice() }, { id: 'b', name: 'B', graph: voice() },
    { id: 'disconnected', name: 'Voice', graph: bad }, { id: 'invalid', name: 'Microphone', graph: { version: 999 } },
    { id: 'live', name: 'Dictation', graph: defaultGraph() }] };
  const choices = webVoiceChoices(library);
  assert.deepEqual(choices.map(choice => choice.id), ['a', 'b']);
  assert.equal(webVoiceDefault(choices, undefined, 'b'), 'b');
  assert.equal(webVoiceDefault(choices, undefined, 'invalid'), null);
  assert.equal(webVoiceDefault(choices, null, 'b'), null);
  assert.equal(webVoiceDefault(choices, 'deleted', 'b'), null);
  assert.equal(webVoiceDefault(choices, 'a', 'b'), 'a');
  assert.equal(webVoiceDefault(choices.slice(1), 'deleted', 'a'), 'b');
  assert.equal(webVoiceDefault([], 'a', 'a'), null);
  library.graphs[0].graph.edges.length = 0;
  assert.equal(choices[0].graph.edges.length, 2);
});
