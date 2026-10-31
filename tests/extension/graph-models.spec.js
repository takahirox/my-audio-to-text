import { test, expect, openGraph } from './graph-fixture.js';
import { openPalette } from './ui-controls.js';

const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
async function add(editor, type, settings = {}) {
  await openPalette(editor); await editor.locator('#graph-node-type').selectOption(type); await editor.locator('#graph-add').click();
  for (const [name, value] of Object.entries(settings)) await editor.getByLabel(`${type.toLowerCase()} ${name}`, { exact: true }).selectOption(value);
}
async function save(editor) {
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await expect(editor.locator('#graph-state')).not.toContainText('Unsaved draft');
}
const cards = editor => editor.locator('#graph-models .model-card');

test('direct palette/canvas/help use ordinary Text formatter; Graph actions has no translation preset', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await openPalette(editor);
  await expect(editor.locator('option[value=PairedTextFormatter]')).toHaveCount(0);
  await add(editor, 'TextFormatter');
  await expect(editor.locator('[data-node=textformatter] .graph-heading')).toHaveText('Text formatter');
  await editor.getByText('Node help and ports', { exact: true }).click();
  await expect(editor.locator('.graph-inspector')).not.toContainText('compatibility');
  await editor.locator('.graph-actions > summary').click();
  await expect(editor.locator('.graph-actions')).not.toContainText('Translation preset');
  await expect(editor.locator('#translation-enabled, #translation-direction, #graph-translation')).toHaveCount(0);
  await save(editor); expect(f.requests).toEqual([]);
});

test('Save prepares only saved English → Japanese Nodes once, after persistence, without capture or Workers; verified cache reuse and invalid cache retry', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.evaluate(() => {
    window.beforePersistence = [];
    const nativeFetch = window.fetch;
    window.fetch = (...args) => {
      if (String(args[0]).startsWith('http://127.0.0.1')) window.beforePersistence.push(!JSON.parse(localStorage.getItem('processing-graph-v1')).nodes.some(node => node.type === 'OpusMtEnJa'));
      return nativeFetch(...args);
    };
    navigator.mediaDevices.getUserMedia = () => { throw Error('Save must not capture'); };
  });
  await add(editor, 'OpusMtEnJa'); await add(editor, 'OpusMtEnJa');
  expect(f.requests).toEqual([]); expect((await saved(live)).nodes).toHaveLength(7);
  await save(editor); await expect(cards(editor)).toHaveCount(1);
  await expect(cards(editor).locator('.model-status')).toContainText('Ready');
  expect(f.requests).toHaveLength(7); expect(f.requests.every(url => url.startsWith('/opus-mt-en-ja-assets.json/'))).toBe(true);
  expect(await editor.evaluate(() => window.beforePersistence)).toEqual(Array(7).fill(false));
  expect(await editor.evaluate(() => window.graphWorkers.length)).toBe(0);
  expect(await live.evaluate(() => window.graphWorkers.length)).toBe(0);
  const before = await saved(live); expect(before.version).toBe(15); expect(before.edges).toHaveLength(7);
  await save(editor); await expect(cards(editor).locator('.model-status')).toContainText('Ready'); expect(f.requests).toHaveLength(7);
  for (const corrupt of [true, false]) {
    await editor.evaluate(async corrupt => {
      const { englishToJapaneseOpusMtManifest } = await import('./opus-mt-en-ja-manifest.js');
      const manifest = await englishToJapaneseOpusMtManifest(), cache = await caches.open('transformers-cache'), file = manifest.files[0];
      if (corrupt) await cache.put(file.url, new Response(new Uint8Array(file.bytes)));
      else await cache.delete(file.url);
    }, corrupt);
    await cards(editor).getByRole('button', { name: 'Check cache', exact: true }).click();
    await expect(cards(editor).locator('.model-status')).toHaveText('Not downloaded');
    await cards(editor).getByRole('button', { name: 'Retry preparation', exact: true }).click();
    await expect(cards(editor).locator('.model-status')).toContainText('Ready');
  }
  expect(f.requests).toHaveLength(9); expect(await saved(live)).toEqual(before);
  await expect(live.models.locator('#opus-en-ja .model-status')).toContainText('Ready');
  await expect(live.models.locator('#opus-ja-en .model-status')).toHaveText('Not downloaded');
});

