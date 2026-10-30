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

// Exercise the production producer lifecycle through the complete explicit DOM
// composition, including cancellation cleanup over multiple processor queues.
import { Pipeline } from '../web/pipeline.js';
import { TextAccumulatorNode, LiveTextDisplayNode } from '../web/text-nodes.js';
import { TextToDOMNode, DOMCombinerNode } from '../web/dom-nodes.js';
import { edge } from '../extension/graph.js';
import { domText } from './fixtures/dom.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const Node of [SpeechToTextNode, SpeechToTextZipformerEnNode]) {
  for (const operation of ['stop', 'cancel']) {
    test(`${Node.name}: worker failure clears preview and ${operation} preserves committed text in both displays`, async () => {
      const workers = [], displays = {}, acc = new TextAccumulatorNode();
      const speech = new Node({ workerFactory() {
        const worker = { postMessage() {}, terminate() { this.terminated = true; } };
        workers.push(worker); return worker;
      } });
      const pipeline = new Pipeline({ nodes: { speech, acc, history: new TextToDOMNode(), preview: new TextToDOMNode(), combined: new DOMCombinerNode(),
        one: new LiveTextDisplayNode(dom => displays.one = dom), two: new LiveTextDisplayNode(dom => displays.two = dom) }, connections: [
        edge('speech', 'final', 'acc', 'append'), edge('acc', 'text', 'history', 'text'), edge('speech', 'provisional', 'preview', 'text'),
        edge('history', 'dom', 'combined', 'first'), edge('preview', 'dom', 'combined', 'second'),
        edge('combined', 'dom', 'one', 'dom'), edge('combined', 'dom', 'two', 'dom'),
      ] });
      try {
        const loading = speech.load();
        workers.forEach(worker => worker.onmessage({ data: { type: 'ready' } }));
        await loading; await pipeline.start();
        speech.receiveEvent({ type: 'final', id: 0, text: 'committed' });
        speech.receiveEvent({ type: 'partial', id: 1, text: 'uncommitted' }); await tick();
        for (const display of Object.values(displays)) assert.equal(domText(display), 'committeduncommitted');
        workers[0].onerror({ preventDefault() {}, message: 'controlled worker failure' }); await tick();
        assert.equal(pipeline.entries.get('speech').failed, true);
        for (const display of Object.values(displays)) assert.equal(domText(display), 'committed');
        if (operation === 'stop') await assert.rejects(pipeline.stop(), AggregateError);
        else await pipeline.cancel();
        speech.receiveEvent({ type: 'partial', id: 1, text: 'late preview' });
        speech.receiveEvent({ type: 'final', id: 1, text: 'late final' }); await tick();
        for (const display of Object.values(displays)) assert.equal(domText(display), 'committed');
        assert.equal(acc.committed, 'committed'); assert.equal(acc.count, 1);
        assert.equal(pipeline.errors.length, 1); assert.match(pipeline.errors[0].message, /controlled worker failure/);
        assert.ok(workers.every(worker => worker.terminated));
      } finally { await pipeline.dispose(); }
    });
  }
}
for (const operation of ['stop', 'cancel']) for (const reverse of [false, true]) {
  test(`explicit history/tail composition: ${operation}, reverse routes=${reverse}, late/empty/repeated updates and two displays`, async () => {
    const speech = new SpeechToTextZipformerEnNode(), acc = new TextAccumulatorNode(), displays = {};
    speech.core = { state: 'ready', load() { speech.receiveEvent({ type: 'ready' }); }, start() {}, stop() { speech.receiveEvent({ type: 'stopped' }); }, release() {} };
    const routes = [edge('speech', 'final', 'acc', 'append'), edge('acc', 'text', 'history', 'text'), edge('speech', 'provisional', 'preview', 'text'),
      edge('history', 'dom', 'combined', 'first'), edge('preview', 'dom', 'combined', 'second'), edge('combined', 'dom', 'one', 'dom'), edge('combined', 'dom', 'two', 'dom')];
    const pipeline = new Pipeline({ nodes: { speech, acc, history: new TextToDOMNode(), preview: new TextToDOMNode(), combined: new DOMCombinerNode(),
      one: new LiveTextDisplayNode(dom => displays.one = dom), two: new LiveTextDisplayNode(dom => displays.two = dom) }, connections: reverse ? routes.reverse() : routes });
    await pipeline.start(); await tick();
    const event = (type, id, text) => speech.receiveEvent({ type, id, text });
    event('partial', 0, 'old'); event('partial', 0, 'replacement'); await tick();
    assert.equal(domText(displays.one), 'replacement'); assert.equal(acc.committed, '');
    event('final', 0, 'same'); event('partial', 0, 'late closed preview'); await tick();
    assert.equal(domText(displays.one), 'same');
    event('partial', 1, 'next'); event('final', 0, 'duplicate'); await tick();
    assert.equal(domText(displays.one), 'samenext');
    event('partial', 1, ''); event('partial', 1, 'next'); event('final', 1, 'same'); event('final', 2, '');
    event('partial', 2, 'late empty final preview'); event('final', 2, ''); await tick();
    assert.equal(acc.committed, 'same\nsame\n'); assert.equal(acc.count, 3);
    assert.equal(domText(displays.one), 'same\nsame\n');
    event('partial', 3, 'discard at end'); await tick();
    assert.equal(pipeline.entries.get('combined').node.snapshots.second.textContent, 'discard at end');
    await pipeline[operation]();
    assert.equal(domText(displays.one), 'same\nsame\n'); assert.equal(domText(displays.two), 'same\nsame\n');
    event('partial', 3, 'late after end'); event('final', 3, 'late'); await tick();
    assert.equal(domText(displays.one), 'same\nsame\n'); assert.equal(acc.committed, 'same\nsame\n');
    assert.equal(Object.hasOwn(acc, 'preview'), false); assert.deepEqual(pipeline.errors, []);
    await pipeline.dispose();
  });
}
