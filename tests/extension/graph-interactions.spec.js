import { checkRecovery, checkInputReconnect, checkStableInspector, checkInputDetach, loadInputGraph, inputDragPoints } from '../fixtures/graph-inspector.js';
import { clickGraphAction, loadTranslationFixture } from './ui-controls.js';
import { legacyGraph } from '../fixtures/legacy-graph.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph, startGraph, emitFinal, disconnectWire } from './graph-fixture.js';

const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
const port = (page, node, side, name) => page.getByRole('button', { name: `${node} ${side} ${name}`, exact: true });
async function save(page) {
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  await expect(page.locator('#graph-state')).not.toContainText('Unsaved draft');
}

const wireFor = (editor, route) => editor.getByRole('button', { name: `Select connection ${route}`, exact: true });
for (const action of ['Clear selection', 'Remove transcript']) {
  test(`packaged inspector commits text edits before a single ${action} click`, async ({ graphExtension: f }) => {
    const live = await openGraph(f), editor = live.editor, before = await saved(live);
    await editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
    await editor.getByLabel('transcript label', { exact: true }).fill('Edited output');
    await editor.getByRole('button', { name: action, exact: true }).click();
    await expect(editor.locator('.graph-inspector')).toContainText('Select a node or connection.');
    await expect(editor.locator('.graph-scroll')).toBeFocused();
    await expect(editor.locator('#graph-state')).toContainText('Unsaved draft');
    expect(await saved(live)).toEqual(before);
    const expected = structuredClone(before);
    if (action === 'Clear selection') {
      expected.nodes.find(node => node.id === 'transcript').settings.label = 'Edited output';
      await editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
      await expect(editor.getByLabel('transcript label', { exact: true })).toHaveValue('Edited output');
      await expect(editor.locator('#graph-errors')).toBeEmpty();
    } else {
      expected.nodes = expected.nodes.filter(node => node.id !== 'transcript');
      expected.edges = expected.edges.filter(edge => edge.from[0] !== 'transcript' && edge.to[0] !== 'transcript');
      await expect(editor.locator('[data-node="transcript"]')).toHaveCount(0);
      await expect(editor.locator('.graph-node')).toHaveCount(expected.nodes.length);
      await expect(editor.locator('.graph-wire')).toHaveCount(expected.edges.length);
      await editor.locator('#graph-save').click();
      await expect(editor.locator('#graph-save')).toBeEnabled();
      await expect(editor.locator('#graph-errors')).toBeEmpty();
      expect(await saved(live)).toEqual(expected);
      return;
    }
    await save(editor);
    expect(await saved(live)).toEqual(expected);
    await editor.reload();
    await expect(editor.locator('#graph-state')).toContainText('Saved graph');
    await expect(editor.locator('.graph-node')).toHaveCount(expected.nodes.length);
    await expect(editor.locator('.graph-wire')).toHaveCount(expected.edges.length);
  });
}

