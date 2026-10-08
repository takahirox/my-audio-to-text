import { test, expect } from '@playwright/test';

// Replace only the heavy runtime module: production nodes and both real Worker
// entry points/message adapters run in native module Workers in this suite.
async function modelFixture(page, mode = 'success') {
  await page.context().route('**/vendor/translation/transformers.js', route => route.fulfill({
    contentType: 'text/javascript', body: `
      export const env = { backends: { onnx: { wasm: {} } } };
      export async function pipeline(task, model, options) {
        if (!/^[a-f0-9]{40}$/.test(options.revision)) throw Error('Unpinned revision');
        if (options.device !== (task === 'translation' ? 'wasm' : 'webgpu')) throw Error('Wrong device');
        if (options.dtype !== (task === 'translation' ? 'q8' : 'q4')) throw Error('Wrong dtype');
        options.progress_callback({ status: 'progress', file: 'weights', progress: 50 });
        if (${JSON.stringify(mode)} === 'load-error') throw Error('Offline cache miss');
        if (${JSON.stringify(mode)} === 'loading') await new Promise(resolve => setTimeout(resolve, 1000));
        const translate = async (input, settings) => {
          if (!settings || settings.do_sample !== false || settings.max_new_tokens !== 256) throw Error('Wrong generation settings');
          if (${JSON.stringify(mode)} === 'inference-error') throw Error('Inference failed');
          const text = typeof input === 'string' ? input : input[0].content[0].text;
          if (typeof input !== 'string') {
            const content = input[0].content[0];
            if (content.source_lang_code !== 'ja' || content.target_lang_code !== 'en' || content.type !== 'text') throw Error('Wrong translation template');
          }
          await new Promise(resolve => setTimeout(resolve, text === 'slow' ? 1000 : 10));
          if (text === 'zero') return [];
          return (text === 'multi' ? ['first', 'second'] : [(model === 'Kadonox/opus-tatoeba-en-ja-onnx' ? 'Japanese: ' : 'English: ') + text]).map(output => task === 'translation'
            ? { translation_text: output } : { generated_text: [...input, { role: 'assistant', content: output }] });
        };
        translate.tokenizer = text => ({ input_ids: { dims: [1, text === 'tokens' ? 513 : 10] } });
        return translate;
      }
    `,
  }));
}
async function workerGpuFixture(page, available = true) {
  // GPU availability is controlled in the real processing Worker, not window.
  await page.context().route('**/translategemma-worker.js', async route => {
    const original = await route.fetch();
    await route.fulfill({ response: original, body: `Object.defineProperty(self.navigator, 'gpu', { value: ${available ? (available === 'no-adapter' ? '{ requestAdapter: async () => null }' : '{ requestAdapter: async () => ({}) }') : 'undefined'} });\n${await original.text()}` });
  });
}
async function observe(page) {
  await page.evaluate(async () => {
    const { Pipeline } = await import('../../pipeline.js');
    window.translationGraphs = [];
    const start = Pipeline.prototype.start;
    Pipeline.prototype.start = function () { window.translationGraphs.push(this); return start.call(this); };
    const NativeWorker = window.Worker;
    window.translationWorkers = [];
    window.Worker = class extends NativeWorker {
      constructor(url, options) { super(url, options); window.translationWorkers.push({ url: String(url), terminated: 0 }); this.record = window.translationWorkers.at(-1); }
      terminate() { this.record.terminated++; return super.terminate(); }
    };
  });
}
for (const slug of ['opus-mt', 'opus-mt-en-ja', 'translategemma']) {
  test(`${slug}: navigation, real node/worker pipeline, latency, repeat and prefix assets`, async ({ page }) => {
    await modelFixture(page); if (slug === 'translategemma') await workerGpuFixture(page);
    const prefix = !process.env.ASR_BASE_URL && !process.env.ASR_BENCHMARK ? './my-audio-to-text/' : './';
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(prefix);
    await page.getByRole('link', { name: slug === 'opus-mt' ? 'OPUS-MT Translation (Japanese → English)' : slug === 'opus-mt-en-ja' ? 'OPUS-MT Translation (English → Japanese)' : 'TranslateGemma 4B Translation (Japanese → English)', exact: true }).click();
    await expect(page.locator('#run')).toBeEnabled(); await expect(page.locator('select')).toHaveCount(0);
    await observe(page);
    for (const input of ['今日は良い天気です。', 'multi', 'zero', ...(slug === 'opus-mt-en-ja' ? ['HELLO.', 'WE NEED TO FINISH THIS PROJECT BY FRIDAY.'] : [])]) {
      await page.locator('#input').fill(input); await page.locator('#run').click();
      await expect(page.locator('#status')).toHaveText('Complete');
      await expect(page.locator('#output')).toHaveText(input === 'multi' ? 'first\nsecond' : input === 'zero' ? '' : (slug === 'opus-mt-en-ja' ? 'Japanese: ' : 'English: ') + (input === 'HELLO.' ? 'Hello.' : input === 'WE NEED TO FINISH THIS PROJECT BY FRIDAY.' ? 'We need to finish this project by Friday.' : input));
      await expect(page.locator('#latency')).toContainText('ms'); await expect(page.locator('#load-time')).toContainText('ms');
      await expect(page.locator('#run')).toBeEnabled();
      await expect(page.locator('#input')).toHaveValue(input);
    }
    const evidence = await page.evaluate(() => ({
      workers: window.translationWorkers,
      types: [...window.translationGraphs[0].entries.values()].map(e => e.node.constructor.name),
      states: window.translationGraphs.map(g => g.state),
    }));
    expect(evidence.types).toEqual(['TextInputNode', slug === 'opus-mt' ? 'OpusMtTranslationNode' : slug === 'opus-mt-en-ja' ? 'EnglishToJapaneseOpusMtTranslationNode' : 'TranslateGemmaTranslationNode', 'TextOutputNode']);
    expect(evidence.states).toEqual(Array(slug === 'opus-mt-en-ja' ? 5 : 3).fill('disposed'));
    expect(evidence.workers).toHaveLength(slug === 'opus-mt-en-ja' ? 5 : 3);
    for (const worker of evidence.workers) {
      expect(worker.terminated).toBe(1);
      expect(worker.url).toBe(new URL(`../../${slug === 'opus-mt' ? 'opus-mt' : slug === 'opus-mt-en-ja' ? 'opus-mt-en-ja' : 'translategemma'}-worker.js`, page.url()).href);
    }
    await page.getByRole('link', { name: 'Node Playground', exact: true }).click();
    await expect(page).toHaveTitle('Node Playground'); expect(errors).toEqual([]);
  });
  for (const mode of ['load-error', 'inference-error']) {
    test(`${slug}: ${mode} is visible and retry releases old resources`, async ({ page }) => {
      await modelFixture(page, mode); if (slug === 'translategemma') await workerGpuFixture(page);
      await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled(); await observe(page);
      await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Error');
      await expect(page.locator('#errors')).toContainText(mode === 'load-error' ? 'Offline cache miss' : 'Inference failed');
      await expect(page.locator('#run')).toBeEnabled(); await expect(page.locator('#output')).toBeEmpty();
      expect(await page.evaluate(() => window.translationWorkers[0].terminated)).toBe(1);
      await page.context().unroute('**/vendor/translation/transformers.js'); await modelFixture(page);
      await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
    });
  }
  for (const phase of ['loading', 'inference']) {
    test(`${slug}: cancel during ${phase} ignores late output and permits a fresh run`, async ({ page }) => {
      await modelFixture(page, phase === 'loading' ? 'loading' : 'success'); if (slug === 'translategemma') await workerGpuFixture(page);
      await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled(); await observe(page);
      await page.locator('#input').fill('slow'); await page.locator('#run').click();
      await expect(page.locator('#status')).toContainText(phase === 'loading' ? 'Loading' : 'Translating');
      await page.locator('#cancel').click(); await expect(page.locator('#status')).toHaveText('Canceled');
      await page.locator('#input').fill('fresh'); await page.locator('#run').click();
      await expect(page.locator('#status')).toHaveText('Complete');
      await expect(page.locator('#output')).toHaveText(slug === 'opus-mt-en-ja' ? 'Japanese: fresh' : 'English: fresh');
      expect(await page.evaluate(() => window.translationWorkers.map(w => w.terminated))).toEqual([1, 1]);
    });
  }
}

test('TranslateGemma unsupported Worker WebGPU fails before runtime/model fetch', async ({ page }) => {
  await workerGpuFixture(page, false);
  const downloads = []; page.on('request', request => {
    if (/vendor\/translation|huggingface\.co/.test(request.url())) downloads.push(request.url());
  });
  await page.goto('./nodes/translategemma/'); await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#errors')).toContainText('requires WebGPU'); expect(downloads).toEqual([]);
});

test('OPUS token limit is reported instead of silently truncating', async ({ page }) => {
  await modelFixture(page); await page.goto('./nodes/opus-mt/'); await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#input').fill('tokens'); await page.locator('#run').click();
  await expect(page.locator('#errors')).toContainText('512 tokens'); await expect(page.locator('#output')).toBeEmpty();
});

test('TranslateGemma missing GPU adapter is actionable and does not fetch runtime/model assets', async ({ page }) => {
  await workerGpuFixture(page, 'no-adapter');
  const downloads = []; page.on('request', request => {
    if (/vendor\/translation|huggingface\.co/.test(request.url())) downloads.push(request.url());
  });
  await page.goto('./nodes/translategemma/'); await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#errors')).toContainText('No WebGPU adapter'); expect(downloads).toEqual([]);
});
