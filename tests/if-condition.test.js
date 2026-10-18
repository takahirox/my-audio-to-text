import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IfConditionNode } from '../web/if-condition-node.js';
import { TEXT } from '../web/port-contracts.js';
import { Pipeline } from '../web/pipeline.js';
import { validateCondition, validateDecision, validateText } from '../web/if-condition-policy.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const workers = [];
  const workerFactory = () => {
    const worker = { messages: [], terminate() { this.terminated = true; },
      reply(data) { this.onmessage?.({ data }); },
      postMessage(data) {
        this.messages.push(data);
        if (options.hold?.(data)) return;
        queueMicrotask(() => this.reply({ id: data.id, type: { load: 'ready', decide: 'result', drain: 'drained' }[data.type],
          ...(data.type === 'decide' ? options.decide?.(data, this) || { branch: data.text.includes('?') ? 'yes' : 'no', confidence: .9 } : {}) }));
      } };
    workers.push(worker); return worker;
  };
  return { workers, workerFactory };
}
function graph(options = {}, nodeOptions = {}) {
  const f = fixture(options), values = [], errors = [];
  const source = { inputs: {}, outputs: { text: TEXT }, start(context) { this.send = text => context.emit('text', text); } };
  const node = new IfConditionNode({ workerFactory: f.workerFactory, ...nodeOptions });
  const sink = branch => ({ inputs: { text: TEXT }, outputs: {}, receive(_, text) { values.push([branch, text]); } });
  const pipeline = new Pipeline({ nodes: { source, node, yes: sink('yes'), no: sink('no'), peer: sink('peer') }, connections: [
    { from: ['source', 'text'], to: ['node', 'text'] }, { from: ['node', 'yes'], to: ['yes', 'text'] },
    { from: ['node', 'no'], to: ['no', 'text'] }, { from: ['source', 'text'], to: ['peer', 'text'] },
  ], onError: error => errors.push(error) });
  return { ...f, pipeline, source, node, values, errors };
}

test('IfCondition preserves repeated/empty/Unicode TEXT and emits exactly one ordered branch; Stop drains and releases', async () => {
  const f = graph(); await f.pipeline.start();
  const texts = ['  Hello?\n', 'no', '  Hello?\n', '', '  \n', '日本語🌏?'];
  for (const text of texts) f.source.send(text);
  await f.pipeline.stop();
  assert.deepEqual(f.values.filter(([branch]) => branch !== 'peer'), texts.map(text => [text.includes('?') ? 'yes' : 'no', text]));
  assert.deepEqual(f.values.filter(([branch]) => branch === 'peer').map(([,text]) => text), texts);
  assert.equal(f.workers[0].messages.filter(m => m.type === 'decide').length, 4);
  assert.equal(f.workers[0].messages.at(-1).type, 'drain');
  assert.ok(f.workers.every(w => w.terminated)); await f.pipeline.dispose();
});

test('independent instances carry independent conditions, queues and worker IDs', async () => {
  const f = fixture(); const outputs = [[], []];
  const nodes = ['Does this ask a question?', 'Is the text positive?'].map(condition => new IfConditionNode({ condition, workerFactory: f.workerFactory }));
  await Promise.all(nodes.map((node, i) => node.start({ signal: new AbortController().signal, emit: (port,text) => outputs[i].push([port,text]), fail: error => { throw error; } })));
  nodes[0].receive('text', 'A?'); nodes[1].receive('text', 'B');
  await Promise.all(nodes.map(node => node.stop()));
  assert.deepEqual(f.workers.map(w => w.messages[0].condition), ['Does this ask a question?', 'Is the text positive?']);
  assert.deepEqual(outputs, [[['yes','A?']], [['no','B']]]);
});

for (const duringStop of [false, true]) test(`Cancel ${duringStop ? 'during Stop' : 'during inference'} discards queued jobs, terminates and ignores old callbacks after restart`, async () => {
  const f = graph({ hold: data => data.type === 'decide' }); await f.pipeline.start();
  f.source.send('old?'); f.source.send('pending?'); await tick();
  const callback = f.workers[0].onmessage;
  const stopping = duringStop ? f.pipeline.stop() : Promise.resolve();
  await f.pipeline.dispose(); await stopping;
  callback({ data: { type: 'result', id: 2, branch: 'yes', confidence: 1 } });
  assert.deepEqual(f.values.filter(([b]) => b !== 'peer'), []); assert.ok(f.workers[0].terminated);
  const fresh = graph(); await fresh.pipeline.start(); fresh.source.send('new?'); await fresh.pipeline.stop();
  assert.deepEqual(fresh.values.filter(([b]) => b !== 'peer'), [['yes','new?']]); await fresh.pipeline.dispose();
});

