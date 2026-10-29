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
    assert.deepEqual(emitted, [{ provisional: 'preview' }, { provisional: '', final: 'same' }, { provisional: 'newer' }]);
    node.receiveEvent({ type: 'final', id: 1, text: 'same' });
    node.receiveEvent({ type: 'final', id: 2, text: '' });
    assert.deepEqual(emitted.slice(-2), [{ provisional: '', final: 'same' }, { provisional: '', final: '' }]);
    node.dispose(); node.receiveEvent({ type: 'final', id: 3, text: 'late' }); assert.equal(emitted.length, 5);
  });
}
for (const Node of [SpeechToTextWhisperNode, SpeechToTextParakeetV3Node]) {
  test(`${Node.name}: final-only ASR never emits an undeclared preview`, () => {
    const emitted = [], node = new Node(); node.context = { signal: new AbortController().signal, emit: (port, text) => emitted.push([port, text]) };
    node.receiveEvent({ type: 'final', id: 0, text: 'same' }); node.receiveEvent({ type: 'final', id: 1, text: 'same' });
    assert.deepEqual(emitted, [['final', 'same'], ['final', 'same']]); node.dispose();
  });
}
