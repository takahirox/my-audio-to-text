import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReazonSimulation, PRE_ROLL, PREVIEW_INTERVAL, TRAILING_SILENCE, MAX_SPEECH, BUFFER_LIMIT } from '../web/reazon-simulation.js';
import { joinAudio } from '../web/audio.js';

function fixture() {
  const requests = [], events = []; let drained = 0;
  const simulation = new ReazonSimulation(message => requests.push(message), () => drained++, event => events.push(event));
  const finish = () => { while (simulation.inFlight) simulation.decoded(); };
  return { simulation, requests, events, finish, drained: () => drained };
}
const samples = (n, offset = 0) => Float32Array.from({ length: n }, (_, i) => (i + offset + 1) / 1000000);

test('silence is bounded pre-roll and never produces a decode, including Stop', () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) f.simulation.push(new Float32Array(2048), false);
  assert.equal(f.simulation.preRoll.length, PRE_ROLL);
  assert.equal(f.simulation.waiting, 0);
  f.simulation.stop(); f.simulation.stop();
  assert.deepEqual(f.requests, []); assert.equal(f.drained(), 1);
});

for (const available of [123, PRE_ROLL, PRE_ROLL * 2]) {
  test(`speech prepends the last available pre-roll (${available} samples)`, () => {
    const f = fixture(), before = samples(available), speech = samples(9000, available);
    f.simulation.push(before, false); f.simulation.push(speech, true);
    f.simulation.stop(); f.finish();
    const final = f.requests.find(item => item.final);
    assert.deepEqual(final.audio, joinAudio([before.slice(-PRE_ROLL), speech]));
    assert.deepEqual(f.events, ['started', 'completed']);
  });
}

test('0.5-second eligibility excludes pre-roll and coalesces slow provisional work', () => {
  const f = fixture(); f.simulation.push(samples(PRE_ROLL), false);
  f.simulation.push(samples(PREVIEW_INTERVAL - 1), true); assert.equal(f.requests.length, 0);
  f.simulation.push(samples(1), true); assert.equal(f.requests.length, 1);
  for (let i = 0; i < 8; i++) f.simulation.push(samples(PREVIEW_INTERVAL), true);
  assert.equal(f.requests.length, 1); assert.equal(f.simulation.finals.length, 0);
  f.simulation.decoded();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].audio.length, PRE_ROLL + 9 * PREVIEW_INTERVAL);
  f.simulation.decoded(); assert.equal(f.requests.length, 2);
});

test('0.35-second trailing silence finalizes complete audio; a short pause resets', () => {
  const f = fixture();
  const before = samples(PRE_ROLL), speech = samples(10000), shortPause = samples(5599), resumed = samples(17), tail = samples(5600);
  f.simulation.push(before, false); f.simulation.push(speech, true);
  f.simulation.push(shortPause, false); assert.equal(f.simulation.finals.length, 0);
  f.simulation.push(resumed, true); f.simulation.push(tail.subarray(0, 5599), false);
  assert.equal(f.simulation.finals.length, 0);
  f.simulation.push(tail.subarray(5599), false);
  assert.equal(f.simulation.finals.length, 1);
  assert.equal(f.simulation.acceptsPartial(f.requests[0].id), false);
  f.finish();
  const finals = f.requests.filter(item => item.final);
  assert.equal(finals.length, 1);
  assert.deepEqual(finals[0].audio, joinAudio([before, speech, shortPause, resumed, tail]));
  assert.equal(TRAILING_SILENCE, 5600);
});

test('12 seconds of speech excludes pre-roll; forced boundaries lose or repeat no samples', () => {
  const f = fixture(), before = samples(PRE_ROLL), input = samples(25 * 16000 + 37);
  f.simulation.push(before, false);
  for (let offset = 0; offset < input.length; offset += 2048) {
    f.simulation.push(input.slice(offset, offset + 2048), true); f.finish();
  }
  f.simulation.stop(); f.finish();
  const finals = f.requests.filter(item => item.final);
  assert.deepEqual(finals.map(item => item.audio.length), [PRE_ROLL + MAX_SPEECH, MAX_SPEECH, 16037]);
  assert.deepEqual(joinAudio(finals.map(item => item.audio)), joinAudio([before, input]));
  assert.equal(f.simulation.waiting, 0); assert.equal(f.drained(), 1);
});

test('finals precede coalesced previews and Stop drains every active utterance once', () => {
  const f = fixture();
  f.simulation.push(samples(8000), true);
  f.simulation.push(samples(5600), false);
  f.simulation.push(samples(9000), true);
  assert.equal(f.requests.length, 1);
  f.simulation.decoded(); assert.equal(f.requests[1].final, true);
  f.simulation.decoded(); assert.equal(f.requests[2].final, false);
  assert.equal(f.requests[2].id, 2);
  f.simulation.stop(); f.finish();
  assert.deepEqual(f.requests.filter(item => item.final).map(item => item.audio.length), [13600, 9000]);
  assert.equal(f.drained(), 1);
});

test('buffer cap counts pending finals and a final in flight', () => {
  const f = fixture();
  f.simulation.push(samples(MAX_SPEECH), true); assert.equal(f.requests[0].final, true);
  f.simulation.push(samples(MAX_SPEECH), true);
  f.simulation.push(samples(6 * 16000), true);
  assert.equal(f.simulation.waiting, BUFFER_LIMIT);
  assert.throws(() => f.simulation.push(samples(1), true), /over 30 seconds behind/);
  assert.equal(f.requests.length, 1);
});

test('available pre-roll counts toward the cap when it becomes active audio', () => {
  const f = fixture();
  f.simulation.push(samples(MAX_SPEECH), true);
  f.simulation.push(samples(MAX_SPEECH), true);
  f.simulation.push(samples(PRE_ROLL), false);
  assert.throws(() => f.simulation.push(samples(6 * 16000), true), /over 30 seconds behind/);
  assert.equal(f.simulation.waiting, 2 * MAX_SPEECH);
});
