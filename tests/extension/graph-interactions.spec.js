import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph, startGraph, emitFinal } from './graph-fixture.js';

const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
const port = (page, node, side, name) => page.getByRole('button', { name: `${node} ${side} ${name}`, exact: true });
async function save(page) {
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  await expect(page.locator('#graph-state')).not.toContainText('Unsaved draft');
}

for (const zoom of ['0.5', '1', '1.5']) {
  test(`canvas wire selection and precise keyboard removal at ${zoom} zoom; Connections remains keyboard usable`, async ({ graphExtension: f }) => {
    const live = await openGraph(f), editor = live.editor, before = await saved(live);
    await editor.setViewportSize({ width: 1600, height: 1000 });
    await editor.getByRole('button', { name: 'Select audio', exact: true }).click();
    await editor.locator('#graph-zoom').selectOption(zoom);
    const wire = editor.getByRole('button', { name: 'Select connection audio.audio to speech.audio', exact: true });
    const point = await wire.locator('.wire-hit').evaluate(path => {
      const point = path.getPointAtLength(path.getTotalLength() / 2), matrix = path.getScreenCTM();
      return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f + 6 };
    });
    // Six screen pixels off the visible stroke still selects its enlarged hit target.
    await editor.mouse.click(point.x, point.y);
    await expect(wire).toHaveAttribute('aria-pressed', 'true'); await expect(wire).toHaveClass(/selected-wire/);
    await expect(editor.locator('.selected-node')).toHaveCount(0);
    await editor.keyboard.press(zoom === '1' ? 'Backspace' : 'Delete');
    await expect(wire).toHaveCount(0);
    await expect(editor.locator('#graph-connections li')).toHaveCount(before.edges.length - 1);
    await port(editor, 'audio', 'output', 'audio').click(); await port(editor, 'speech', 'input', 'audio').click();
    await save(editor);
    const restored = await saved(live);
    expect(restored.nodes).toEqual(before.nodes);
    expect(restored.edges).toEqual([...before.edges.slice(1), before.edges[0]]);
    const disconnect = editor.getByRole('button', { name: 'Disconnect speech.provisional to transcript.provisional', exact: true });
    await disconnect.focus(); await disconnect.press('Enter');
    await save(editor);
    expect((await saved(live)).edges).toEqual(restored.edges.filter(e => !(e.to[0] === 'transcript' && e.to[1] === 'provisional')));
    expect((await saved(live)).nodes).toEqual(before.nodes);
  });
}

test('click and drag reconnect a populated input, preserving fan-out; identical and invalid attempts keep old edge', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor, original = await saved(live);
  await editor.setViewportSize({ width: 1600, height: 1000 });
  const output = name => port(editor, 'speech', 'output', name), input = port(editor, 'translation', 'input', 'text');
  await output('provisional').click(); await input.click(); await save(editor);
  let graph = await saved(live);
  expect(graph.edges.filter(e => e.to[0] === 'translation' && e.to[1] === 'text')).toEqual([{ from: ['speech', 'provisional'], to: ['translation', 'text'] }]);
  expect(graph.edges.filter(e => !(e.to[0] === 'translation' && e.to[1] === 'text'))).toEqual(original.edges.filter(e => !(e.to[0] === 'translation' && e.to[1] === 'text')));
  await output('provisional').click(); await input.click();
  await expect(editor.locator('#graph-state')).not.toContainText('Unsaved draft');
  await output('final').dragTo(input); await save(editor);
  graph = await saved(live);
  expect(graph.edges.filter(e => e.to[0] === 'translation' && e.to[1] === 'text')).toEqual([{ from: ['speech', 'final'], to: ['translation', 'text'] }]);
  await output('final').dragTo(input); await expect(editor.locator('#graph-state')).not.toContainText('Unsaved draft');
  await port(editor, 'translation', 'output', 'text').click(); await expect(input).toBeDisabled(); await editor.keyboard.press('Escape');
  await port(editor, 'audio', 'output', 'audio').click(); await expect(input).toBeDisabled(); await editor.keyboard.press('Escape');
  // Even a programmatically delivered invalid drop cannot discard the occupied edge.
  await port(editor, 'audio', 'output', 'audio').dispatchEvent('dragstart', { dataTransfer: await editor.evaluateHandle(() => new DataTransfer()) });
  await input.dispatchEvent('drop'); await editor.keyboard.press('Escape');
  await expect(editor.locator('#graph-state')).not.toContainText('Unsaved draft');
  await expect(editor.locator('#graph-errors')).toBeEmpty(); expect(await saved(live)).toEqual(graph);
});

