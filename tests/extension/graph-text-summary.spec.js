import { settleAutoSave } from './ui-controls.js';
import { corruptSavedGraph, recoverAsNew } from './ui-controls.js';
import { test, expect, openGraph } from './graph-fixture.js';
import { openPalette } from './ui-controls.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TEXT_SUMMARY_TYPES, textSummaryModel } from '../../web/text-summary-models.js';

test('both text processors: parked Save persists, independent settings, cancellation/retry, cache reuse and no inference', async ({ graphExtension: f }) => {
  for (const type of TEXT_SUMMARY_TYPES) {
    const model = textSummaryModel(type), body = Buffer.alloc(8192, 21);
    // Cache lifecycle fixture only; never used as a working inference model.
    const files = [{ path: 'weights.bin', bytes: body.length, sha256Chunks: [createHash('sha256').update(body).digest('hex')], sourceURL: f.asset(model.key, body) }];
    await writeFile(path.join(f.root, 'extension', model.key + '-assets.json'), JSON.stringify(files));
  }
  const page = await openGraph(f), editor = page.editor;
  for (const type of TEXT_SUMMARY_TYPES) {
    await openPalette(editor); await editor.getByLabel('Node category', { exact: true }).selectOption({ label: 'Processors' });
    await editor.locator(`#graph-node-type [data-type="${type}"]`).click();
    await expect(editor.getByLabel(type.toLowerCase() + ' language', { exact: true })).toHaveValue('ja');
    const prompt = editor.getByLabel(type.toLowerCase() + ' prompt', { exact: true });
    await expect(prompt).toHaveJSProperty('tagName', 'TEXTAREA');
    await expect(prompt).toHaveValue('Summarize the input text.');
    await prompt.fill('Summarize in bullets.\nFocus on ' + type + '.'); await prompt.press('Tab');
    expect(await editor.locator('#graph-node-type [role="option"][data-type^="MeetingSummary"]').count()).toBe(0);
  }
  await editor.getByLabel('textsummaryqwen35 language', { exact: true }).selectOption('en');
  const cards = editor.locator('#graph-models .model-card').filter({ hasText: 'Text Summary' });
  const save = async () => { await settleAutoSave(editor);  };
  f.mode('corrupt'); await save();
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) await expect(card).toHaveAttribute('data-state', 'Error');
  await editor.reload();
  expect(await editor.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })().nodes.filter(n => n.type.startsWith('TextSummary')).map(n => n.settings.language))).toEqual(['ja', 'en']);
  expect(await editor.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })().nodes.filter(n => n.type.startsWith('TextSummary')).map(n => n.settings.prompt))).toEqual(TEXT_SUMMARY_TYPES.map(type => 'Summarize in bullets.\nFocus on ' + type + '.'));
  f.mode('hold'); await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await card.getByRole('button', { name: 'Retry preparation', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'Downloading');
    await card.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'Canceled');
  }
  f.mode('normal');
  for (const card of await cards.all()) {
    await card.getByRole('button', { name: 'Retry preparation', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'Ready');
  }
  const count = f.requests.length; await save();
  for (const card of await cards.all()) await expect(card).toHaveAttribute('data-state', 'Ready');
  expect(f.requests.length).toBe(count);
  expect(await page.evaluate(() => window.graphWorkers.filter(w => w.url.includes('text-summary-worker')).length)).toBe(0);
});

