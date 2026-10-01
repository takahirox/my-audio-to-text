import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resampler, Segmenter } from '../web/audio.js';

test('resampling preserves time and block continuity at 44.1 and 48 kHz', () => {
  for (const rate of [44100, 48000, 16000]) {
    const input = Float32Array.from({ length: rate * 2 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / rate));
    const whole = new Resampler(rate).push(input);
    const resampler = new Resampler(rate), blocks = [];
    for (let i = 0; i < input.length; i += 2048) blocks.push(...resampler.push(input.slice(i, i + 2048)));
    assert.ok(Math.abs(blocks.length - 32000) <= 1);
    assert.equal(blocks.length, whole.length);
    blocks.forEach((sample, i) => assert.ok(Math.abs(sample - whole[i]) < 0.00001));
  }
});
test('offline segmentation retains quiet speech and Stop flushes the tail', () => {
  const segmenter = new Segmenter();
  const quiet = new Float32Array(16000).fill(0.001);
  assert.equal(segmenter.push(quiet), null);
  assert.deepEqual(segmenter.flush(), quiet);
  assert.equal(segmenter.flush(), null);
});
test('a pause finalizes speech without losing its ending', () => {
  const segmenter = new Segmenter();
  assert.equal(segmenter.push(new Float32Array(16000).fill(0.05)), null);
  const output = segmenter.push(new Float32Array(12800));
  assert.equal(output.length, 28800);
  assert.equal(output[15999], new Float32Array([0.05])[0]);
  assert.equal(segmenter.flush(), null);
});
test('long utterances split at 20 seconds without losing samples', () => {
  const segmenter = new Segmenter();
  for (let i = 0; i < 19; i++) assert.equal(segmenter.push(new Float32Array(16000).fill(0.05)), null);
  assert.equal(segmenter.push(new Float32Array(16000).fill(0.05)).length, 320000);
  assert.equal(segmenter.flush(), null);
});
