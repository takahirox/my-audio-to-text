import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode, TextOutputNode } from '../web/translation-nodes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(Node, respond = message => {
  if (message.type === 'load') return { type: 'ready' };
  if (message.type === 'translate') return { type: 'result', texts: [message.text + ' translated'] };
  return { type: 'drained' };
}) {
  const workers = [], output = [], errors = [];
  let context;
  const source = { outputs: { text: TEXT }, start(value) { context = value; } };
  const node = new Node({ workerFactory(url) {
    const worker = { url, messages: [], terminated: 0,
      postMessage(message) {
        this.messages.push(message);
        const response = respond(message);
        if (response) queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ...response } }));
      }, terminate() { this.terminated++; },
    };
    workers.push(worker); return worker;
  } });
  const pipeline = new Pipeline({ nodes: { source, node, sink: new TextOutputNode(text => output.push(text)) },
    connections: [
      { from: ['source', 'text'], to: ['node', 'text'] },
      { from: ['node', 'text'], to: ['sink', 'text'] },
    ], onError: error => errors.push(error.message),
  });
  return { pipeline, node, workers, output, errors, emit: value => context.emit('text', value) };
}

for (const Node of [OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode]) {
  test(`${Node.name}: typed ports, order, zero/multiple outputs and drain`, async () => {
    const f = fixture(Node, message => {
      if (message.type === 'load') return { type: 'ready' };
      if (message.type === 'drain') return { type: 'drained' };
      return { type: 'result', texts: message.text === 'zero' ? [] : [message.text, message.text + ' second'] };
    });
    assert.deepEqual(f.node.inputs, { text: TEXT }); assert.deepEqual(f.node.outputs, { text: TEXT });
    await f.pipeline.start();
    for (const text of [' ', 'one', 'zero', 'two']) f.emit(text);
    await f.pipeline.stop();
    assert.deepEqual(f.output, ['one', 'one second', 'two', 'two second']);
    assert.deepEqual(f.workers[0].messages.map(x => x.type), ['load', 'translate', 'translate', 'translate', 'drain']);
    assert.equal(f.workers[0].url.pathname.endsWith(Node === OpusMtTranslationNode ? '/opus-mt-worker.js' : Node === EnglishToJapaneseOpusMtTranslationNode ? '/opus-mt-en-ja-worker.js' : '/translategemma-worker.js'), true);
    await f.pipeline.dispose(); await f.pipeline.dispose();
    assert.equal(f.workers[0].terminated, 1);
  });
  test(`${Node.name}: Stop waits for asynchronous Worker output and sink`, async () => {
    const f = fixture(Node, message => message.type === 'translate' ? null : { type: message.type === 'load' ? 'ready' : 'drained' });
    await f.pipeline.start(); f.emit('one'); await tick();
    let stopped = false;
    const stopping = f.pipeline.stop().then(() => { stopped = true; });
    await tick(); assert.equal(stopped, false);
    const worker = f.workers[0], request = worker.messages.at(-1);
    worker.onmessage({ data: { type: 'result', id: request.id, texts: ['English'] } });
    await stopping; assert.deepEqual(f.output, ['English']); await f.pipeline.dispose();
  });
  for (const phase of ['load', 'translate', 'drain']) {
    test(`${Node.name}: cancel during ${phase} settles pending work, terminates and ignores stale output`, async () => {
      const f = fixture(Node, message => message.type === phase ? null : {
        type: message.type === 'load' ? 'ready' : message.type === 'translate' ? 'result' : 'drained', texts: ['old'],
      });
      const starting = f.pipeline.start();
      const observedStart = starting.catch(error => error);
      if (phase !== 'load') { await starting; f.emit('old'); }
      await tick();
      let stopping;
      if (phase === 'drain') { stopping = f.pipeline.stop(); await tick(); }
      const worker = f.workers[0], callback = worker.onmessage, id = worker.messages.at(-1).id;
      await f.pipeline.dispose();
      if (phase === 'load') assert.equal((await observedStart).name, 'AbortError');
      if (stopping) await stopping;
      callback({ data: { type: 'result', id, texts: ['stale'] } });
      assert.equal(worker.terminated, 1); assert.equal(f.node.pending.size, 0);
      assert.equal(f.output.includes('stale'), false);
      const next = fixture(Node); await next.pipeline.start(); next.emit('fresh');
      await next.pipeline.stop(); await next.pipeline.dispose();
      assert.deepEqual(next.output, ['fresh translated']);
    });
  }
  test(`${Node.name}: load/inference failure and invalid payload release resources`, async () => {
    const failedLoad = fixture(Node, () => ({ type: 'error', message: 'Offline cache miss' }));
    await assert.rejects(failedLoad.pipeline.start(), /Offline cache miss/);
    assert.equal(failedLoad.workers[0].terminated, 1);
    for (const response of [{ type: 'error', message: 'Inference failed' }, { type: 'result', texts: [42] }]) {
      const f = fixture(Node, message => message.type === 'translate' ? response : { type: 'ready' });
      await f.pipeline.start(); f.emit('test');
      await assert.rejects(f.pipeline.stop(), AggregateError);
      assert.equal(f.errors.length, 1); assert.deepEqual(f.output, []);
      assert.equal(f.workers[0].terminated, 1); await f.pipeline.dispose();
    }
    for (const value of [42, 'x'.repeat(1001)]) {
      const f = fixture(Node); await f.pipeline.start(); f.emit(value);
      await assert.rejects(f.pipeline.stop(), AggregateError);
      assert.deepEqual(f.output, []); await f.pipeline.dispose();
    }
  });
  test(`${Node.name}: Worker crash/postMessage failure reports once and releases`, async () => {
    const f = fixture(Node); await f.pipeline.start();
    f.workers[0].onerror({ message: 'Worker crashed' });
    await assert.rejects(f.pipeline.stop(), AggregateError);
    assert.match(f.errors[0], /Worker crashed/); assert.equal(f.errors.length, 1);
    assert.equal(f.workers[0].terminated, 1); await f.pipeline.dispose();
    const next = fixture(Node); await next.pipeline.start();
    next.workers[0].postMessage = () => { throw new Error('Message failure'); };
    next.emit('test'); await assert.rejects(next.pipeline.stop(), AggregateError);
    assert.match(next.errors[0], /Message failure/); await next.pipeline.dispose();
  });
}
