import { openPalette, clickGraphAction } from './ui-controls.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph, startGraph } from './graph-fixture.js';

import { selectWhisper } from './whisper-fixture.js';

async function mockRuntime(f) {
  await mkdir(path.join(f.root, 'web/vendor/translation'), { recursive: true });
  await writeFile(path.join(f.root, 'web/vendor/translation/transformers.js'), `
    export const env={backends:{onnx:{wasm:{}}}};
    export async function pipeline(task,id,options) {
      if(task!=='automatic-speech-recognition'||id!=='tiny'||options.dtype!=='q8'||options.device!=='wasm')throw Error('Wrong Whisper model config');
      if(env.allowRemoteModels!==false||env.allowLocalModels!==true||env.useBrowserCache!==false||!env.localModelPath.endsWith('/vendor/whisper/'))throw Error('Remote model access enabled');
      return async (audio,opts)=>{
        if(!['en','ja'].includes(opts.language)||opts.task!=='transcribe'||opts.do_sample!==false)throw Error('Wrong inference config');
        if(audio[0]===.5)throw Error('Fixture decode error');
        return {text:opts.language+': '+audio.length};
      };
    }`);
  await writeFile(path.join(f.root, 'web/silero-worker.js'), `
    self.onmessage=({data:m})=>{
      if(m.type==='load')postMessage({type:'ready'});
      if(m.type==='vad-audio')postMessage({type:'vad',session:m.session,frames:[{audio:m.audio,speaking:true}]});
      if(m.type==='vad-stop')postMessage({type:'vad-stopped',session:m.session});
    };`);
}

test('MV3 Whisper worker routes completed PCM, binds Text language, freezes saves, drains and repeats', async ({ graphExtension: f }) => {
  await mockRuntime(f); const page = await openGraph(f); await selectWhisper(page, 'en');
  const editor = page.editor; await openPalette(editor);
  await expect(editor.getByRole('option', { name: 'ReazonSpeech ja-en ASR', exact: true })).toHaveCount(1);
  await expect(editor.getByRole('option', { name: 'Whisper tiny (multilingual) ASR', exact: true })).toHaveCount(1);
  await expect(editor.getByRole('button', { name: 'speech output final', exact: true })).toHaveCount(1);
  await expect(editor.getByRole('button', { name: 'speech output provisional', exact: true })).toHaveCount(0);
  await expect(editor.locator('[data-node="speech"] [data-side="output"]')).toHaveCount(1);
  await editor.locator('#graph-palette-toggle').click();
  await editor.getByRole('button', { name: 'Select language', exact: true }).click();
  await expect(editor.getByLabel('language value', { exact: true })).toHaveValue('en');
  await startGraph(page);
  await page.evaluate(() => window.capture.emit('audio', new Float32Array(96000).fill(.1)));
  await expect(page.locator('.display-content')).toHaveText(['en: 96000'].join('\n'));

  await editor.getByLabel('language value', { exact: true }).fill('ja'); await editor.locator('#graph-save').click();
  await expect(editor.locator('#graph-state')).toContainText('earlier graph');
  await page.evaluate(() => window.capture.emit('audio', new Float32Array(37).fill(.1)));
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('.display-content')).toHaveText(['en: 96000', 'en: 37'].join('\n'));
  expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
  await startGraph(page); await page.evaluate(() => window.capture.emit('audio', new Float32Array(37).fill(.1)));
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('.display-content')).toHaveText(['ja: 37'].join('\n'));
  await editor.reload(); await editor.getByRole('button', { name: 'Select language', exact: true }).click();
  await expect(editor.getByLabel('language value', { exact: true })).toHaveValue('ja');
  for (const invalid of ['', 'fr', 'EN']) {
    await editor.getByLabel('language value', { exact: true }).fill(invalid); await editor.locator('#graph-save').click();
    await expect(editor.locator('#graph-save')).toBeEnabled();
    await page.evaluate(() => window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
    await expect(page.locator('#errors')).toContainText('Whisper.language must be en or ja');
    await expect(page.locator('#start')).toBeEnabled();
  }
  expect(f.requests).toEqual([]);
});

test('MV3 palette and help offer only the implemented Whisper output; ReazonSpeech retains preview and final', async ({ graphExtension: f }) => {
  const page = await openGraph(f), editor = page.editor;
  await expect(editor.getByRole('button', { name: 'speech output provisional', exact: true })).toHaveCount(1);
  await expect(editor.getByRole('button', { name: 'speech output final', exact: true })).toHaveCount(1);
  await openPalette(editor); await editor.locator('#graph-node-type').selectOption('SpeechToTextWhisper');
  await editor.locator('#graph-add').click();
  const card = editor.locator('[data-node="speechtotextwhisper"]');
  await expect(card.locator('[data-side="output"]')).toHaveCount(1);
  await expect(card.locator('[data-side="output"][data-port="final"]')).toHaveCount(1);
  await editor.locator('.graph-inspector summary').click();
  await expect(editor.locator('.graph-inspector')).toContainText('Output final: text');
  await expect(editor.locator('.graph-inspector')).not.toContainText('Output provisional');
});

