import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Resampler } from '../../web/audio.js';
import { REAZON_NUM_THREADS } from '../../web/reazon-config.js';

const specification = JSON.parse(readFileSync(new URL('../../scripts/reazon-ja-en-assets.json', import.meta.url)));
function verifyBundle() {
  const readAsset = (directory, file) => readFileSync(new URL(`../../web/vendor/${directory}/${file}`, import.meta.url));
  const stem = 'sherpa-onnx-wasm-main-vad-asr';
  const script = readAsset('sherpa-ja-en', `${stem}.js`).toString();
  const table = JSON.parse(script.match(/loadPackage\((\{"files":.*?,"remote_package_size":\d+\})\)/)[1]);
  const data = readAsset('sherpa-ja-en', `${stem}.data`);
  expect(table.remote_package_size).toBe(data.length);
  for (const model of specification.models) {
    const entry = table.files.find(file => file.filename === model.virtualPath);
    expect(entry, model.path).toBeDefined();
    expect(createHash('sha256').update(data.subarray(entry.start, entry.end)).digest('hex')).toBe(model.sha256);
  }
  // Hashes measured from #41's checksum-pinned sherpa 1.13.2 runtime.
  // Validate runtime identity without preparing a Japanese-only model bundle.
  const sha256 = data => createHash('sha256').update(data).digest('hex');
  expect(sha256(readAsset('sherpa-ja-en', `${stem}.wasm`))).toBe('a1f3fb15701fad8c556af45d785ddd17dcfe8e25272aa1a02ba0369c9f2ce828');
  expect(sha256(readAsset('sherpa-ja-en', 'sherpa-onnx-asr.js'))).toBe('d51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178');
  const vad = readAsset('sherpa-ja-en', 'sherpa-onnx-vad.js').toString();
  expect(vad.startsWith('(function () {\n')).toBe(true);
  expect(vad.endsWith('\nself.createVad = createVad;\n})();\n')).toBe(true);
  expect(sha256(vad.slice('(function () {\n'.length, -'\nself.createVad = createVad;\n})();\n'.length))).toBe('893f01168d529add8318c0a6055cf725e788585fda9b81722564a8c3c3f60e34');
  const stripTable = text => text.replace(/loadPackage\(\{.*?remote_package_size["']?:\d+\}\)/, 'loadPackage(TABLE)');
  expect(sha256(stripTable(script))).toBe('0065c146db35983b8c787b44b8d0d1e2e4d22c3205e8e1982c012c145e654295');
  const silero = table.files.find(file => file.filename === '/silero_vad.onnx');
  expect(sha256(data.subarray(silero.start, silero.end))).toBe('9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6');
  expect(table.files.map(file => file.filename).sort()).toEqual([...specification.models.map(model => model.virtualPath), '/silero_vad.onnx'].sort());
  expect(readdirSync(new URL('../../web/vendor/', import.meta.url)).sort()).toEqual(['manifest.json', 'sherpa-ja-en']);
  const manifest = JSON.parse(readAsset('.', 'manifest.json'))['sherpa-ja-en'];
  expect(manifest.revision).toBe(specification.revision);
  expect(manifest.sha256).toBe(createHash('sha256').update(data).digest('hex'));
}

function readFixture(fixture) {
  const wav = readFileSync(new URL(`../../.cache/reazon-ja-en/${fixture.path}`, import.meta.url));
  expect(createHash('sha256').update(wav).digest('hex')).toBe(fixture.sha256);
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
  return Array.from(new Resampler(rate).push(samples));
}

test('real ja-en model recognizes Japanese, English and mixed speech through the playground', async ({ page, browser }, testInfo) => {
  test.skip(!process.env.ASR_REAZON_JA_EN, 'Run npm run test:reazon-ja-en after npm run prepare:assets.');
  test.setTimeout(240000);
  verifyBundle();
  const errors = [], assetRequests = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/vendor/')) assetRequests.push(new URL(request.url()).pathname);
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.modelEvents = []; window.modelRequests = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args); this.url = args[0];
        this.addEventListener('message', ({ data }) => {
          if (['configuration', 'partial', 'final', 'error'].includes(data.type)) window.modelEvents.push(data);
        });
      }
      postMessage(message, ...args) {
        window.modelRequests.push({ type: message.type, backend: message.backend, worker: this.url, final: message.final, session: message.session });
        super.postMessage(message, ...args);
      }
    };
  });
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  // Replace only the microphone source. VAD, controller, model loading, WASM
  // inference, Stop and repeat all run through the unmodified production page.
  await page.evaluate(async () => {
    const { Microphone } = await import('./audio.js');
    Microphone.prototype.start = async function () {
      window.feedFixture = samples => {
        for (let i = 0; i < samples.length; i += 2048) this.onAudio(Float32Array.from(samples.slice(i, i + 2048)));
      };
    };
    Microphone.prototype.stop = async function () {};
  });
  await expect(page.locator('select:not(#source)')).toHaveCount(0);
  for (const id of ['partial', 'final']) await expect(page.locator(`#${id}`)).toHaveAttribute('lang', '');
  await expect(page.locator('#description')).toContainText('epoch 35');
  await page.locator('#load').click();
  await expect(page.locator('#start')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#reazon-model')).toHaveText(`ReazonSpeech ja-en (ja-en); ${REAZON_NUM_THREADS} thread(s)`);
  for (const fixture of specification.fixtures) {
    const samples = readFixture(fixture);
    await page.locator('#start').click();
    await expect(page.locator('#final')).toBeEmpty();
    await page.evaluate(samples => window.feedFixture(samples), samples.slice(0, 48000));
    await expect(page.locator('#first-partial')).not.toHaveText('—', { timeout: 60000 });
    await page.evaluate(samples => window.feedFixture(samples), samples.slice(48000));
    await page.evaluate(() => window.feedFixture(Array(16000).fill(0)));
    // Exercise the actual Silero trailing-silence endpoint before Stop.
    await expect(page.locator('#audio')).toContainText('/ 0.0 s', { timeout: 60000 });
    await expect(page.locator('#final')).toContainText(/\S/);
    const endpointText = await page.locator('#final').textContent();
    await page.locator('#stop').click();
    await expect(page.locator('#final')).toHaveText(endpointText);
    await expect(page.locator('#status')).toContainText('Stopped', { timeout: 60000 });
    const text = (await page.locator('#final').textContent()).trim();
    expect(text, fixture.name).not.toBe('');
    if (fixture.name.includes('Japanese')) expect(text).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    if (fixture.name.includes('English')) expect(text).toMatch(/[a-z]/i);
    await expect(page.locator('#partial')).toBeEmpty();
    await expect(page.locator('#audio')).toContainText('/ 0.0 s');
    await expect(page.locator('select:not(#source)')).toHaveCount(0);
    await expect(page.locator('#errors')).toBeEmpty();
    results.push({ name: fixture.name, source: fixture.path, sha256: fixture.sha256, samples: samples.length, transcript: text });
  }
  expect(await page.evaluate(() => window.modelEvents.filter(e => e.type === 'configuration').map(e => [e.model, e.numThreads]))).toEqual([['ja-en', REAZON_NUM_THREADS]]);
  const loadRequests = await page.evaluate(() => window.modelRequests.filter(e => e.type === 'load'));
  expect(loadRequests.map(e => e.worker).sort()).toEqual(['./sherpa-worker.js', './silero-worker.js']);
  expect(loadRequests.every(e => e.backend === undefined)).toBe(true);
  expect(loadRequests.find(e => e.worker === './silero-worker.js').backend).toBeUndefined();
  expect(assetRequests).toContain('/vendor/sherpa-ja-en/sherpa-onnx-wasm-main-vad-asr.data');
  expect(assetRequests.every(path => path.includes('/vendor/sherpa-ja-en/'))).toBe(true);
  await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
  await expect(page.locator('#reazon-model')).toHaveText('—');
  await expect(page.locator('#final')).toBeEmpty();
  await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#reazon-model')).toHaveText(`ReazonSpeech ja-en (ja-en); ${REAZON_NUM_THREADS} thread(s)`);
  await expect(page.locator('#final')).toBeEmpty();
  await page.locator('#start').click();
  await page.evaluate(samples => window.feedFixture(samples), readFixture(specification.fixtures[1]).slice(0, 48000));
  await expect(page.locator('#first-partial')).not.toHaveText('—', { timeout: 60000 });
  await page.locator('#cancel').click();
  await expect(page.locator('#load')).toBeEnabled();
  await expect(page.locator('#final')).toBeEmpty();
  await expect(page.locator('#reazon-model')).toHaveText('—');
  expect(errors).toEqual([]);
  const evidence = { browser: testInfo.project.name, browserVersion: browser.version(), model: specification.source,
    revision: specification.revision, numThreads: REAZON_NUM_THREADS, results, errors };
  await testInfo.attach('reazon-ja-en.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  console.log(JSON.stringify(evidence));
});