async function wirePoint(editor, route) {
  const wire = wireFor(editor, route);
  await wire.scrollIntoViewIfNeeded();
  return wire.locator('.wire-hit').evaluate(path => {
    const matrix = path.getScreenCTM(), viewport = path.closest('.graph-scroll').getBoundingClientRect();
    // Find an exposed part of the hit target, including dense fan-out paths.
    for (const fraction of [.5, .4, .6, .3, .7, .2, .8, .1, .9]) {
      const p = path.getPointAtLength(path.getTotalLength() * fraction);
      const x = matrix.a * p.x + matrix.c * p.y + matrix.e, y = matrix.b * p.x + matrix.d * p.y + matrix.f + 6;
      if (x > viewport.left && x < viewport.right && y > viewport.top && y < viewport.bottom && document.elementFromPoint(x, y)?.closest('.graph-wire') === path.parentElement) return { x, y };
    }
    throw Error('No exposed wire hit target');
  });
}
async function pointerSelect(editor, route) {
  const p = await wirePoint(editor, route); await editor.mouse.click(p.x, p.y);
  await expect(wireFor(editor, route)).toHaveAttribute('aria-pressed', 'true');
  await expect(wireFor(editor, route)).toHaveClass(/selected-wire/);
}
async function touch(editor, point) {
  const session = await editor.context().newCDPSession(editor);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

for (const zoom of ['0.5', '0.75', '1', '1.25', '1.5']) {
  test(`inspector pointer disconnect, selection clearing and precise fan-out at ${zoom} zoom`, async ({ graphExtension: f }) => {
    const live = await openGraph(f), editor = live.editor, before = await saved(live);
    await editor.setViewportSize({ width: 1600, height: 1000 });
    await editor.locator('#graph-zoom').selectOption(zoom);
    await expect(editor.locator('#graph-connections')).toHaveCount(0);
    await expect(editor.getByRole('heading', { name: 'Connections', exact: true })).toHaveCount(0);
    const control = editor.locator('#graph-disconnect');
    await expect(control).toBeHidden();
    await editor.getByRole('button', { name: 'Select audio', exact: true }).click();
    await pointerSelect(editor, 'audio.audio to speech.audio');
    await expect(editor.locator('.selected-node')).toHaveCount(0);
    await expect(control).toHaveAccessibleName('Disconnect audio.audio to speech.audio');
    await expect(editor.locator('.graph-wire')).toHaveCount(before.edges.length);
    await expect(editor.locator('#graph-state')).not.toContainText('Unsaved draft');
    await pointerSelect(editor, 'speech.final to transcript-accumulator.append');
    await expect(wireFor(editor, 'audio.audio to speech.audio')).toHaveAttribute('aria-pressed', 'false');
    await expect(control).toHaveAccessibleName('Disconnect speech.final to transcript-accumulator.append');
    await expect(editor.locator('.selected-wire')).toHaveCount(1);
    await editor.keyboard.press('Escape');
    await expect(control).toBeHidden(); await expect(editor.locator('.selected-wire')).toHaveCount(0);
    await expect(editor.locator('.graph-scroll')).toBeFocused();
    await pointerSelect(editor, 'speech.provisional to transcript-preview.text');
    await editor.locator('#graph-canvas').click({ position: { x: 3, y: 3 } });
    await expect(control).toBeHidden(); await expect(editor.locator('.selected-wire')).toHaveCount(0);
    await pointerSelect(editor, 'speech.provisional to transcript-preview.text');
    await expect(control).toBeVisible(); await expect(control).toHaveText('Disconnect');
    await expect(editor.locator('.graph-inspector #graph-disconnect')).toBeVisible();
    await expect(editor.locator('#graph-canvas #graph-disconnect')).toHaveCount(0);
    // A native pointer click acts on the selected edge, without any key press.
    await control.click();
    await expect(wireFor(editor, 'speech.provisional to transcript-preview.text')).toHaveCount(0);
    await expect(control).toBeHidden(); await expect(editor.locator('.graph-scroll')).toBeFocused();
    await expect(editor.locator('.graph-wire')).toHaveCount(before.edges.length - 1);
    await expect(editor.locator('.graph-node')).toHaveCount(before.nodes.length);
    await expect(editor.locator('#graph-errors')).toBeEmpty();
    await clickGraphAction(editor, 'graph-validate'); await expect(editor.locator('#graph-errors')).toContainText('Required connection missing: transcript-preview.text');
    await save(editor);
    const after = await saved(live);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges.filter(e => !(e.to[0] === 'transcript-preview' && e.to[1] === 'text')));
    await editor.reload(); await expect(editor.locator('.graph-wire')).toHaveCount(after.edges.length);
    expect(await saved(live)).toEqual(after); await expect(control).toBeHidden();
  });
}

test('inspector disconnect remains available through zoom, scrolling and a narrow layout', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.setViewportSize({ width: 1600, height: 650 });
  await pointerSelect(editor, 'audio.audio to speech.audio');
  const control = editor.locator('#graph-disconnect'), scroll = editor.locator('.graph-scroll');
  await editor.locator('#graph-zoom').selectOption('1.5');
  await expect(control).toBeVisible(); await expect(editor.locator('.selected-wire')).toHaveCount(1);
  await scroll.evaluate(canvas => { canvas.scrollTop = 500; });
  await expect(control).toBeVisible(); await expect(editor.locator('.selected-wire')).toHaveCount(1);
  await scroll.evaluate(canvas => { canvas.scrollTop = 0; });
  await expect(control).toBeVisible();
  await editor.setViewportSize({ width: 390, height: 844 });
  // Bring the selected segment into the resized canvas viewport.
  await wireFor(editor, 'audio.audio to speech.audio').scrollIntoViewIfNeeded();
  await wireFor(editor, 'audio.audio to speech.audio').focus();
  await expect(control).toBeVisible();
  await expect(editor.locator('.graph-inspector #graph-disconnect')).toBeVisible();
  await control.click(); await expect(wireFor(editor, 'audio.audio to speech.audio')).toHaveCount(0);
  await expect(scroll).toBeFocused();
});

