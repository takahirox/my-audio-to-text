import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

function readWav(path) {
  const wav = readFileSync(path);
  const samples = [];
  let sampleRate, channels, bits;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      expect(wav.readUInt16LE(offset + 8)).toBe(1);
      channels = wav.readUInt16LE(offset + 10); sampleRate = wav.readUInt32LE(offset + 12); bits = wav.readUInt16LE(offset + 22);
    }
    if (id === 'data') for (let i = offset + 8; i < offset + 8 + size; i += 2) samples.push(wav.readInt16LE(i) / 32768);
    offset += 8 + size + size % 2;
  }
  expect([sampleRate, channels, bits]).toEqual([16000, 1, 16]);
  return samples;
}

// Opt-in integration check using caller-supplied Japanese 16 kHz mono PCM WAV.
// Nothing is uploaded: bytes are transferred directly to the browser worker.
for (const backend of ['moonshine', 'sherpa', 'whisper', 'two-pass']) {
  test(`${backend}: real Japanese inference and finalization`, async ({ page }) => {
    test.skip(!process.env.ASR_TEST_WAV, 'Set ASR_TEST_WAV to run real model downloads/inference.');
    test.setTimeout(240000);
    const samples = readWav(process.env.ASR_TEST_WAV);
    await page.goto('./'); await expect(page.locator('#load')).toBeEnabled();
    const result = await page.evaluate(async ({ backend, samples }) => {
      const worker = new Worker(backend === 'sherpa' ? './sherpa-worker.js' : './model-worker.js', { type: backend === 'sherpa' ? 'classic' : 'module' });
      const secondWorker = backend === 'two-pass' ? new Worker('./sherpa-worker.js') : null;
      const finals = [], firstPassFinals = [], partials = [], speech = [];
      let pendingLoads = secondWorker ? 2 : 1;
      try {
        await new Promise((resolve, reject) => {
          worker.onerror = (event) => reject(new Error(event.message));
          const receive = ({ data }, second = false) => {
            if (data.type === 'error') reject(new Error(data.message));
            if (data.type === 'ready' && --pendingLoads === 0) {
              worker.postMessage({ type: 'start' });
              // Feed blocks so streaming and segmentation use their actual paths.
              for (let i = 0; i < samples.length; i += 2048) {
                const audio = Float32Array.from(samples.slice(i, i + 2048));
                worker.postMessage({ type: 'audio', audio }, [audio.buffer]);
              }
              worker.postMessage({ type: 'stop' });
            }
            if (data.type === 'speech') speech.push(data);
            if (data.type === 'partial') partials.push(data.text);
            if (data.type === 'final') (secondWorker && !second ? firstPassFinals : finals).push(data.text);
            if (data.type === 'stopped') {
              if (secondWorker && !second) {
                const audio = Float32Array.from(samples);
                secondWorker.postMessage({ type: 'utterance', audio }, [audio.buffer]);
              } else resolve();
            }
          };
          worker.onmessage = receive;
          if (secondWorker) {
            secondWorker.onmessage = (event) => receive(event, true);
            secondWorker.onerror = (event) => reject(new Error(event.message));
            secondWorker.postMessage({ type: 'load' });
          }
          worker.postMessage({ type: 'load', backend: secondWorker ? 'moonshine' : backend });
        });
        return { finals, firstPassFinals, partials, speech };
      } finally { worker.terminate(); secondWorker?.terminate(); }
    }, { backend, samples });
    console.log(`${backend}: ${JSON.stringify(result)}`);
    expect(result.finals.join('')).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    if (['moonshine', 'two-pass'].includes(backend)) {
      expect(result.partials.length).toBeGreaterThan(0);
      expect(result.speech.filter((event) => event.event === 'started').length).toBeGreaterThan(0);
      expect(result.speech.filter((event) => event.event === 'completed').length).toBeGreaterThan(0);
    }
    if (backend === 'two-pass') expect(result.firstPassFinals.join('')).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
  });
}