test('no optional model requests on load, invalid Save, storage failure or a saved graph containing only packaged ASR', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor, before = await saved(live);
  await save(editor); expect(f.requests).toEqual([]);
  await add(editor, 'OpusMtEnJa'); await add(editor, 'Number');
  await editor.getByLabel('number value', { exact: true }).fill('');
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-errors')).toContainText('finite number');
  expect(await saved(live)).toEqual(before); expect(f.requests).toEqual([]); await expect(cards(editor)).toHaveCount(0);
  await editor.getByLabel('number value', { exact: true }).fill('6');
  await editor.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'processing-graph-v1') throw Error('Fixture storage unavailable'); return set.call(this, key, value); };
    window.restoreStorage = () => { Storage.prototype.setItem = set; };
  });
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-errors')).toContainText('storage unavailable');
  expect(await saved(live)).toEqual(before); expect(f.requests).toEqual([]); await expect(cards(editor)).toHaveCount(0);
  await editor.evaluate(() => window.restoreStorage());
  await save(editor); await expect(cards(editor).locator('.model-status')).toContainText('Ready');
  const count = f.requests.length; await editor.reload(); expect(f.requests).toHaveLength(count); await expect(cards(editor)).toHaveCount(0);
});

test('multiple parked model types and voices prepare distinct sets once and reuse shared weights', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  for (const [type, settings] of [['OpusMtJaEn', {}], ['OpusMtEnJa', {}], ['Supertonic3', {}], ['Supertonic3', {}], ['Supertonic3', {}], ['Kokoro', {}], ['Kokoro', {}]]) await add(editor, type, settings);
  // Individual inspector settings, including a different language with the same
  // voice, choose equivalent weights without modifying any routes.
  for (const [id, settings] of [['supertonic3-1', { language: 'en' }], ['supertonic3-2', { voice: 'M1' }], ['kokoro-1', { voice: 'af_heart' }]]) {
    await editor.getByRole('button', { name: `Select ${id}`, exact: true }).click();
    for (const [name, value] of Object.entries(settings)) await editor.getByLabel(`${id} ${name}`, { exact: true }).selectOption(value);
  }
  expect(f.requests).toEqual([]); await save(editor);
  await expect(cards(editor)).toHaveCount(6);
  await expect(cards(editor).locator('.model-status')).toHaveText(Array(6).fill('Ready · Cached and verified'));
  expect(new Set(f.requests).size).toBe(f.requests.length);
  for (const voice of ['F1.json', 'M1.json', 'jf_alpha.bin', 'af_heart.bin']) expect(f.requests.some(url => url.endsWith(voice))).toBe(true);
  expect((await saved(live)).edges).toHaveLength(7);
  const count = f.requests.length; await save(editor);
  await expect(cards(editor).locator('.model-status')).toHaveText(Array(6).fill('Ready · Cached and verified'));
  expect(f.requests).toHaveLength(count); expect(await editor.evaluate(() => window.graphWorkers.length)).toBe(0);
});

for (const mode of ['error', 'short', 'corrupt']) test(`Save remains persisted after ${mode} download failure; editor retry recovers`, async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  f.mode(mode); await add(editor, 'OpusMtEnJa'); await save(editor);
  await expect(cards(editor).locator('.model-status')).toHaveText('Error');
  await expect(cards(editor).locator('.model-error')).not.toBeEmpty();
  const before = await saved(live); expect(before.nodes.some(node => node.type === 'OpusMtEnJa')).toBe(true);
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  f.mode('normal'); await cards(editor).getByRole('button', { name: 'Retry preparation', exact: true }).click();
  await expect(cards(editor).locator('.model-status')).toContainText('Ready'); expect(await saved(live)).toEqual(before);
});

