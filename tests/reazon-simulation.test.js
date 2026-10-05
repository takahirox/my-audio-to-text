import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReazonSimulation } from '../web/reazon-simulation.js';
import { joinAudio } from '../web/audio.js';

test('simulated windows retain every sample across arbitrary block boundaries and Stop', () => {
  const requests = []; let drained = 0;
  const simulation = new ReazonSimulation(message => requests.push(message), () => drained++);
  const input = Float32Array.from({ length: 25 * 16000 + 37 }, (_, i) => i / 1000000);
  for (let offset = 0; offset < input.length; offset += 2048) {
    simulation.push(input.slice(offset, offset + 2048));
    while (simulation.inFlight) simulation.decoded();
  }
  simulation.stop();
  while (simulation.inFlight) simulation.decoded();
  const finals = requests.filter(message => message.final);
  assert.deepEqual(finals.map(message => message.audio.length), [160000, 160000, 80037]);
  assert.deepEqual(joinAudio(finals.map(message => message.audio)), input);
  assert.equal(simulation.waiting, 0);
  assert.equal(drained, 1);
});

test('buffer limit includes the final window currently being decoded', () => {
  const requests = [];
  const simulation = new ReazonSimulation(message => requests.push(message), () => {});
  simulation.push(new Float32Array(160000));
  assert.equal(requests[0].final, true);
  simulation.push(new Float32Array(320000));
  assert.equal(simulation.waiting, 480000);
  assert.throws(() => simulation.push(new Float32Array(1)), /over 30 seconds behind/);
  assert.equal(requests.length, 1);
});
