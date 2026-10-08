import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { Resampler } from '../../web/audio.js';
import { REAZON_NUM_THREADS, REAZON_THREAD_COUNTS, supportedReazonThreads } from '../../web/reazon-config.js';

const audioURL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/ja.wav';
const audioSHA256 = '780f95a86ba6cc33a4431fcafeacd213417dfa0a6613f93e4400c18f4dd467b0';
const minimumImprovement = 0.10;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

test('deterministic ReazonSpeech ja-en thread comparison on Japanese audio', async ({ page, browser }, testInfo) => {
  test.skip(!process.env.ASR_BENCHMARK, 'Run npm run benchmark:reazon after preparing runtime assets.');
  test.setTimeout(600000);
  const wav = readFileSync(new URL('../../.cache/reazon-ja.wav', import.meta.url));
  expect(createHash('sha256').update(wav).digest('hex')).toBe(audioSHA256);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  let rate, samples;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      expect(wav.readUInt16LE(offset + 8)).toBe(1);
      expect(wav.readUInt16LE(offset + 10)).toBe(1);
      expect(wav.readUInt16LE(offset + 22)).toBe(16);
      rate = wav.readUInt32LE(offset + 12);
    }
    if (id === 'data') samples = Float32Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(offset + 8 + i * 2) / 32768);
    offset += 8 + size + size % 2;
  }
  const audio = new Resampler(rate).push(samples);
  const fixtures = [
    { name: 'provisional-2s', audio: Array.from(audio.slice(0, 32000)) },
    { name: 'whole-utterance', audio: Array.from(audio) },
  ];
  // Instrument only recognizer.decode inside the actual worker. The existing
  // recognize(), stream cleanup, model and greedy transcript path are retained.
  const source = readFileSync(new URL('../../web/sherpa-worker.js', import.meta.url), 'utf8');
  await page.context().route('**/sherpa-worker.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: source + `
      const originalLoad = load;
      load = async (...args) => {
        await originalLoad(...args);
        const decode = recognizer.decode.bind(recognizer);
        recognizer.decode = stream => {
          const start = performance.now();
          try { return decode(stream); }
          finally { send('benchmark-timing', {decodeMs: performance.now() - start}); }
        };
        send('benchmark-runtime', {
          crossOriginIsolated: self.crossOriginIsolated,
          hardwareConcurrency: self.navigator.hardwareConcurrency,
          sharedMemory: self.Module.HEAPU8.buffer instanceof SharedArrayBuffer,
        });
      };`,
  }));
  await page.goto('./nodes/speech-to-text/'); await expect(page.locator('#load')).toBeEnabled();
  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated, sharedMemory: typeof SharedArrayBuffer !== 'undefined',
  }));
  const headers = (await page.request.get('/')).headers();
  environment.isolationHeaders = { coop: headers['cross-origin-opener-policy'] ?? null, coep: headers['cross-origin-embedder-policy'] ?? null };
  const supported = supportedReazonThreads(environment);
  const results = REAZON_THREAD_COUNTS.map(numThreads => ({
    numThreads, status: supported.includes(numThreads) ? 'pending' : 'unsupported',
    reason: supported.includes(numThreads) ? undefined : 'Browser isolation/shared-memory/core capacity',
    fixtures: fixtures.map(f => ({ name: f.name, samples: f.audio.length, timingsMs: [], transcripts: [] })),
  }));
  // Two opposite sweeps reduce candidate-order bias. One warm-up per input per
  // fresh worker; three measured runs per input per sweep (six total).
  for (const order of [supported, [...supported].reverse()]) {
    for (const numThreads of order) {
      const entry = results.find(r => r.numThreads === numThreads);
      if (entry.status === 'failed') continue;
      const measured = await page.evaluate(async ({ numThreads, fixtures }) => {
        const worker = new Worker('../../sherpa-worker.js');
        let resolve, reject, text, decodeMs, actualThreads, runtime;
        worker.onerror = e => reject(new Error(e.message));
        worker.onmessage = ({ data }) => {
          if (data.type === 'error') reject(new Error(data.message));
          if (data.type === 'configuration') actualThreads = data.numThreads;
          if (data.type === 'benchmark-runtime') runtime = data;
          if (data.type === 'benchmark-timing') decodeMs = data.decodeMs;
          if (data.type === 'partial') text = data.text;
          if (['ready', 'decoded'].includes(data.type)) resolve({ text, decodeMs });
        };
        const request = message => new Promise((yes, no) => {
          const timer = setTimeout(() => no(new Error(`ReazonSpeech ${message.type} timed out`)), 120000);
          resolve = result => { clearTimeout(timer); yes(result); };
          reject = error => { clearTimeout(timer); no(error); };
          text = decodeMs = undefined; worker.postMessage(message);
        });
        try {
          await request({ type: 'load', numThreads });
          const runs = fixtures.map(() => ({ timingsMs: [], transcripts: [], warmup: null }));
          for (let i = 0; i < fixtures.length; i++) runs[i].warmup = await request({ type: 'decode', audio: Float32Array.from(fixtures[i].audio), session: 1 });
          for (let round = 0; round < 3; round++) {
            for (let i = 0; i < fixtures.length; i++) {
              const result = await request({ type: 'decode', audio: Float32Array.from(fixtures[i].audio), session: 1 });
              runs[i].timingsMs.push(result.decodeMs); runs[i].transcripts.push(result.text);
            }
          }
          return { actualThreads, runtime, runs };
        } catch (error) { return { error: error.message }; }
        finally { worker.terminate(); }
      }, { numThreads, fixtures });
      if (measured.error) {
        entry.status = 'failed'; entry.reason = measured.error;
        console.log(`${testInfo.project.name}: ${numThreads} thread(s) unavailable: ${measured.error}`);
        continue;
      }
      expect(measured.actualThreads).toBe(numThreads);
      expect(measured.runtime.sharedMemory).toBe(true);
      entry.status = 'tested'; entry.runtime = measured.runtime;
      for (let i = 0; i < fixtures.length; i++) {
        const result = entry.fixtures[i], run = measured.runs[i];
        result.timingsMs.push(...run.timingsMs); result.transcripts.push(...run.transcripts);
        (result.warmups ??= []).push(run.warmup);
      }
      console.log(`${testInfo.project.name}: ${numThreads} thread(s), ${JSON.stringify(measured.runs.map(r => r.timingsMs))}`);
    }
  }
  const baseline = results.find(r => r.numThreads === 1);
  expect(baseline.status).toBe('tested');
  for (const entry of results.filter(r => r.status === 'tested')) {
    for (let i = 0; i < fixtures.length; i++) {
      const f = entry.fixtures[i];
      f.medianMs = median(f.timingsMs);
      f.improvement = 1 - f.medianMs / median(baseline.fixtures[i].timingsMs);
      f.equivalentTranscript = [...f.transcripts, ...f.warmups.map(r => r.text)].every(text => text === baseline.fixtures[i].transcripts[0]);
    }
  }
  const selected = results.find(r => r.status === 'tested' && r.numThreads > 1 && r.fixtures.every(f => f.equivalentTranscript && f.improvement >= minimumImprovement))?.numThreads ?? 1;
  const evidence = {
    recordedAt: new Date().toISOString(), issue: 45, threadPolicyIssue: 38,
    environment: { ...environment, browser: testInfo.project.name, browserVersion: browser.version(), os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0].model, logicalCores: os.cpus().length, memoryBytes: os.totalmem(), node: process.version },
    runtime: JSON.parse(readFileSync(new URL('../../web/vendor/manifest.json', import.meta.url)))['sherpa-ja-en'],
    audio: { source: audioURL, sha256: audioSHA256, sourceRate: rate, rate: 16000, resampler: 'web/audio.js Resampler', pcmFloat32SHA256: createHash('sha256').update(new Uint8Array(audio.buffer)).digest('hex') },
    method: { metric: 'recognizer.decode only; excludes model load, transfer, stream creation and result extraction', sweeps: ['ascending', 'descending'], warmupsPerFixturePerSweep: 1, measuredRunsPerFixture: 6, minimumImprovement, selection: 'smallest supported count with identical transcripts and >=10% median improvement on BOTH inputs, otherwise 1' },
    results, selectedNumThreads: selected, configuredNumThreadsAtMeasurement: REAZON_NUM_THREADS,
  };
  const evidencePath = testInfo.outputPath('reazon-threads.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  await testInfo.attach('reazon-threads.json', { path: evidencePath, contentType: 'application/json' });
  console.log(`${testInfo.project.name}: recommended ${selected} thread(s); configured ${REAZON_NUM_THREADS}`);
  for (const entry of results.filter(r => r.status === 'tested')) {
    for (const f of entry.fixtures) {
      expect(f.timingsMs).toHaveLength(6);
      expect(f.timingsMs.every(ms => Number.isFinite(ms) && ms > 0)).toBe(true);
      expect(f.equivalentTranscript).toBe(true);
    }
  }
  expect(baseline.fixtures[1].transcripts[0]).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
});