// Small evaluation matrix; caller-supplied recordings stay local. Attenuation is
// a quiet-signal proxy, not a claim of human whisper accuracy.
const evaluations = [
  { name: 'Japanese normal', language: 'ja', wav: 'ASR_TEST_WAV', gain: 1 },
  { name: 'Japanese quiet proxy', language: 'ja', wav: 'ASR_TEST_WAV', gain: 0.01 },
  { name: 'Japanese very quiet proxy', language: 'ja', wav: 'ASR_TEST_WAV', gain: 0.001 },
  { name: 'Japanese very quiet sensitive', language: 'ja', wav: 'ASR_TEST_WAV', gain: 0.001, vadThreshold: '0.2' },
  { name: 'Japanese mixed terms', language: 'ja', wav: 'ASR_MIXED_WAV', gain: 1 },
  { name: 'English model mixed terms', language: 'en', wav: 'ASR_MIXED_WAV', gain: 1 },
  { name: 'English only', language: 'en', wav: 'ASR_ENGLISH_WAV', gain: 1 },
  { name: 'Japanese model English only', language: 'ja', wav: 'ASR_ENGLISH_WAV', gain: 1 },
  { name: 'Japanese whisper recording', language: 'ja', wav: 'ASR_WHISPER_WAV', gain: 1 },
  { name: 'Japanese whisper recording sensitive', language: 'ja', wav: 'ASR_WHISPER_WAV', gain: 1, vadThreshold: '0.2' },
  { name: 'Japanese silence', language: 'ja', wav: 'ASR_TEST_WAV', gain: 0 },
];
for (const entry of evaluations) {
  test(`Moonshine evaluation: ${entry.name}`, async ({ page }, testInfo) => {
    test.skip(!process.env[entry.wav], `Set ${entry.wav} for this evaluation.`);
    test.setTimeout(240000);
    const samples = readWav(process.env[entry.wav]).map((sample) => sample * entry.gain);
    await page.goto('./'); await expect(page.locator('#load')).toBeEnabled();
    await expect(page.locator('#description')).toContainText('Small Streaming');
    const result = await page.evaluate(async ({ samples, entry }) => {
      const worker = new Worker('./model-worker.js', { type: 'module' });
      const started = performance.now(), finals = [], partials = [], speech = [];
      let loadMs, acked = 0, stopMs;
      try {
        await new Promise((resolve, reject) => {
          worker.onerror = (event) => reject(new Error(event.message));
          worker.onmessage = ({ data }) => {
            if (data.type === 'error') reject(new Error(data.message));
            if (data.type === 'ready') {
              loadMs = performance.now() - started;
              worker.postMessage({ type: 'start' });
              for (let i = 0; i < samples.length; i += 2048) {
                const audio = Float32Array.from(samples.slice(i, i + 2048));
                worker.postMessage({ type: 'audio', audio }, [audio.buffer]);
              }
              stopMs = performance.now(); worker.postMessage({ type: 'stop' });
            }
            if (data.type === 'ack') acked += data.samples;
            if (data.type === 'speech') speech.push(data);
            if (data.type === 'partial') partials.push(data.text);
            if (data.type === 'final') finals.push(data.text);
            if (data.type === 'stopped') resolve();
          };
          worker.postMessage({ type: 'load', backend: 'moonshine', language: entry.language, vadThreshold: entry.vadThreshold ?? '0.5' });
        });
        return { loadMs, inferenceAndStopMs: performance.now() - stopMs, acked, finals, partials, speech };
      } finally { worker.terminate(); }
    }, { samples, entry });
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    const evidence = { browser: testInfo.project.name, ...entry, rmsDbfs: rms ? 20 * Math.log10(rms) : null, ...result };
    console.log(`evaluation: ${JSON.stringify(evidence)}`);
    await testInfo.attach('moonshine-evaluation.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    expect(result.acked).toBe(samples.length);
    if (entry.gain === 0) {
      expect(result.speech).toEqual([]);
      expect(result.partials).toEqual([]);
      expect(result.finals).toEqual([]);
    }
    if (['Japanese normal', 'English only'].includes(entry.name)) {
      expect(result.partials.some((text) => text.trim())).toBe(true);
      expect(result.finals.some((text) => text.trim())).toBe(true);
      expect(result.speech.some((event) => event.event === 'completed')).toBe(true);
    }
  });
}

// Opt-in pinned Silero + ReazonSpeech integration through the actual page policy.
// ASR_TEST_VAD alone uses deterministic silence, with no external ASR downloads.
test('ReazonSpeech simulated: real Silero runtime, Stop and repeat', async ({ page }) => {
  test.skip(!process.env.ASR_TEST_WAV && !process.env.ASR_TEST_VAD, 'Set ASR_TEST_VAD=1 (silence) or ASR_TEST_WAV (Japanese speech).');
  test.setTimeout(240000);
  const samples = process.env.ASR_TEST_WAV ? readWav(process.env.ASR_TEST_WAV) : Array(16037).fill(0);
  await page.goto('./'); await expect(page.locator('#load')).toBeEnabled();
  await page.evaluate(async () => {
    const { Microphone } = await import('./audio.js');
    Microphone.prototype.start = async function () { window.feedSmoke = chunk => this.onAudio(chunk); };
    Microphone.prototype.stop = async function () {};
  });
  await page.locator('#backend').selectOption('sherpa-simulated');
  await expect(page.locator('#load')).toBeEnabled(); await page.locator('#load').click();
  await expect(page.locator('#start')).toBeEnabled({ timeout: 120000 });
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.locator('#start').click();
    // Yield between microphone callbacks; VAD and ASR use separate workers. The page
    // retains its normal backlog cap, session checks and coalescing policy.
    await page.evaluate(async samples => {
      for (let offset = 0; offset < samples.length; offset += 2048) {
        window.feedSmoke(Float32Array.from(samples.slice(offset, offset + 2048)));
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    }, samples);
    await page.locator('#stop').click();
    await expect(page.locator('#status')).toContainText('Stopped', { timeout: 120000 });
    await expect(page.locator('#errors')).toBeEmpty();
    if (process.env.ASR_TEST_WAV) await expect(page.locator('#final')).toContainText(/[\u3040-\u30ff\u4e00-\u9fff]/);
    else {
      await expect(page.locator('#final')).toBeEmpty();
      await expect(page.locator('#speech')).toContainText('0 Silero VAD utterance(s)');
    }
    await expect(page.locator('#audio')).toContainText('/ 0.0 s');
  }
});
