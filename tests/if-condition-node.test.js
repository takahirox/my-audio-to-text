import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { TEXT } from '../web/port-contracts.js';
import { IfConditionNode } from '../web/if-condition-node.js';

test('IfCondition routes each input to exactly one named port, preserving original text', async () => {
  const yes = [], no = [];
  const source = { inputs: {}, outputs: { text: TEXT }, start(ctx) { this.ctx = ctx; } };
  const condition = new IfConditionNode({
    condition: 'The user requests a refund.',
    threshold: 0.6,
    decide: async text => text.startsWith('Refund') ? 0.9 : 0.1,
  });
  const sink = values => ({ inputs: { text: TEXT }, outputs: {}, receive(_port, value) { values.push(value); } });
  const pipeline = new Pipeline({
    nodes: { source, condition, yes: sink(yes), no: sink(no) },
    connections: [
      { from: ['source', 'text'], to: ['condition', 'text'] },
      { from: ['condition', 'yes'], to: ['yes', 'text'] },
      { from: ['condition', 'no'], to: ['no', 'text'] },
    ],
  });
  await pipeline.start();
  source.ctx.emit('text', 'Refund my order.');
  source.ctx.emit('text', 'Hello.');
  source.ctx.emit('text', 'Refund my order.');
  await pipeline.stop();
  assert.deepEqual(yes, ['Refund my order.', 'Refund my order.']);
  assert.deepEqual(no, ['Hello.']);
  await pipeline.dispose();
});

test('IfCondition rejects malformed configuration or untrustworthy scores', async () => {
  assert.throws(() => new IfConditionNode({ condition: '', decide: () => 0.5 }), /condition/);
  assert.throws(() => new IfConditionNode({ condition: 'x', threshold: NaN, decide: () => 0.5 }), /threshold/);
  assert.throws(() => new IfConditionNode({ condition: 'x' }), /local inference backend/);
  const node = new IfConditionNode({ condition: 'x', decide: async () => NaN });
  await assert.rejects(() => node.receive('text', 'some text',
    { signal: new AbortController().signal, emit() { assert.fail('must not emit'); } }), /probability/);
});

test('IfCondition never emits after cancellation during asynchronous decision', async () => {
  const controller = new AbortController();
  let complete;
  const promise = new Promise(resolve => { complete = resolve; });
  const node = new IfConditionNode({ condition: 'x', decide: () => promise });
  const routed = [];
  const receive = node.receive('text', 'uncommitted', { signal: controller.signal, emit(port) { routed.push(port); } });
  controller.abort();
  complete(1);
  await assert.rejects(receive, /aborted/i);
  assert.deepEqual(routed, []);
});
