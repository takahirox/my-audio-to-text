import { test, expect, openGraph, startGraph } from './graph-fixture.js';
import { selectZipformer } from './zipformer-fixture.js';
import { openPalette } from './ui-controls.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function runtime(f) {
  const root = path.join(f.root, 'web/vendor/zipformer-en'); await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'sherpa-onnx-asr.js'), `
    class OnlineRecognizer {
      constructor(config){if(config.enableEndpoint!==0||config.modelConfig.numThreads!==1)throw Error('Wrong online config');this.handle=1;}
      createStream(){return {count:0,speech:false,acceptWaveform(rate,a){if(a[0]===.5)throw Error('Fixture online decode failure');this.count+=a.length;this.speech||=a.some(n=>n!==0);this.ready=true;},inputFinished(){},free(){}};}
      isReady(s){return s.ready;} decode(s){s.ready=false;}
      getResult(s){return {text:s.speech?'english '+s.count:''};} free(){}
    }`);
  await writeFile(path.join(root, 'sherpa-onnx-wasm-main-asr.js'), 'Module.HEAPU8=new Uint8Array(1);Module.onRuntimeInitialized();');
}

test('MV3 searchable palette, typed audio/TEXT routes and help; production online Worker drains and repeats', async ({ graphExtension: f }) => {
  await runtime(f); const page = await openGraph(f); await selectZipformer(page);
  const editor = page.editor; await openPalette(editor);
  await editor.getByRole('searchbox', { name: 'Search nodes' }).fill('zipformer');
  await expect(editor.getByRole('option', { name: 'Streaming Zipformer English ASR', exact: true })).toHaveCount(1);
  await editor.locator('#graph-palette-toggle').click();
  await expect(editor.getByRole('button', { name: 'speech input audio', exact: true })).toHaveCount(1);
  await expect(editor.locator('[data-node="speech"] [data-side="input"]')).toHaveCount(1);
  await expect(editor.locator('[data-node="speech"] [data-side="output"]')).toHaveCount(2);
  // Exercise the editor's real connection gesture for all three public routes.
  for (const [source, output, target, input] of [['audio', 'audio', 'speech', 'audio'], ['speech', 'provisional', 'transcript-preview', 'text'], ['speech', 'final', 'transcript-accumulator', 'append']]) {
    await editor.getByRole('button', { name: `${source} output ${output}`, exact: true }).click();
    await editor.getByRole('button', { name: `${target} input ${input}`, exact: true }).click();
  }
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await editor.getByRole('button', { name: 'Select speech', exact: true }).click();
  await expect(editor.locator('.graph-inspector')).toContainText('real online CPU WASM');
  for (let i = 0; i < 2; i++) {
    await startGraph(page);
    await page.evaluate(() => window.capture.emit('audio', new Float32Array(3200).fill(.1)));
    await expect(page.locator('.display-content')).toHaveText('english 3200');
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();

    await expect(page.locator('.display-content')).toHaveText(['english 16000'].join('\n'));
    expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
  }
  expect(f.requests).toEqual([]);
});

for (const duringStop of [false, true]) test(`MV3 Zipformer Cancel releases in-flight audio${duringStop ? ' during Stop' : ''}`, async ({ graphExtension: f }) => {
  await runtime(f); const page = await openGraph(f); await selectZipformer(page);
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(data, ...rest) {
      if(data.type==='audio') { window.pendingWorker=this; window.pendingAudio=data; return; }
      return post.call(this,data,...rest);
    };
  });
  await startGraph(page); await page.evaluate(() => window.capture.emit('audio', new Float32Array(1600).fill(.1)));
  await expect.poll(() => page.evaluate(() => !!window.pendingAudio)).toBe(true);
  await page.evaluate(() => { window.lateCallback=window.pendingWorker.onmessage; });
  if (duringStop) await page.locator('#stop').click();
  await page.locator('#cancel-session').click(); await expect(page.locator('#start')).toBeEnabled();
  await page.evaluate(() => window.lateCallback({ data: { type: 'final', session: 1, id: 0, text: 'late' } }));
  await expect(page.locator('.display-content')).toBeEmpty();
  expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});

test('MV3 online inference failure releases Worker and permits a fresh recording; missing runtime fails during readiness', async ({ graphExtension: f }) => {
  await runtime(f); const page = await openGraph(f); await selectZipformer(page);
  await startGraph(page); await page.evaluate(() => window.capture.emit('audio', new Float32Array(1600).fill(.5)));
  await expect(page.locator('#errors')).toContainText('Fixture online decode failure');
  await expect(page.locator('#status')).toHaveText('Transcription active');
  await page.locator('#cancel-session').click(); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
  await startGraph(page); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await writeFile(path.join(f.root, 'web/vendor/zipformer-en/sherpa-onnx-wasm-main-asr.js'), `throw Error('Missing pinned runtime');`);
  await page.reload(); await page.evaluate(() => window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
  await expect(page.locator('#errors')).toContainText('Missing pinned runtime'); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});
