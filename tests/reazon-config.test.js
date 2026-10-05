import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REAZON_NUM_THREADS, supportedReazonThreads, selectReazonThreads } from '../web/reazon-config.js';

const desktop = { hardwareConcurrency: 16, crossOriginIsolated: true, sharedMemory: true };
test('ReazonSpeech selection stays within browser cores and the pinned runtime pool', () => {
  assert.deepEqual(supportedReazonThreads(desktop), [1, 2, 4]);
  assert.equal(selectReazonThreads(desktop), REAZON_NUM_THREADS);
  for (const [hardwareConcurrency, counts] of [[1, [1]], [2, [1, 2]], [3, [1, 2]], [4, [1, 2, 4]], [undefined, [1]], [0, [1]], [NaN, [1]]]) {
    const environment = { ...desktop, hardwareConcurrency };
    assert.deepEqual(supportedReazonThreads(environment), counts);
    assert.ok(counts.includes(selectReazonThreads(environment)));
    for (const count of [1, 2, 4]) {
      if (counts.includes(count)) assert.equal(selectReazonThreads(environment, count), count);
      else assert.throws(() => selectReazonThreads(environment, count), /Unsupported ReazonSpeech/);
    }
  }
});
test('unavailable isolation or shared runtime memory restricts selection to one', () => {
  for (const environment of [{ ...desktop, crossOriginIsolated: false }, { ...desktop, sharedMemory: false }]) {
    assert.deepEqual(supportedReazonThreads(environment), [1]);
    assert.equal(selectReazonThreads(environment), 1);
    assert.throws(() => selectReazonThreads(environment, 2), /Unsupported ReazonSpeech/);
  }
  for (const count of [0, 3, 8, -1, 1.5, '2', null]) assert.throws(() => selectReazonThreads(desktop, count), /Unsupported ReazonSpeech/);
});

test('the committed default follows the raw timing and transcript evidence in both browsers', () => {
  const evidence = ['chromium', 'webkit'].map(browser => JSON.parse(readFileSync(new URL(`../docs/evidence/reazon-38-${browser}.json`, import.meta.url))));
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[2] + sorted[3]) / 2;
  };
  for (const record of evidence) {
    assert.equal(record.method.minimumImprovement, 0.10);
    assert.deepEqual(record.results.map(r => r.numThreads), [1, 2, 4]);
    const baseline = record.results.find(r => r.numThreads === 1);
    assert.equal(baseline.status, 'tested');
    for (const result of record.results.filter(r => r.status === 'tested')) {
      assert.equal(result.runtime.sharedMemory, true);
      assert.ok(result.numThreads <= record.environment.hardwareConcurrency);
      for (let i = 0; i < result.fixtures.length; i++) {
        const fixture = result.fixtures[i], transcript = baseline.fixtures[i].transcripts[0];
        assert.equal(fixture.timingsMs.length, 6);
        assert.equal(fixture.transcripts.length, 6);
        assert.equal(fixture.warmups.length, 2);
        assert.ok(fixture.timingsMs.every(ms => Number.isFinite(ms) && ms > 0));
        assert.ok([...fixture.transcripts, ...fixture.warmups.map(r => r.text)].every(text => text === transcript));
      }
    }
  }
  // A global default must meet the threshold on both inputs in every recorded
  // browser. Recompute from raw samples rather than trusting summary fields.
  const selected = [2, 4].find(count => evidence.every(record => {
    const candidate = record.results.find(r => r.numThreads === count);
    const baseline = record.results.find(r => r.numThreads === 1);
    return candidate.status === 'tested' && candidate.fixtures.every((f, i) => median(f.timingsMs) <= 0.9 * median(baseline.fixtures[i].timingsMs));
  })) ?? 1;
  assert.equal(REAZON_NUM_THREADS, selected);
});
