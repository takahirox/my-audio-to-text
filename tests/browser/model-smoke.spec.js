import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Opt-in integration check using caller-supplied Japanese 16 kHz mono PCM WAV.
// Nothing is uploaded: bytes are transferred directly to the browser worker.
test.skip(!process.env.ASR_TEST_WAV, 'Set ASR_TEST_WAV to run real model downloads/inference.');
for (const backend of ['moonshine', 'sherpa', 'whisper']) {
  test(`${backend}: real Japanese inference and finalization`, async ({ page }) => {
    test.setTimeout(240000);
    const wav = readFileSync(process.env.ASR_TEST_WAV);
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
    await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
    const result = await page.evaluate(async ({ backend, samples }) => {
      const worker = new Worker(backend === 'sherpa' ? './sherpa-worker.js' : './model-worker.js', { type: backend === 'sherpa' ? 'classic' : 'module' });
      const finals = [], partials = [];
      try {
        await new Promise((resolve, reject) => {
          worker.onerror = (event) => reject(new Error(event.message));
          worker.onmessage = ({ data }) => {
            if (data.type === 'error') reject(new Error(data.message));
            if (data.type === 'ready') {
              worker.postMessage({ type: 'start' });
              // Feed blocks so streaming and segmentation use their actual paths.
              for (let i = 0; i < samples.length; i += 2048) {
                const audio = Float32Array.from(samples.slice(i, i + 2048));
                worker.postMessage({ type: 'audio', audio }, [audio.buffer]);
              }
              worker.postMessage({ type: 'stop' });
            }
            if (data.type === 'partial') partials.push(data.text);
            if (data.type === 'final') finals.push(data.text);
            if (data.type === 'stopped') resolve();
          };
          worker.postMessage({ type: 'load', backend });
        });
        return { finals, partials };
      } finally { worker.terminate(); }
    }, { backend, samples });
    console.log(`${backend}: ${JSON.stringify(result)}`);
    expect(result.finals.join('')).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    if (backend === 'moonshine') expect(result.partials.length).toBeGreaterThan(0);
  });
}
