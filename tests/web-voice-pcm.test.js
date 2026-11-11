import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebVoicePCM } from '../extension/web-voice-pcm.js';

const message = (sequence, samples = [0, .25, -.5]) => ({ sequence, pcm: Buffer.from(new Float32Array(samples).buffer).toString('base64') });
test('PCM source feeds every MicrophoneAudio subscriber without changing float samples', () => {
  const pcm = new WebVoicePCM(), a = [], b = [];
  const first = pcm.source(audio => a.push([...audio])), second = pcm.source(audio => b.push([...audio]));
  assert.throws(() => pcm.receive(message(0)), /Stale/);
  first.start(); second.start(); pcm.receive(message(0));
  assert.deepEqual(a, [[0, .25, -.5]]); assert.deepEqual(b, a);
  first.stop(); pcm.receive(message(1)); assert.equal(a.length, 1); assert.equal(b.length, 2);
  second.stop(); assert.throws(() => pcm.receive(message(2)), /Stale/);
});
test('PCM rejects replay, gaps, malformed and oversized audio before graph delivery', () => {
  const pcm = new WebVoicePCM(); let delivered = 0; pcm.source(() => delivered++).start();
  pcm.receive(message(0));
  for (const invalid of [message(0), message(2), message(-1), message('1'),
    { sequence: 1, pcm: '' }, { sequence: 1, pcm: '!!!!' }, { sequence: 1, pcm: 'AA==' },
    message(1, new Array(1281).fill(0)), message(1, [NaN]), message(1, [Infinity])]) assert.throws(() => pcm.receive(invalid));
  assert.equal(delivered, 1); pcm.receive(message(1)); assert.equal(delivered, 2);
});
