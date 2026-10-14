import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NumberNode } from '../web/number-node.js';
import { NUMBER } from '../web/port-contracts.js';
import { Pipeline } from '../web/pipeline.js';
import { maxDurationSamples } from '../web/local-asr-config.js';

test('Number is a reusable finite primitive source with no ASR units or positivity rule', async () => {
  for (const value of [0, -2, 1.2345, 42]) {
    const received = [], number = new NumberNode({ value });
    const pipeline = new Pipeline({ nodes: { number, sink: { inputs: { number: NUMBER }, outputs: {}, receive(port, value) { received.push(value); } } },
      connections: [{ from: ['number', 'value'], to: ['sink', 'number'] }] });
    await pipeline.start(); await pipeline.stop();
    assert.deepEqual(received, [value]); await pipeline.dispose();
  }
});

test('Number rejects nonfinite or nonnumeric constants; duration has its own supported range', () => {
  for (const value of [NaN, Infinity, -Infinity, null, '6', '']) assert.throws(() => new NumberNode({ value }), /finite number/);
  for (const value of [0, -1, 0.99, 12.0001, NaN, Infinity, -Infinity, null, undefined, '6']) assert.throws(() => maxDurationSamples(value), /1 to 12 seconds/);
  assert.equal(maxDurationSamples(6), 96000);
  assert.equal(maxDurationSamples(1), 16000);
  assert.equal(maxDurationSamples(1.234567), 19753);
  assert.equal(maxDurationSamples(12), 192000);
});
