import { test, expect } from '@playwright/test';

// Replace only the heavy runtime module: production nodes and both real Worker
// entry points/message adapters run in native module Workers in this suite.
async function modelFixture(page, mode = 'success') {
  await page.context().route('**/vendor/translation/transformers.js', route => route.fulfill({
    contentType: 'text/javascript', body: `
      export const env = { backends: { onnx: { wasm: {} } } };
      export async function pipeline(task, model, options) {
        if (!/^[a-f0-9]{40}$/.test(options.revision)) throw Error('Unpinned revision');
        if (options.device !== 'webgpu') throw Error('Wrong device');
        if (options.dtype !== 'q4') throw Error('Wrong dtype');
        options.progress_callback({ status: 'progress', file: 'weights', progress: 50 });
        if (${JSON.stringify(mode)} === 'load-error') throw Error('Offline cache miss');
        if (${JSON.stringify(mode)} === 'loading') await new Promise(resolve => setTimeout(resolve, 1000));
        const translate = async (input, settings) => {
          if (!settings || settings.do_sample !== false || settings.max_new_tokens !== 256) throw Error('Wrong generation settings');
          if (${JSON.stringify(mode)} === 'inference-error') throw Error('Inference failed');
          const text = typeof input === 'string' ? input : input[0].content[0].text;
          if (typeof input !== 'string') {
            const content = input[0].content[0];
            if (!['ja-en', 'en-ja', 'fr-de'].includes(content.source_lang_code + '-' + content.target_lang_code) || content.type !== 'text') throw Error('Wrong translation template');
          }
          await new Promise(resolve => setTimeout(resolve, text === 'slow' ? 1000 : 10));
          if (text === 'zero') return [];
          return (text === 'multi' ? ['first', 'second'] : [({ ja: 'Japanese: ', en: 'English: ', de: 'German: ' }[input[0].content[0].target_lang_code]) + text]).map(output => ({ generated_text: [...input, { role: 'assistant', content: output }] }));
        };
        translate.tokenizer = text => ({ input_ids: { dims: [1, text === 'tokens' ? 513 : 10] } });
        return translate;
      }
    `,
  }));
}
test('TranslateGemma changes language ports across Runs with one loaded production Worker', async ({ page }) => {
  await modelFixture(page); await workerGpuFixture(page);
  await page.goto('./nodes/translategemma/'); await observe(page);
  await expect(page.locator('select')).toHaveCount(0);
  for (const [source, target, text, output] of [['en','ja','Hello.','Japanese: Hello.'], ['ja','en','こんにちは。','English: こんにちは。'], ['fr','de','Bonjour.','German: Bonjour.']]) {
    await page.locator('#source-lang').fill(source); await page.locator('#target-lang').fill(target);
    await page.locator('#input').fill(text); await page.locator('#run').click();
    await expect(page.locator('#status')).toHaveText('Complete'); await expect(page.locator('#output')).toHaveText(output);
  }
  expect(await page.evaluate(() => window.translationWorkers.length)).toBe(1);
  expect(await page.evaluate(() => window.translationGraphs.map(graph => graph.entries.get('translation').node.constructor.name))).toEqual(['TranslateGemmaTranslationNode']);
  await page.locator('#target-lang').fill('xx'); await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('Error'); await expect(page.locator('#errors')).toContainText('target_lang');
});
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
for (const slug of ['translategemma']) {
  test(`${slug}: navigation, real node/worker pipeline, latency, repeat and prefix assets`, async ({ page }) => {
    await modelFixture(page); if (slug === 'translategemma') await workerGpuFixture(page);
    const prefix = !process.env.ASR_BASE_URL && !process.env.ASR_BENCHMARK ? './my-audio-to-text/' : './';
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(prefix);
    await page.getByRole('link', { name: 'Translation · TranslateGemma 4B', exact: true }).click();
    await expect(page.locator('#run')).toBeEnabled(); await expect(page.locator('select')).toHaveCount(0);
    await observe(page);
    for (const input of ['今日は良い天気です。', 'multi', 'zero', ]) {
      await page.locator('#input').fill(input); await page.locator('#run').click();
      await expect(page.locator('#status')).toHaveText('Complete');
      await expect(page.locator('#output')).toHaveText(input === 'multi' ? 'first\nsecond' : input === 'zero' ? '' : 'English: ' + input);
      await expect(page.locator('#latency')).toContainText('ms'); await expect(page.locator('#load-time')).toHaveText(/ms|Already loaded/);
      await expect(page.locator('#run')).toBeEnabled();
      await expect(page.locator('#input')).toHaveValue(input);
    }
    const evidence = await page.evaluate(() => ({
      workers: window.translationWorkers,
      types: [...window.translationGraphs[0].entries.values()].map(e => e.node.constructor.name),
      states: window.translationGraphs.map(g => g.state),
    }));
    expect(evidence.types).toEqual(['TextInputNode', 'TranslateGemmaTranslationNode', 'TextOutputNode']);
    expect(evidence.states).toEqual(['running']);
    expect(evidence.workers).toHaveLength(1);
    for (const worker of evidence.workers) {
      expect(worker.terminated).toBe(0);
      expect(worker.url).toBe(new URL(`../../translategemma-worker.js`, page.url()).href);
    }
    await page.locator('#cancel').click();
    expect(await page.evaluate(() => window.translationWorkers[0].terminated)).toBe(1);
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
      await expect(page.locator('#output')).toHaveText('English: fresh');
      expect(await page.evaluate(() => window.translationWorkers.map(w => w.terminated))).toEqual([1, 0]);
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


test('TranslateGemma missing GPU adapter is actionable and does not fetch runtime/model assets', async ({ page }) => {
  await workerGpuFixture(page, 'no-adapter');
  const downloads = []; page.on('request', request => {
    if (/vendor\/translation|huggingface\.co/.test(request.url())) downloads.push(request.url());
  });
  await page.goto('./nodes/translategemma/'); await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#errors')).toContainText('No WebGPU adapter'); expect(downloads).toEqual([]);
});
