import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { SpeechToTextZipformerEnNode } from '../web/zipformer-node.js';
import { SpeechToTextMoonshineMediumEnNode } from '../web/moonshine-medium-node.js';
import { SpeechToTextWhisperNode } from '../web/whisper-node.js';
import { SpeechToTextParakeetV3Node } from '../web/parakeet-v3-node.js';

for (const Node of [SpeechToTextNode, SpeechToTextZipformerEnNode, SpeechToTextMoonshineMediumEnNode]) {
  test(`${Node.name}: final and preview clear are atomic; duplicate finals cannot erase newer preview`, () => {
    const emitted = [], node = new Node();
    node.context = { signal: new AbortController().signal, emit: (port, value) => emitted.push({ [port]: value }), emitOutputs: values => emitted.push(values) };
    node.receiveEvent({ type: 'partial', id: 0, text: 'preview' });
    node.receiveEvent({ type: 'final', id: 0, text: 'same' });
    node.receiveEvent({ type: 'partial', id: 1, text: 'newer' });
    node.receiveEvent({ type: 'final', id: 0, text: 'same' });
    const a = emitted[0].provisionalId, b = emitted[2].provisionalId;
    assert.ok(Number.isSafeInteger(a)); assert.notEqual(a, b);
    assert.deepEqual(emitted, [{ provisional: 'preview', provisionalId: a }, { provisional: '', provisionalId: a, final: 'same', finalId: a }, { provisional: 'newer', provisionalId: b }]);
    node.receiveEvent({ type: 'final', id: 1, text: 'same' });
    node.receiveEvent({ type: 'final', id: 2, text: '' });
    assert.deepEqual(emitted.slice(-2), [{ provisional: '', provisionalId: b, final: 'same', finalId: b }, { provisional: '', provisionalId: emitted.at(-1).finalId, final: '', finalId: emitted.at(-1).finalId }]);
    node.dispose(); node.receiveEvent({ type: 'final', id: 3, text: 'late' }); assert.equal(emitted.length, 5);
  });
}
for (const Node of [SpeechToTextWhisperNode, SpeechToTextParakeetV3Node]) {
  test(`${Node.name}: final-only ASR never emits an undeclared preview`, () => {
    const emitted = [], node = new Node(); node.context = { signal: new AbortController().signal, emitOutputs: values => emitted.push(values) };
    node.receiveEvent({ type: 'final', id: 0, text: 'same' }); node.receiveEvent({ type: 'final', id: 1, text: 'same' });
    assert.deepEqual(emitted.map(({final}) => final), ['same', 'same']); assert.notEqual(emitted[0].finalId, emitted[1].finalId); assert.ok(emitted.every(value => Object.keys(value).sort().join() === 'final,finalId')); node.dispose();
  });
}