// Production module Worker + policy + cache-only loader, with a deterministic
// tokenizer/model runtime. This verifies wiring/bounds, not real model quality.
for (const type of TEXT_SUMMARY_TYPES) test(`${type}: saved prompt controls production Worker chat; generic fixtures and token/output failures`, async ({ graphExtension: f }) => {
  const spec = textSummaryModel(type), body = Buffer.from('{}');
  const files = ['tokenizer.json', 'tokenizer_config.json'].map(name => ({
    path: name, bytes: body.length, sha256Chunks: [createHash('sha256').update(body).digest('hex')], sourceURL: f.asset(spec.key + name, body),
  }));
  await writeFile(path.join(f.root, 'extension', spec.key + '-assets.json'), JSON.stringify(files));
  const workerFile = path.join(f.root, 'web/text-summary-worker.js');
  await writeFile(workerFile, `Object.defineProperty(navigator, 'gpu', {value: {requestAdapter: async () => ({features: new Set(['shader-f16'])})}});\n` + await readFile(workerFile, 'utf8'));
  const runtime = path.join(f.root, 'web/vendor/meeting-summary'); await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, 'transformers.js'), `
    export const env = {backends: {onnx: {wasm: {}}}};
    let messages, generation;
    export class PreTrainedTokenizer {
      constructor() {
        const encode = (formatted, options) => {
          if (options.truncation !== false || options.add_special_tokens !== false) throw Error('Unexpected truncation');
          return {input_ids: {dims: [1, formatted.includes('TOKEN_OVERFLOW') ? 7169 : formatted.includes('TOKEN_AT_LIMIT') ? 7168 : 100]}};
        };
        encode.apply_chat_template = (input, options) => {
          if (options.enable_thinking !== false || !options.add_generation_prompt) throw Error('Unexpected chat options');
          messages = input; return JSON.stringify(input);
        };
        encode.decode = () => {
          if (messages[0].content.includes('EMPTY_OUTPUT')) return '';
          if (messages[0].content.includes('OVERSIZED_OUTPUT')) return 'x'.repeat(6001);
          return JSON.stringify({messages, generation});
        };
        return encode;
      }
    }
    export const AutoModelForCausalLM = {async from_pretrained(id, options) {
      if (env.allowRemoteModels !== false || !env.useCustomCache || options.dtype !== 'q4f16' || options.device !== 'webgpu') throw Error('Unexpected model/cache options');
      return {generation_config: {eos_token_id: 2}, async generate({input_ids, max_new_tokens, do_sample, streamer}) {
        generation = {max_new_tokens, do_sample};
        if (messages[0].content.includes('MODEL_FAILURE')) throw Error('Controlled GPU failure');
        streamer.put(); streamer.put(); streamer.end();
        const tokens = messages[0].content.includes('OUTPUT_LIMIT') ? Array(1024).fill(1) : [1, 2];
        return {tolist: () => [[...Array(input_ids.dims[1]).fill(0), ...tokens]]};
      }};
    }};
  `);
  const live = await openGraph(f), editor = live.editor;
  await editor.evaluate(async type => {
    const { graphNode, GRAPH_VERSION } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');
    await saveLiveGraphData(localStorage, {version: GRAPH_VERSION, nodes: [graphNode(type, 'summary')], edges: []});
  }, type);
  await editor.reload(); await editor.getByRole('button', { name: 'Select summary', exact: true }).click();
  const savedPrompt = 'Summarize in two bullets.\nFocus on technical highlights.';
  await editor.getByLabel('summary prompt', { exact: true }).fill(savedPrompt);
  await editor.getByLabel('summary prompt', { exact: true }).press('Tab');
  await editor.getByLabel('summary language', { exact: true }).selectOption('en');
  await settleAutoSave(editor);
  await expect(editor.locator('#graph-models .model-card')).toHaveAttribute('data-state', 'Ready');
  const downloadPromise = editor.waitForEvent('download');
  await editor.locator('.graph-actions > summary').click(); await editor.locator('#graph-export').click();
  const exported = JSON.parse(await readFile(await (await downloadPromise).path(), 'utf8'));
  expect(exported.nodes[0].settings).toEqual({language: 'en', prompt: savedPrompt});
  await editor.getByLabel('summary prompt', { exact: true }).fill('Unsaved instruction.');
  await editor.getByLabel('summary prompt', { exact: true }).press('Tab');
  await live.evaluate(async type => {
    window.replies = [];
    const worker = window.summaryWorker = new Worker('../web/text-summary-worker.js', {type: 'module'});
    window.requestSummary = (type, fields) => new Promise(resolve => {
      const id = (window.requestId = (window.requestId || 0) + 1);
      const listener = ({data}) => { if (data.id === id && data.type !== 'progress') { worker.removeEventListener('message', listener); replies.push(data); resolve(data); } };
      worker.addEventListener('message', listener); worker.postMessage({type, id, ...fields});
    });
    const loaded = await requestSummary('load', {processor: type});
    if (loaded.type !== 'ready') throw Error(loaded.message);
  }, type);
  await live.evaluate(prompt => { window.savedInstruction = prompt; }, savedPrompt);
  const downloadsBeforeInference = f.requests.length;
  await f.context.setOffline(true);
  const fixtures = ['Article: The park opened in April.', 'Technical: Optimization completed in 12 ms.', 'A: Tea? B: Coffee, please.', 'Transcript: Ana sent a draft; Bo will review it.'];
  for (const text of fixtures) {
    const reply = await live.evaluate(async text => {
      return requestSummary('summarize', { text, prompt: window.savedInstruction, language: 'en' });
    }, text);
    expect(reply.type).toBe('result'); expect(reply.metrics.attempts).toHaveLength(1);
    const chat = JSON.parse(reply.summary);
    expect(chat.messages).toEqual([
      {role: 'system', content: savedPrompt + '\n\nUse English unless the instruction above requests another language.'},
      {role: 'user', content: JSON.stringify(text)},
    ]);
    expect(chat.generation).toEqual({max_new_tokens: 1024, do_sample: false});
  }
  await editor.locator('.graph-actions > summary').click();
  editor.once('dialog', dialog => dialog.accept());
  await editor.locator('input[type=file]').setInputFiles({ name: 'summary.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await editor.getByRole('button', { name: 'Select summary', exact: true }).click();
  await expect(editor.getByLabel('summary prompt', { exact: true })).toHaveValue(savedPrompt);
  const nextPrompt = 'Give a chronological summary in Japanese.';
  await editor.getByLabel('summary prompt', { exact: true }).fill(nextPrompt); await editor.getByLabel('summary prompt', { exact: true }).press('Tab');
  await settleAutoSave(editor);
  const next = await live.evaluate(async text => requestSummary('summarize', {text, ...(await import('./graph-library.js')).readLiveGraphData(localStorage).nodes[0].settings}), fixtures[0]);
  expect(JSON.parse(next.summary).messages[0].content).toBe(nextPrompt + '\n\nUse English unless the instruction above requests another language.');
  const atLimit = await live.evaluate(() => requestSummary('summarize', {text: 'Some text.', language: 'en', prompt: 'TOKEN_AT_LIMIT'}));
  expect(atLimit.type).toBe('result'); expect(atLimit.metrics.promptTokens).toBe(7168);
  for (const [prompt, error] of [['TOKEN_OVERFLOW', '8192-token'], ['OUTPUT_LIMIT', 'output token limit'], ['EMPTY_OUTPUT', 'empty or oversized'], ['OVERSIZED_OUTPUT', 'empty or oversized'], ['MODEL_FAILURE', 'Controlled GPU failure'], ['', 'prompt'], [42, 'prompt'], ['x'.repeat(4097), 'prompt']]) {
    const reply = await live.evaluate(prompt => requestSummary('summarize', {text: 'Some text.', language: 'en', prompt}), prompt);
    expect(reply.type).toBe('error'); expect(reply.message).toContain(error); expect(reply.summary).toBeUndefined();
  }
  await live.evaluate(() => summaryWorker.terminate());
  expect(f.requests.length).toBe(downloadsBeforeInference);
});

