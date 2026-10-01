import { test, expect } from '@playwright/test';

// Exercise the real page/capture lifecycle without downloading models in CI.
// Real model inference is covered separately by the opt-in smoke test.
async function fakeBackend(page) {
  await page.context().route('**/model-worker.js', (route) => route.fulfill({ contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: `
    self.onmessage = ({data}) => {
      if (data.type === 'load') postMessage({type:'ready'});
      if (data.type === 'audio') postMessage({type:'ack',samples:data.audio.length});
      if (data.type === 'stop') {
        postMessage({type:'final',text:'日本語のテスト'}); postMessage({type:'stopped'});
      }
    };
  ` }));
}

test('Pages isolation activates; selection keeps the repeatable utterance', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#load')).toBeEnabled();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.locator('#utterance').fill('今日は東京でテストします。');
  await page.locator('#backend').selectOption('sherpa');
  await expect(page.locator('#description')).toContainText('ReazonSpeech');
  await expect(page.locator('#partial')).toContainText('Unsupported');
  await page.locator('#backend').selectOption('whisper');
  await expect(page.locator('#utterance')).toHaveValue('今日は東京でテストします。');
});

test('microphone denial is visible and leaves retry available', async ({ page }) => {
  await fakeBackend(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await page.locator('#start').click();
  await expect(page.locator('#errors')).toContainText('Permission denied');
  await expect(page.locator('#load')).toBeEnabled();
  await expect(page.locator('#stop')).toBeDisabled();
});

test('capture, Stop, repeat, and release on a mobile-sized page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await fakeBackend(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const source = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      source.connect(destination); source.start();
      const track = destination.stream.getTracks()[0], originalStop = track.stop.bind(track);
      window.stops = 0;
      track.stop = () => { window.stops++; originalStop(); source.stop(); void context.close(); };
      return destination.stream;
    };
  });
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Listening');
  await expect(page.locator('#audio')).not.toHaveText('—');
  await expect(page.locator('#backend')).toBeDisabled();
  await page.locator('#stop').click();
  await expect(page.locator('#final')).toContainText('日本語のテスト');
  await expect(page.locator('#latency')).not.toHaveText('—');
  expect(await page.evaluate(() => window.stops)).toBe(1);
  await page.locator('#start').click(); await expect(page.locator('#final')).toBeEmpty();
  await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
  expect(await page.evaluate(() => window.stops)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});

test('canceling pending microphone permission releases a late-granted track', async ({ page }) => {
  await fakeBackend(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => {
      window.grant = () => resolve({ getTracks: () => [{ stop: () => { window.lateTrackStopped = true; } }] });
    });
  });
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Requesting');
  await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
  await page.evaluate(() => window.grant());
  await expect.poll(() => page.evaluate(() => window.lateTrackStopped)).toBe(true);
  await expect(page.locator('#status')).toContainText('Canceled');
});