test('Cancel during model load rejects pending requests, releases worker and cannot publish late ready', async () => {
  const f = graph({ hold: () => true }); const starting = f.pipeline.start(); await tick();
  const callback = f.workers[0].onmessage; await f.pipeline.dispose(); await assert.rejects(starting);
  callback({ data: { type: 'ready', id: 1 } }); assert.ok(f.workers[0].terminated); assert.equal(f.node.pending.size, 0);
});

for (const result of [{ branch: 'yes', confidence: .5 }, { branch: 'both', confidence: 1 }, { type: 'error', message: 'inference failed' }]) {
  test(`invalid/uncertain/failing inference reports an error and never fabricates a branch: ${JSON.stringify(result)}`, async () => {
    const f = graph({ decide: () => result }); await f.pipeline.start(); f.source.send('valid input'); await tick();
    assert.equal(f.errors.length, 1); assert.ok(f.workers[0].terminated);
    assert.deepEqual(f.values, [['peer', 'valid input']]); await assert.rejects(f.pipeline.stop()); await f.pipeline.dispose();
  });
}
for (const type of ['load', 'decide', 'drain']) test(`${type} timeout terminates the Worker with a visible error`, async () => {
  const f = graph({ hold: data => data.type === type }, { loadTimeoutMs: 10, decisionTimeoutMs: 10 });
  if (type === 'load') await assert.rejects(f.pipeline.start());
  else {
    await f.pipeline.start(); if (type === 'decide') f.source.send('pending');
    await assert.rejects(f.pipeline.stop());
  }
  assert.match(f.errors[0].message, /timed out/); assert.ok(f.workers[0].terminated); await f.pipeline.dispose();
});

test('bounded queue fails visibly on input count or total chars; no pending text leaks', async () => {
  for (const [text,count] of [['x',33],['x'.repeat(2048),17]]) {
    const f = graph({ hold: data => data.type === 'decide' }); await f.pipeline.start();
    for (let i=0;i<count;i++) f.node.receive('text',text);
    assert.match(f.errors[0].message,/backlog/); assert.equal(f.node.jobs.length,0); assert.equal(f.node.pending.size,0);
    assert.ok(f.workers[0].terminated); await f.pipeline.dispose();
  }
});

test('condition, text and numeric decision bounds reject invalid inputs without truncation', () => {
  for (const condition of ['', '  ', null, 'x'.repeat(513)]) assert.throws(() => validateCondition(condition));
  for (const text of [null, {}, 1, 'x'.repeat(2049)]) assert.throws(() => validateText(text));
  assert.doesNotThrow(() => validateText('')); assert.doesNotThrow(() => validateCondition('x'.repeat(512)));
  for (const confidence of [NaN, Infinity, -1, 1.1]) assert.throws(() => validateDecision({ branch: 'yes', confidence }));
});

test('crashed worker and wrong reply fail only once; unknown IDs cannot satisfy a pending request', async () => {
  const f = graph({ hold: data => data.type === 'decide' }); await f.pipeline.start(); f.source.send('text'); await tick();
  f.workers[0].reply({ id: 999, type: 'result', branch: 'yes', confidence: 1 });
  assert.equal(f.node.pending.size,1);
  f.workers[0].reply({ id: 2, type: 'ready' }); await tick(); assert.equal(f.errors.length,1);
  assert.match(f.errors[0].message,/Unexpected/); await f.pipeline.dispose();
  const crash = graph(); await crash.pipeline.start(); crash.workers[0].onerror({ message: 'crash' });
  assert.equal(crash.errors.length,1); assert.ok(crash.workers[0].terminated); await crash.pipeline.dispose();
});

test('queued inputs wait for model load and Stop drains them in order without accepting new input', async () => {
  const f = fixture({ hold: data => data.type === 'load' }), values = [], failures = [];
  const node = new IfConditionNode({ workerFactory: f.workerFactory });
  const start = node.start({ signal: new AbortController().signal, emit: (port,text) => values.push([port,text]), fail: error => failures.push(error) });
  node.receive('text','first?'); node.receive('text','second');
  await tick(); assert.deepEqual(values,[]);
  const stop = node.stop(); node.receive('text','after Stop');
  f.workers[0].reply({type:'ready',id:1});await start;await stop;
  assert.deepEqual(values,[['yes','first?'],['no','second']]); assert.deepEqual(failures,[]); assert.ok(f.workers[0].terminated);
});
