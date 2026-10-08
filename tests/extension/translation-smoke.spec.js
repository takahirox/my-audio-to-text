import { test, expect, chromium } from '@playwright/test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ordinaryEnglishFixtures } from '../fixtures/translation-en-ja.js';
import { OPUS_MT, OPUS_MT_EN_JA } from '../../web/translation-models.js';

// Explicit opt-in: suitable Chrome, network and ~239 MB (ja-en) / ~253 MB (en-ja) cache space required.
// Failures when opted in are reported; never silently skip a device/load error.
for (const direction of ['ja-en', 'en-ja']) {
const reverse = direction === 'en-ja';
test(`real extension ${direction}: native tab audio → ASR → provisional/final OPUS-MT, offline repeat`, async ({}, testInfo) => {
  test.skip(process.env.EXTENSION_OPUS_SMOKE !== (reverse ? 'en-ja' : '1'), 'Opt-in real extension OPUS-MT smoke. Set EXTENSION_OPUS_SMOKE=1 (ja-en) or en-ja.');
  test.setTimeout(900000);
  const specification = JSON.parse(await readFile('scripts/reazon-ja-en-assets.json', 'utf8'));
  const fixture = reverse ? { name: 'Ordinary English (synthetic speech)', path: 'tests/fixtures/ordinary-english.wav', sha256: '21212faed6ae5f5958603d4d7cf60a423f1090fb6542d00e3a826ebe6235a768' }
    : specification.fixtures.find(value => value.name === 'Japanese');
  const wav = await readFile(reverse ? fixture.path : path.join('.cache/reazon-ja-en', fixture.path)).catch(error => {
    throw new Error(`Real smoke fixture unavailable. Restore the committed English fixture or run python3 scripts/prepare-reazon-ja-en-fixtures.py for Japanese: ${error.message}`);
  });
  expect(createHash('sha256').update(wav).digest('hex')).toBe(fixture.sha256);
  const profile = await mkdtemp(path.join(tmpdir(), 'extension-opus-real-'));
  const requests = [], errors = [], runs = [];
  const server = createServer((request, response) => {
    if (request.url === '/speech.wav') {
      response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(wav);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<button id="play">Play speech</button><audio id="audio" src="/speech.wav"></audio><script>document.querySelector("#play").onclick=()=>{const a=document.querySelector("audio");a.currentTime=0;a.play();};</script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context, capabilities, browserVersion, cacheState;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: !process.env.EXTENSION_HEADED,
      ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'], args: ['--enable-unsafe-extension-debugging'] });
    browserVersion = context.browser().version();
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.resolve('dist/chrome-extension') });
    context.on('request', request => {
      const url = new URL(request.url());
      requests.push({ url: `${url.protocol}//${url.host}${url.pathname}`, method: request.method(), hasBody: request.postData() !== null });
    });
    const meeting = await context.newPage(); await meeting.goto(`http://127.0.0.1:${server.address().port}/`);
    // Trigger the actual toolbar action to get the native tabCapture grant.
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    let [recorder] = await Promise.all([context.waitForEvent('page'), cdp.send('Extensions.triggerAction', {
      id, targetId: targetInfos.find(target => target.url === meeting.url()).targetId,
    })]);
    recorder.on('pageerror', error => errors.push(error.message));
    await expect(recorder.locator('#status')).toHaveText('Transcription active', { timeout: 120000 });
    await recorder.locator('#stop').click(); await expect(recorder.locator('#start')).toBeEnabled();
    capabilities = await recorder.evaluate(() => ({ userAgent: navigator.userAgent, isolated: crossOriginIsolated,
      wasm: typeof WebAssembly === 'object', worker: typeof Worker === 'function', cache: !!globalThis.caches }));
    await recorder.exposeFunction('logPreparation', value => console.log(`Real OPUS preparation: ${value}`));
    await recorder.evaluate(() => {
      let last = -1;
      new MutationObserver(() => {
        const progress = document.querySelector('#model-progress');
        const bucket = Math.floor(progress.value / 25000000);
        if (bucket !== last) { last = bucket; window.logPreparation(`${progress.value} / ${progress.max} bytes`); }
      }).observe(document.querySelector('#model-bytes'), { childList: true });
    });
    await recorder.locator('#translation-direction').selectOption(direction);
    await recorder.locator('#prepare-opus').click();
    await expect(recorder.locator('#model-status')).toHaveText(/^(Ready|Error.*)$/, { timeout: 600000 });
    cacheState = await recorder.locator('#model-status').textContent();
    expect(cacheState, 'Real remote asset download/CORS/COEP/quota failure').toBe('Ready');
    await recorder.locator('#translation-enabled').check();
    for (let run = 0; run < 2; run++) {
      const before = requests.length;
      if (run) {
        await recorder.close();
        await context.setOffline(true);
        const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
        [recorder] = await Promise.all([context.waitForEvent('page'), cdp.send('Extensions.triggerAction', {
          id, targetId: targetInfos.find(target => target.url === meeting.url()).targetId,
        })]);
        recorder.on('pageerror', error => errors.push(error.message));
        await expect(recorder.locator('#status')).toHaveText('Transcription active', { timeout: 120000 });
        await recorder.locator('#stop').click(); await expect(recorder.locator('#start')).toBeEnabled();
        await expect(recorder.locator('#model-status')).toHaveText('Ready', { timeout: 30000 });
        await recorder.locator('#translation-enabled').check();
      }
      await recorder.locator('#start').click();
      await expect(recorder.locator('#status')).toHaveText('Transcription active', { timeout: 120000 });
      await expect(recorder.locator('#translation-status')).toHaveText(/^(Local OPUS-MT ready|Translation unavailable:.*)$/, { timeout: 120000 });
      expect(await recorder.locator('#translation-status').textContent()).toBe('Local OPUS-MT ready');
      await recorder.evaluate(() => {
        window.completedProvisional = [];
        new MutationObserver(() => {
          const translated = document.querySelector('#partial-english');
          if (translated.dataset.status === 'complete') window.completedProvisional.push({
            original: document.querySelector('#partial').textContent, translated: translated.textContent,
          });
        }).observe(document.querySelector('#partial-english'), { childList: true, attributes: true });
      });
      await meeting.locator('#play').click();
      await expect(recorder.locator('#partial')).toHaveText(reverse ? /[A-Za-z]/ : /[\u3040-\u30ff\u4e00-\u9fff]/, { timeout: 60000 });
      await expect.poll(() => recorder.evaluate(() => window.completedProvisional.length), { timeout: 60000 }).toBeGreaterThan(0);
      const provisional = await recorder.evaluate(() => window.completedProvisional.at(-1));
      expect(provisional.original).toMatch(reverse ? /[A-Za-z]/ : /[\u3040-\u30ff\u4e00-\u9fff]/);
      expect(provisional.translated).toMatch(reverse ? /[\u3040-\u30ff\u4e00-\u9fff]/ : /[A-Za-z]/);
      expect(provisional.translated).not.toMatch(/^(Translating|Translation|Older interim)/);
      await expect.poll(() => meeting.locator('#audio').evaluate(audio => audio.ended), { timeout: 60000 }).toBe(true);
      await recorder.locator('#stop').click(); await expect(recorder.locator('#start')).toBeEnabled({ timeout: 120000 });
      const finals = await recorder.locator('#paired-finals li').evaluateAll(rows => rows.map(row => ({
        original: row.children[0].textContent, translated: row.children[1].textContent,
      })));
      // Exercise representative ordinary English through the production Pipeline,
      // Node/Worker and extension-only verified cache, online and after recreation
      // offline. No ASR/model/runtime mocks or direct remote-model fallback.
      const ordinaryTranslations = reverse ? await recorder.evaluate(async texts => {
        const { Pipeline } = await import('../web/pipeline.js');
        const { TEXT, EnglishToJapaneseOpusMtTranslationNode, TextOutputNode } = await import('../web/translation-nodes.js');
        const outputs = [];
        const source = { inputs: {}, outputs: { text: TEXT }, start(context) {
          for (const text of texts) context.emit('text', text);
        } };
        const node = new EnglishToJapaneseOpusMtTranslationNode({ loadOptions: { cacheOnly: true } });
        const sink = new TextOutputNode(text => outputs.push(text));
        const graph = new Pipeline({ nodes: { source, translation: node, sink }, connections: [
          { from: ['source', 'text'], to: ['translation', 'text'] },
          { from: ['translation', 'text'], to: ['sink', 'text'] },
        ] });
        try { await graph.start(); await graph.stop(); return outputs; }
        finally { await graph.dispose(); }
      }, ordinaryEnglishFixtures.map(({ text }) => text)) : [];
      runs.push({ run, offline: !!run, recreatedWindow: !!run, provisional, finals,
        ordinaryTranslations: ordinaryTranslations.map((translated, index) => ({ original: ordinaryEnglishFixtures[index].text, translated })) });
      if (reverse) {
        expect(ordinaryTranslations).toHaveLength(ordinaryEnglishFixtures.length);
        ordinaryEnglishFixtures.forEach(({ text, meanings }, index) => {
          for (const meaning of meanings) expect(ordinaryTranslations[index], `Translation of ${text} must preserve ${meaning}`).toMatch(meaning);
        });
      }
      console.log(JSON.stringify(runs.at(-1)));
      expect(finals.length).toBeGreaterThan(0);
      if (reverse) {
        for (const [sourceWord, fixtureIndex] of [[/MEETING/i, 2], [/REPORT/i, 4], [/PROJECT/i, 8]]) {
          const pair = finals.find(pair => sourceWord.test(pair.original));
          expect(pair, `Recognized ordinary English ${sourceWord} must remain paired`).toBeDefined();
          for (const meaning of ordinaryEnglishFixtures[fixtureIndex].meanings) expect(pair.translated).toMatch(meaning);
        }
      }
      expect(finals.some(pair => (reverse ? /[A-Za-z]/ : /[\u3040-\u30ff\u4e00-\u9fff]/).test(pair.original))).toBe(true);
      for (const pair of finals) {
        // Bilingual ASR can emit a short other-language tail; retain it visibly.
        expect(pair.original.trim().length).toBeGreaterThan(0);
        if (!reverse) expect(pair.original).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
        if (!reverse || /[A-Za-z]/.test(pair.original)) expect(pair.translated).toMatch(reverse ? /[\u3040-\u30ff\u4e00-\u9fff]/ : /[A-Za-z]/);
        expect(pair.translated.trim()).not.toBe(''); expect(pair.translated).not.toMatch(/failed|Translating|canceled/i);
      }
      expect(requests.slice(before).every(request => request.url.startsWith('chrome-extension://') || request.url.startsWith('http://127.0.0.1:'))).toBe(true);
    }
    expect(errors).toEqual([]);
    expect(requests.every(request => request.method === 'GET' && !request.hasBody)).toBe(true);
    for (const request of requests) {
      const url = new URL(request.url);
      if (url.protocol === 'chrome-extension:' || url.hostname === '127.0.0.1') continue;
      expect(url.hostname === 'huggingface.co' || url.hostname.endsWith('.hf.co')).toBe(true);
    }
  } finally {
    const evidence = { direction, model: reverse ? OPUS_MT_EN_JA : OPUS_MT, time: new Date().toISOString(), browserVersion, capabilities, fixture: { name: fixture.name, path: fixture.path, sha256: fixture.sha256 }, cacheState, runs, errors, requests };
    const file = testInfo.outputPath('extension-opus-evidence.json');
    await writeFile(file, JSON.stringify(evidence, null, 2) + '\n');
    await testInfo.attach('extension-opus-evidence', { path: file, contentType: 'application/json' });
    console.log(JSON.stringify({ browserVersion, capabilities, cacheState, runs, errors }));
    await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true });
  }
});

}
