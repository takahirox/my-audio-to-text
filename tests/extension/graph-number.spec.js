import { openPalette } from './ui-controls.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph, startGraph } from './graph-fixture.js';

async function openNumberGraph(f) {
  // Replace only heavyweight model initialization/inference. Keep the packaged
  // graph, Number, source routing, ASR core, segment policy and display Nodes.
  await writeFile(path.join(f.root, 'web/silero-worker.js'), `
    self.onmessage=({data:m})=>{
      if(m.type==='load')postMessage({type:'ready'});
      if(m.type==='vad-audio')postMessage({type:'vad',session:m.session,frames:[{audio:m.audio,speaking:true}]});
      if(m.type==='vad-stop')postMessage({type:'vad-stopped',session:m.session});
    };`);
  await writeFile(path.join(f.root, 'web/sherpa-worker.js'), `
    self.onmessage=({data:m})=>{
      if(m.type==='load')postMessage({type:'ready'});
      if(m.type==='decode'){
        postMessage({type:m.final?'final':'partial',session:m.session,id:m.id,text:'segment '+m.id+': '+m.audio.length});
        postMessage({type:'decoded',session:m.session});
      }
    };`);
  const page = await openGraph(f);
  await page.evaluate(async () => {
    const { ExtensionTabAudioNode } = await import('./tab-audio-node.js');
    ExtensionTabAudioNode.prototype.start = function(context) {
      window.capture = context; window.capBeforeCapture = window.speech.core.simulation.maxSamples;
    };
    ExtensionTabAudioNode.prototype.stop = function() { window.capture.emit('audio', new Float32Array(37).fill(.07)); };
    window.decodeRequests = [];
    const post = window.Worker.prototype.postMessage;
    window.Worker.prototype.postMessage = function(data, ...args) {
      if(data.type === 'decode') {
        window.decodeRequests.push({ id: data.id, final: data.final, audio: Array.from(data.audio) });
        if(window.holdDecode) return;
      }
      return post.call(this, data, ...args);
    };
  });
  return page;
}
const feed = (page, length, value = .05) => page.evaluate(({ length, value }) => {
  window.capture.emit('audio', new Float32Array(length).fill(value));
}, { length, value });
const save = async editor => { await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled(); };

test('packaged Number edge edits, validates, reloads and freezes the cap before ChromeTabAudio starts', async ({ graphExtension: f }) => {
  const page = await openNumberGraph(f), editor = page.editor;
  await startGraph(page);
  expect(await page.evaluate(() => window.capBeforeCapture)).toBe(96000);
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await openPalette(editor); await editor.locator('#graph-node-type').selectOption('Number'); await editor.locator('#graph-add').click();
  await editor.getByLabel('number value', { exact: true }).fill('1.25');
  await editor.getByRole('button', { name: 'number output value', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'speech input audio', exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'transcript input append', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'speech input maxDuration', exact: true }).click();
  await expect(editor.locator('#graph-errors')).toBeEmpty(); await save(editor);
  await editor.reload(); await editor.getByRole('button', { name: 'Select number', exact: true }).click();
  await expect(editor.getByLabel('number value', { exact: true })).toHaveValue('1.25');
  for (const value of ['', '0', '-1', '0.5', '12.1', '99999']) {
    await editor.getByLabel('number value', { exact: true }).fill(value);
    await save(editor); await expect(editor.locator('#graph-errors')).toContainText(value === '' ? 'finite number' : '1 to 12 seconds');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')).nodes.find(n => n.type === 'Number').settings.value)).toBe(1.25);
  }
  await editor.getByLabel('number value', { exact: true }).fill('1.25'); await save(editor);
  await startGraph(page); expect(await page.evaluate(() => window.capBeforeCapture)).toBe(20000);
  await page.evaluate(() => { window.decodeRequests = []; });
  await feed(page, 8000); await expect(page.locator('.display-preview')).toHaveText('segment 1: 8000');
  await editor.getByLabel('number value', { exact: true }).fill('2.5'); await save(editor);
  await expect(editor.locator('#graph-state')).toContainText('earlier graph');
  await feed(page, 36000, .06);
  await expect(page.locator('.display-items li pre')).toHaveText(['segment 1: 20000', 'segment 2: 20000']);
  await expect(page.locator('.display-preview')).toBeEmpty();
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('.display-items li pre')).toHaveText(['segment 1: 20000', 'segment 2: 20000', 'segment 3: 4037']);
  const finals = await page.evaluate(() => window.decodeRequests.filter(m => m.final));
  expect(finals.map(m => m.id)).toEqual([1, 2, 3]);
  const samples = finals.flatMap(m => m.audio);
  for (const [a, b, value] of [[0, 8000, .05], [8000, 44000, .06], [44000, 44037, .07]]) {
    expect(samples.slice(a, b).every(s => Math.abs(s - value) < 1e-6)).toBe(true);
  }
  expect(samples.length).toBe(44037);
  await startGraph(page); expect(await page.evaluate(() => window.capBeforeCapture)).toBe(40000);
  await feed(page, 40000); await expect(page.locator('.display-items li pre')).toHaveText(['segment 1: 40000']);
  await page.locator('#cancel-session').click(); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
  expect(f.requests).toEqual([]);
});

for (const stop of [false, true]) test(`packaged Cancel with a cap final pending${stop ? ' during Stop' : ''} releases workers and rejects late results`, async ({ graphExtension: f }) => {
  const page = await openNumberGraph(f);
  await startGraph(page); await page.evaluate(() => { window.holdDecode = true; });
  await feed(page, 96000);
  await expect.poll(() => page.evaluate(() => window.decodeRequests.length)).toBe(1);
  expect(await page.evaluate(() => window.decodeRequests[0].final)).toBe(true);
  if (stop) { await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Finalizing graph outputs'); }
  await page.evaluate(() => { window.callbacks = window.graphWorkers.map(w => w.onmessage); });
  await page.locator('#cancel-session').click(); await expect(page.locator('#start')).toBeEnabled();
  await page.evaluate(() => window.callbacks.forEach(callback => callback({ data: { type: 'final', id: 1, session: 1, text: 'late' } })));
  await expect(page.locator('.display-items li')).toHaveCount(0); await expect(page.locator('.display-preview')).toBeEmpty();
  expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});
