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

// Opt-in pinned Silero + ReazonSpeech integration through the actual page policy.
// ASR_TEST_VAD uses deterministic silence. Both checks require prepared assets.
test('ReazonSpeech simulated: real Silero runtime, Stop and repeat', async ({ page }) => {
  test.skip(!process.env.ASR_TEST_WAV && !process.env.ASR_TEST_VAD, 'Set ASR_TEST_VAD=1 (silence) or ASR_TEST_WAV (Japanese or English speech).');
  test.setTimeout(240000);
  const samples = process.env.ASR_TEST_WAV ? readWav(process.env.ASR_TEST_WAV) : Array(16037).fill(0);
  await page.goto('./'); await expect(page.locator('#load')).toBeEnabled();
  await page.evaluate(async () => {
    const { Microphone } = await import('./audio.js');
    Microphone.prototype.start = async function () { window.feedSmoke = chunk => this.onAudio(chunk); };
    Microphone.prototype.stop = async function () {};
  });
  await expect(page.locator('#load')).toBeEnabled(); await page.locator('#load').click();
  await expect(page.locator('#start')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#reazon-model')).toContainText('ReazonSpeech ja-en (ja-en); 1 thread(s)');
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
    if (process.env.ASR_TEST_WAV) await expect(page.locator('#first-partial')).not.toHaveText('—', { timeout: 120000 });
    await page.locator('#stop').click();
    await expect(page.locator('#status')).toContainText('Stopped', { timeout: 120000 });
    await expect(page.locator('#errors')).toBeEmpty();
    if (process.env.ASR_TEST_WAV) await expect(page.locator('#final')).toContainText(/\S/);
    else {
      await expect(page.locator('#final')).toBeEmpty();
      await expect(page.locator('#speech')).toContainText('0 Silero VAD utterance(s)');
    }
    await expect(page.locator('#audio')).toContainText('/ 0.0 s');
  }
});