async function fixtureTranslation(f, live) {
  for (const file of ['opus-mt-worker.js', 'opus-mt-en-ja-worker.js']) await writeFile(path.join(f.root, 'web', file), `
    self.onmessage=({data})=>{
      if(data.type==='load')postMessage({type:'ready',id:data.id});
      if(data.type==='translate')setTimeout(()=>postMessage(data.text==='fail'
        ?{type:'error',id:data.id,message:'Fixture translation failure'}
        :{type:'result',id:data.id,texts:['Translated '+data.text]}),data.text.startsWith('pending')?1000:30);
      if(data.type==='drain')postMessage({type:'drained',id:data.id});
    };`);
  await live.evaluate(async () => {
    const { TabSession } = await import('./session.js'), start = TabSession.prototype.start;
    TabSession.prototype.start = function(...args) { this.prepareTranslation = async () => {}; return start.apply(this, args); };
  });
}

for (const direction of ['ja-en', 'en-ja']) {
  test(`${direction}: persisted version 4 primitive translation routes render interim/completed text after migration`, async ({ graphExtension: f }) => {
    const live = await openGraph(f), editor = live.editor;
    await editor.locator('#translation-direction').selectOption(direction);
    for (const name of ['finalSource', 'finalStatus', 'finalIndex', 'finalError', 'provisionalSource', 'provisionalStatus', 'provisionalError']) await editor.getByRole('button', { name: `Disconnect translation.${name} to translated.${name}`, exact: true }).click();
    for (const [output, input] of [['provisional', 'provisionalText'], ['text', 'text']]) {
      await port(editor, 'translation', 'output', output).click(); await port(editor, 'translated', 'input', input).click();
    }
    await expect(editor.locator('#graph-errors')).toBeEmpty(); await save(editor);
    const routes = (await saved(live)).edges;
    await live.evaluate(() => {
      const key = 'processing-graph-v1', graph = JSON.parse(localStorage.getItem(key));
      graph.version = 4; localStorage.setItem(key, JSON.stringify(graph));
    });
    await live.close(); const reopened = await openGraph(f);
    expect((await saved(reopened)).version).toBe(5);
    expect((await saved(reopened)).edges).toEqual(routes);
    await fixtureTranslation(f, reopened);
    await startGraph(reopened);
    await reopened.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'preview' }));
    await expect(reopened.locator('#partial-english')).toHaveText('Translated preview');
    await expect(reopened.locator('#paired-provisional-source')).toBeHidden();
    await expect(reopened.locator('#partial-english')).not.toHaveAttribute('data-status');
    await expect(reopened.locator('#translated-text')).toBeEmpty();
    await emitFinal(reopened, 'completed');
    await expect(reopened.locator('#translated-text')).toHaveText('Translated completed\n');
    await expect(reopened.locator('#partial-english')).toBeEmpty();
    await expect(reopened.locator('#translated-text')).not.toHaveAttribute('data-status');
    await expect(reopened.locator('#paired-finals li')).toHaveCount(0);
    await expect(reopened.locator('#final')).toHaveText('completed\n');
    await reopened.locator('#stop').click(); await expect(reopened.locator('#start')).toBeEnabled();
  });
}

for (const direction of ['ja-en', 'en-ja']) test(`${direction}: saved version 4 paired view remains operational with pending, completed, error and canceled states`, async ({ graphExtension: f }) => {
  let live = await openGraph(f);
  await live.editor.locator('#translation-direction').selectOption(direction);
  await save(live.editor);
  await live.evaluate(async () => {
    const { GRAPH_KEY } = await import('./graph.js');
    const graph = JSON.parse(localStorage.getItem(GRAPH_KEY)); graph.version = 4;
    graph.edges = graph.edges.filter(route => route.to[0] !== 'translated');
    graph.edges.push({ from: ['translation', 'finalResult'], to: ['translated', 'final'] },
      { from: ['translation', 'provisionalResult'], to: ['translated', 'provisional'] });
    localStorage.setItem(GRAPH_KEY, JSON.stringify(graph));
  });
  await live.close(); live = await openGraph(f); const graph = await saved(live);
  expect(graph.version).toBe(5);
  await live.editor.reload(); expect(await saved(live)).toEqual(graph);
  await fixtureTranslation(f, live); await startGraph(live);
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'preview' }));
  await expect(live.locator('#partial-english')).toHaveText('Translated preview');
  await expect(live.locator('#partial-translation-source')).toHaveText('preview');
  await emitFinal(live, 'pending'); await expect(live.locator('#paired-finals pre[data-status="pending"]')).toHaveCount(1);
  await expect(live.locator('#paired-finals pre[data-status="complete"]')).toHaveText('Translated pending');
  await emitFinal(live, 'fail'); await expect(live.locator('#paired-finals pre[data-status="error"]')).toContainText('Fixture translation failure');
  // Inference failure disables this optional branch for the session. A fresh
  // session is needed to exercise cancellation of a genuinely pending job.
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled(); await startGraph(live);
  await emitFinal(live, 'pending cancellation'); await expect(live.locator('#paired-finals pre[data-status="pending"]')).toHaveCount(1);
  await live.locator('#cancel-session').click(); await expect(live.locator('#paired-finals pre[data-status="canceled"]')).toHaveText('Translation canceled');
  await expect(live.locator('#plain-translation')).toBeHidden();
  expect(await saved(live)).toEqual(graph);
});