test('byte progress, Cancel, newer Save and page teardown preserve storage and allow Models recovery', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  f.mode('hold'); await add(editor, 'OpusMtEnJa'); await save(editor);
  await expect.poll(() => cards(editor).locator('progress').evaluate(progress => progress.value)).toBeGreaterThan(0);
  const before = await saved(live);
  await cards(editor).getByRole('button', { name: 'Cancel preparation', exact: true }).click();
  await expect(cards(editor).locator('.model-status')).toHaveText('Canceled'); expect(await saved(live)).toEqual(before);
  await cards(editor).getByRole('button', { name: 'Retry preparation', exact: true }).click();
  await expect(cards(editor).locator('.model-status')).toHaveText('Downloading');
  await save(editor); await expect(cards(editor).locator('.model-status')).toHaveText('Downloading');
  await expect.poll(() => cards(editor).locator('progress').evaluate(progress => progress.value)).toBeGreaterThan(0);
  await editor.close(); f.mode('normal');
  const models = live.models.locator('#opus-en-ja');
  await models.getByRole('button', { name: 'Download / retry', exact: true }).click();
  await expect(models.locator('.model-status')).toContainText('Ready'); expect(await saved(live)).toEqual(before);
});

test('a Save in another editor cancels obsolete preparation without downloading on load or mutating a dirty draft', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  f.mode('hold'); await add(editor, 'OpusMtEnJa'); await save(editor);
  await expect.poll(() => cards(editor).locator('progress').evaluate(progress => progress.value)).toBeGreaterThan(0);
  await add(editor, 'Text'); // Keep this unsaved draft across the external Save.
  const other = await f.context.newPage(); await other.goto(editor.url());
  expect(f.requests).toHaveLength(1);
  await other.getByRole('button', { name: 'Select opusmtenja', exact: true }).click();
  await other.getByRole('button', { name: 'Remove opusmtenja', exact: true }).click();
  await save(other); await expect(cards(editor)).toHaveCount(0);
  await expect(editor.locator('#graph-state')).toContainText('draft kept');
  await expect(editor.locator('[data-node=text]')).toHaveCount(1);
  await expect(editor.locator('[data-node=opusmtenja]')).toHaveCount(1);
  expect((await saved(live)).nodes).toHaveLength(7);
  await editor.locator('#graph-save').click();
  await expect(editor.locator('#graph-errors')).toContainText('Load saved');
  expect(f.requests).toHaveLength(1);
});


test('formatter instances add inputs above four, preserve wires, validate edits and reload independently', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await add(editor, 'TextFormatter'); await add(editor, 'TextFormatter');
  await editor.getByRole('button', { name: 'Select textformatter', exact: true }).click();
  for (let i = 0; i < 3; i++) await editor.getByRole('button', { name: 'textformatter Add input', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'textformatter input input7', exact: true })).toBeVisible();
  await expect(editor.locator('[data-node=textformatter-1] [data-side=input]')).toHaveCount(4);
  await editor.getByRole('button', { name: 'speech output final', exact: true }).click();
  await editor.getByRole('button', { name: 'textformatter input input1', exact: true }).click();
  await editor.getByRole('button', { name: 'speech output final', exact: true }).click();
  await editor.getByRole('button', { name: 'textformatter input input7', exact: true }).click();
  const template = editor.getByLabel('textformatter template', { exact: true });
  await template.fill('English: {1}\nJapanese: {7}\n{{literal}}'); await template.blur(); await save(editor);
  const before = await saved(live);
  await editor.getByRole('button', { name: 'textformatter Remove last input', exact: true }).click();
  await expect(editor.locator('#graph-errors')).toContainText('Input {7} is not configured');
  await expect(template).toHaveValue('English: {1}\nJapanese: {7}\n{{literal}}');
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  expect(await saved(live)).toEqual(before);
  await template.fill('{1}\n{6}'); await template.blur(); await save(editor);
  const graph = await saved(live);
  expect(graph.nodes.find(n => n.id === 'textformatter').settings.inputCount).toBe(6);
  expect(graph.nodes.find(n => n.id === 'textformatter-1').settings.inputCount).toBe(4);
  expect(graph.edges).toContainEqual({ from: ['speech', 'final'], to: ['textformatter', 'input1'] });
  expect(graph.edges.some(e => e.to[1] === 'input7')).toBe(false);
  await template.fill('{bad}'); await template.blur(); await editor.locator('#graph-save').click();
  await expect(editor.locator('#graph-errors')).toContainText('literal braces'); expect(await saved(live)).toEqual(graph);
  await editor.reload(); expect(await saved(live)).toEqual(graph);
  await expect(editor.locator('[data-node=textformatter] [data-side=input]')).toHaveCount(6);
});