for (const unsafe of [false, true]) test(`MV3 v7 Whisper migration ${unsafe ? 'keeps an incomplete destination as a saved draft' : 'saves only the version and removal of dead edges'}`, async ({ graphExtension: f }) => {
  const page = await openGraph(f), editor = page.editor;
  const original = await page.evaluate(async unsafe => {
    const { defaultGraph, graphNode, edge, GRAPH_KEY } = await import('./graph.js');
    const graph = defaultGraph(); graph.version = 7; graph.nodes[1].type = 'SpeechToTextWhisper';
    graph.nodes[1].position = { x: 333, y: 111 }; graph.nodes[2].settings.label = 'Saved custom label';
    if (unsafe) {
      graph.nodes.push(graphNode('LiveTextDisplay', 'affected', 123, 456));
      graph.edges.push(edge('speech', 'provisional', 'affected', 'replace'));
    }
    localStorage.setItem(GRAPH_KEY, JSON.stringify(graph)); return graph;
  }, unsafe);
  const raw = JSON.stringify(original), expected = structuredClone(original); expected.version = 13;
  expected.edges = expected.edges.filter(route => route.from[1] !== 'provisional');
  await editor.reload();
  await expect(editor.getByRole('button', { name: 'speech output provisional', exact: true })).toHaveCount(0);
  const saved = () => editor.evaluate(() => localStorage.getItem('processing-graph-v1'));
  if (unsafe) {
    await expect(editor.locator('#errors')).toContainText('requires review');
    await expect(editor.locator('#graph-errors')).toBeEmpty();
    await expect(editor.getByRole('button', { name: 'Select affected', exact: true })).toHaveCount(1);
    await expect(editor.locator('[data-node="speech"]')).toHaveCSS('left', '333px');
  }
  await expect(editor.locator('#errors')).toContainText('requires review');
  expect(await saved()).toBe(raw);
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  expect(JSON.parse(await saved())).toEqual(expected);
  await editor.reload(); await expect(editor.locator('#graph-errors')).toBeEmpty();
  expect(await saved()).toBe(JSON.stringify(expected));
});

test('MV3 Text literal and empty values round-trip and deliver once to an ordinary TEXT consumer', async ({ graphExtension: f }) => {
  const page = await openGraph(f), editor = page.editor;
  await openPalette(editor); await editor.locator('#graph-node-type').selectOption('Text'); await editor.locator('#graph-add').click();
  await editor.getByRole('button', { name: 'text output value', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'speech input audio', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'transcript-dom input text', exact: true }).click();
  for (const value of ['<img src=x onerror=alert(1)> & "\n😀 {1}', '']) {
    await editor.getByLabel('text value', { exact: true }).fill(value); await editor.locator('#graph-save').click();
    await expect(editor.locator('#graph-save')).toBeEnabled();
    await expect(editor.locator('#graph-errors')).toBeEmpty();
    // Reload only after the asynchronous Web Lock save has persisted the literal.
    await expect.poll(() => editor.evaluate(() =>
      JSON.parse(localStorage.getItem('processing-graph-v1')).nodes.find(node => node.id === 'text')?.settings.value
    )).toBe(value);
    await editor.reload(); await editor.getByRole('button', { name: 'Select text', exact: true }).click();
    await expect(editor.getByLabel('text value', { exact: true })).toHaveValue(value);
    await page.evaluate(() => window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
    await expect(page.locator('#status')).toHaveText('Processing active');
    await expect(page.locator('.display-content')).toHaveText(value);
    await expect(page.locator('.display-content img')).toHaveCount(0);
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  }
});

for (const duringStop of [false, true]) test(`MV3 Whisper Cancel ignores an in-flight final${duringStop ? ' during Stop' : ''}`, async ({ graphExtension: f }) => {
  await mockRuntime(f); const page = await openGraph(f); await selectWhisper(page);
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(data, ...rest) {
      if(data.type==='decode') { window.pendingWorker=this; window.pendingDecode=data; return; }
      return post.call(this,data,...rest);
    };
  });
  await startGraph(page); await page.evaluate(() => window.capture.emit('audio', new Float32Array(96000).fill(.1)));
  await expect.poll(() => page.evaluate(() => !!window.pendingDecode)).toBe(true);
  if (duringStop) await page.locator('#stop').click();
  await page.evaluate(() => { window.lateCallback=window.pendingWorker.onmessage; });
  await page.locator('#cancel-session').click(); await expect(page.locator('#start')).toBeEnabled();
  await page.evaluate(() => window.lateCallback({ data: { type: 'final', session: window.pendingDecode.session, id: window.pendingDecode.id, text: 'late' } }));
  await expect(page.locator('.display-content')).toBeEmpty();
  expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});

test('MV3 Whisper decode and missing model errors release workers and permit retry', async ({ graphExtension: f }) => {
  await mockRuntime(f); const page = await openGraph(f); await selectWhisper(page);
  await startGraph(page); await page.evaluate(() => window.capture.emit('audio', new Float32Array(96000).fill(.5)));
  await expect(page.locator('#errors')).toContainText('Fixture decode error');
  await expect(page.locator('#status')).toHaveText('Transcription active');
  await page.locator('#cancel-session').click(); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
  await startGraph(page); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await writeFile(path.join(f.root, 'web/vendor/translation/transformers.js'), `export const env={backends:{onnx:{wasm:{}}}}; export async function pipeline(){throw Error('Missing packaged model');}`);
  await page.reload();
  await page.evaluate(() => window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
  await expect(page.locator('#errors')).toContainText('Missing packaged model'); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});