for (const [oldType, type] of [['MeetingSummaryLfm2', 'TextSummaryLfm2'], ['MeetingSummaryQwen35', 'TextSummaryQwen35']]) test(`${oldType}: recovery UI preserves original feedback graph through repair and import as new`, async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  const graph = JSON.parse(await readFile('docs/examples/incremental-text-summary.json', 'utf8'));
  graph.nodes.find(n => n.id === 'summary').type = oldType;
  delete graph.nodes.find(n => n.id === 'summary').settings.prompt;
  const original = JSON.stringify(graph);
  await corruptSavedGraph(editor, original); await editor.reload();
  await expect(editor.locator('#errors')).toContainText(type);
  await expect(editor.locator('#errors')).toContainText('settings.prompt');
  await editor.locator('.graph-actions > summary').click(); await editor.getByText('Saved JSON', {exact: true}).click();
  await expect(editor.getByLabel('Original saved graph JSON', {exact: true})).toHaveValue(original);
  expect(await editor.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).source; })())).toBe(original);
  graph.nodes.find(n => n.id === 'summary').type = type;
  graph.nodes.find(n => n.id === 'summary').settings.prompt = 'Update the previous summary using new text.';
  // No assets needed: persistence is independent of preparation errors.
  editor.once('dialog', dialog => dialog.accept());
  await editor.locator('input[type=file]').setInputFiles({name: 'recovered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph))});
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  await settleAutoSave(editor); await expect(editor.locator('#graph-save-error')).toContainText('original has been kept');
  await recoverAsNew(editor, graph);
  expect(await editor.evaluate(async () => (await import('./graph-library.js')).readLiveGraphData(localStorage))).toEqual(graph);
});
