import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resampler } from '../web/audio.js';

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