test('a pointer-selected short visible segment of a long wire still reveals a reachable control', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.setViewportSize({ width: 1600, height: 1000 });
  await live.evaluate(() => {
    const key = 'processing-graph-v1', graph = JSON.parse(localStorage.getItem(key));
    graph.nodes.find(n => n.id === 'speech').position = { x: 3500, y: 3500 };
    localStorage.setItem(key, JSON.stringify(graph));
  });
  await expect(editor.locator('[data-node="speech"]')).toHaveCSS('left', '3500px');
  await editor.locator('#graph-zoom').selectOption('1.5');
  const wire = wireFor(editor, 'audio.audio to speech.audio');
  const point = await wire.locator('.wire-hit').evaluate(path => {
    const p = path.getPointAtLength(path.getTotalLength() * .537), scroll = path.closest('.graph-scroll');
    // Put a tiny segment at the top-right corner, between placement samples.
    scroll.scrollLeft = p.x * 1.5 - scroll.clientWidth + 4;
    scroll.scrollTop = p.y * 1.5 - 4;
    const m = path.getScreenCTM();
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  });
  await editor.mouse.click(point.x, point.y);
  await expect(wire).toHaveAttribute('aria-pressed', 'true');
  const control = editor.locator('#graph-disconnect'); await expect(control).toBeVisible();
  await control.click(); await expect(wire).toHaveCount(0);
  await expect(editor.locator('.graph-scroll')).toBeFocused();
});

for (const key of ['Delete', 'Backspace']) test(`focused wire ${key} and keyboard-accessible inspector removal`, async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor, before = await saved(live);
  await editor.setViewportSize({ width: 1600, height: 1000 });
  const wire = wireFor(editor, 'audio.audio to speech.audio');
  await wire.focus();
  if (key === 'Delete') await wire.press('Enter');
  await expect(wire).toBeFocused();
  await wire.press(key); await expect(wire).toHaveCount(0);
  await expect(editor.locator('.graph-scroll')).toBeFocused();
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  expect(await saved(live)).toEqual({ ...before, edges: before.edges.filter(route => route.to[1] !== 'audio') }); // Incomplete drafts are saveable.
  await port(editor, 'audio', 'output', 'audio').click(); await port(editor, 'speech', 'input', 'audio').click();
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  const optional = wireFor(editor, 'speech.provisional to transcript-preview.text');
  await optional.focus(); await optional.press('Space'); await optional.press('Tab');
  const action = editor.getByRole('button', { name: 'Disconnect speech.provisional to transcript-preview.text', exact: true });
  await expect(action).toBeFocused();
  await action.press('Shift+Tab'); await expect(optional).toBeFocused();
  await optional.press('Tab'); await action.press('Escape');
  await expect(action).toBeHidden(); await expect(editor.locator('.graph-scroll')).toBeFocused();
  await optional.focus(); await optional.press('Enter'); await optional.press('Tab');
  await action.press(key === 'Delete' ? 'Enter' : 'Space');
  await expect(optional).toHaveCount(0); await expect(editor.locator('.graph-scroll')).toBeFocused();
  await save(editor);
  expect((await saved(live)).edges).toEqual([...before.edges.filter(e => !(e.to[0] === 'transcript-preview' && e.to[1] === 'text') && e.from[0] !== 'audio'), before.edges[0]]);
});

test('native touch selects and disconnects without hover; saved removal applies only to the next session', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.setViewportSize({ width: 1600, height: 1000 });
  await startGraph(live); const before = await saved(live);
  const workers = await live.evaluate(() => window.graphWorkers.length);
  await editor.locator('#graph-zoom').selectOption('0.5');
  await touch(editor, await wirePoint(editor, 'speech.provisional to transcript-preview.text'));
  const wire = wireFor(editor, 'speech.provisional to transcript-preview.text'), control = editor.locator('#graph-disconnect');
  await expect(wire).toHaveAttribute('aria-pressed', 'true'); await expect(wire).toHaveClass(/selected-wire/);
  await expect(control).toBeVisible();
  expect(await saved(live)).toEqual(before); await expect(editor.locator('.graph-wire')).toHaveCount(before.edges.length);
  const box = await control.boundingBox(); await touch(editor, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await expect(wire).toHaveCount(0); await expect(control).toBeHidden();
  await expect(editor.locator('.graph-scroll')).toBeFocused(); await save(editor);
  await expect(editor.locator('#graph-state')).toContainText('earlier graph');
  expect(await live.evaluate(() => window.graphWorkers.length)).toBe(workers);
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'active preview' }));
  await expect(live.locator('[data-display="transcript"] .display-content')).toHaveText('active preview');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled(); await startGraph(live);
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'next preview' }));

  await emitFinal(live, 'next final'); await expect(live.locator('[data-display="transcript"] .display-content')).toHaveText('next final');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  expect((await saved(live)).edges).toEqual(before.edges.filter(e => !(e.to[0] === 'transcript-preview' && e.to[1] === 'text')));
});

test('click and drag reconnect a populated input, preserving fan-out; identical and invalid attempts keep old edge', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await loadTranslationFixture(editor); await save(editor);
  const original = await saved(live);
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

for (const version of [4, 5]) for (const direction of ['ja-en', 'en-ja']) for (const paired of [false, true]) {
  test(`v${version} ${direction}: reviewed migration preserves ${paired ? 'committed pairs' : 'plain routes'} through Stop, errors and Cancel`, async ({ graphExtension: f }) => {
    let live = await openGraph(f); const legacy = legacyGraph({ direction }, version);
    if (!paired) {
      legacy.edges = legacy.edges.filter(e => e.to[0] !== 'translated');
      legacy.edges.push({ from: ['translation', 'provisional'], to: ['translated', 'provisionalText'] }, { from: ['translation', 'text'], to: ['translated', 'text'] });
    }
    await live.evaluate(graph => localStorage.setItem('processing-graph-v1', JSON.stringify(graph)), legacy);
    await live.close(); live = await openGraph(f);
    await expect(live.editor.locator('#errors')).toContainText('migration needs review');
    await live.editor.locator('.graph-actions > summary').click();
    await live.editor.getByText('Recovery', { exact: true }).click();
    await expect(live.editor.getByLabel('Original saved graph JSON')).toHaveValue(JSON.stringify(legacy));
    await live.editor.locator('#graph-save').click(); await expect(live.editor.locator('#graph-save')).toBeEnabled();
    const graph = await saved(live);
    expect(graph.version).toBe(15); await expect(live.editor.locator('#graph-errors')).toBeEmpty();
    await fixtureTranslation(f, live); await startGraph(live);
    const text = live.locator('[data-display="translated"] .display-content');
    await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'preview' }));
    await expect(text).toBeEmpty();
    await emitFinal(live, 'pending');
    await expect(text).toBeEmpty();
    await expect(paired ? text : live.locator('[data-display="translated"] .display-content')).toContainText('Translated pending');
    await emitFinal(live, 'fail');
    if (paired) await expect(text).toContainText('Fixture translation failure');
    await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
    await startGraph(live); await expect(text).toBeEmpty();
    await emitFinal(live, 'pending cancellation');
    await expect(text).toBeEmpty();
    await live.locator('#cancel-session').click();
    await expect(text).toBeEmpty();
    expect(await saved(live)).toEqual(graph);
  });
}

for (const width of [390, 1440]) {
  test(`MV3 selection keeps inspector and canvas geometry stable at ${width}px`, async ({ graphExtension: f }) => {
    const live = await openGraph(f); await checkStableInspector(live.editor, width);
  });
  test(`MV3 connected input drag detaches only its wire at ${width}px`, async ({ graphExtension: f }) => {
    const live = await openGraph(f); await checkInputDetach(live.editor, width);
  });
}

test('native touch drags an occupied input to blank canvas without changing its fan-out', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.setViewportSize({ width: 390, height: 900 }); await loadInputGraph(editor);
  await editor.locator('#graph-zoom').selectOption('0.5');
  const before = await saved(live), { start, end } = await inputDragPoints(editor);
  const session = await editor.context().newCDPSession(editor);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  for (let i = 1; i <= 5; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove',
    touchPoints: [{ x: start.x + (end.x - start.x) * i / 5, y: start.y + (end.y - start.y) * i / 5 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await session.detach();
  await expect(editor.locator('.graph-wire')).toHaveCount(before.edges.length - 1);
  expect(await saved(live)).toEqual(before);
  await save(editor);
  expect(await saved(live)).toEqual({ ...before, edges: before.edges.slice(1) });
});

test('MV3 input-end dragging reconnects transactionally and cancellation preserves the wire', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await checkInputReconnect(live.editor);
});
for (const kind of ['current', 'paired', 'invalid']) test(`MV3 Graph actions recovery preserves exact ${kind} originals and numbered backups`, async ({ graphExtension: f }) => {
  const live = await openGraph(f); await checkRecovery(live.editor, kind);
});
