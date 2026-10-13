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
  test(`on-canvas pointer disconnect, selection clearing and precise fan-out at ${zoom} zoom`, async ({ graphExtension: f }) => {
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
    await pointerSelect(editor, 'speech.final to transcript.final');
    await expect(wireFor(editor, 'audio.audio to speech.audio')).toHaveAttribute('aria-pressed', 'false');
    await expect(control).toHaveAccessibleName('Disconnect speech.final to transcript.final');
    await expect(editor.locator('.selected-wire')).toHaveCount(1);
    await editor.keyboard.press('Escape');
    await expect(control).toBeHidden(); await expect(editor.locator('.selected-wire')).toHaveCount(0);
    await expect(editor.locator('.graph-scroll')).toBeFocused();
    await pointerSelect(editor, 'speech.provisional to transcript.provisional');
    await editor.locator('#graph-canvas').click({ position: { x: 3, y: 3 } });
    await expect(control).toBeHidden(); await expect(editor.locator('.selected-wire')).toHaveCount(0);
    await pointerSelect(editor, 'speech.provisional to transcript.provisional');
    await expect(control).toBeVisible(); await expect(control).toHaveText('Disconnect');
    const box = await control.boundingBox(), viewport = await editor.locator('.graph-scroll').boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(112); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThan(viewport.x); expect(box.y).toBeGreaterThan(viewport.y);
    expect(box.x + box.width).toBeLessThan(viewport.x + viewport.width);
    expect(box.y + box.height).toBeLessThan(viewport.y + viewport.height);
    expect(await control.evaluate(button => {
      const b = button.getBoundingClientRect();
      return [...button.closest('.graph-canvas').querySelectorAll('.graph-ports button')].filter(port => {
        const p = port.getBoundingClientRect();
        return b.left < p.right && b.right > p.left && b.top < p.bottom && b.bottom > p.top;
      }).length;
    })).toBe(0);
    // A native pointer click acts on the selected edge, without any key press.
    await control.click();
    await expect(wireFor(editor, 'speech.provisional to transcript.provisional')).toHaveCount(0);
    await expect(control).toBeHidden(); await expect(editor.locator('.graph-scroll')).toBeFocused();
    await expect(editor.locator('.graph-wire')).toHaveCount(before.edges.length - 1);
    await expect(editor.locator('.graph-node')).toHaveCount(before.nodes.length);
    await expect(editor.locator('#graph-errors')).toBeEmpty();
    await editor.locator('#graph-validate').click(); await expect(editor.locator('#graph-errors')).toContainText('Draft valid');
    await save(editor);
    const after = await saved(live);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges.filter(e => !(e.to[0] === 'transcript' && e.to[1] === 'provisional')));
    await editor.reload(); await expect(editor.locator('.graph-wire')).toHaveCount(after.edges.length);
    expect(await saved(live)).toEqual(after); await expect(control).toBeHidden();
  });
}

test('selected-edge control follows zoom, canvas scrolling and a narrow layout', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.setViewportSize({ width: 1600, height: 1000 });
  await pointerSelect(editor, 'audio.audio to speech.audio');
  const control = editor.locator('#graph-disconnect'), scroll = editor.locator('.graph-scroll');
  await editor.locator('#graph-zoom').selectOption('1.5');
  await expect(control).toBeVisible(); await expect(editor.locator('.selected-wire')).toHaveCount(1);
  await scroll.evaluate(canvas => { canvas.scrollTop = 500; });
  await expect(control).toBeHidden(); await expect(editor.locator('.selected-wire')).toHaveCount(1);
  await scroll.evaluate(canvas => { canvas.scrollTop = 0; });
  await expect(control).toBeVisible();
  await editor.setViewportSize({ width: 390, height: 844 });
  // Bring the selected segment into the resized canvas viewport.
  await wireFor(editor, 'audio.audio to speech.audio').scrollIntoViewIfNeeded();
  await wireFor(editor, 'audio.audio to speech.audio').focus();
  await expect(control).toBeVisible();
  const box = await control.boundingBox(), viewport = await scroll.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(112); expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThan(viewport.x); expect(box.x + box.width).toBeLessThan(viewport.x + viewport.width);
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

for (const key of ['Delete', 'Backspace']) test(`focused wire ${key} and keyboard-accessible on-canvas removal`, async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor, before = await saved(live);
  await editor.setViewportSize({ width: 1600, height: 1000 });
  const wire = wireFor(editor, 'audio.audio to speech.audio');
  await wire.focus();
  if (key === 'Delete') await wire.press('Enter');
  await expect(wire).toBeFocused();
  await wire.press(key); await expect(wire).toHaveCount(0);
  await expect(editor.locator('.graph-scroll')).toBeFocused();
  await expect(editor.locator('#graph-errors')).toContainText('Required connection');
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  expect(await saved(live)).toEqual(before); // Invalid draft cannot be saved.
  await port(editor, 'audio', 'output', 'audio').click(); await port(editor, 'speech', 'input', 'audio').click();
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  const optional = wireFor(editor, 'speech.provisional to transcript.provisional');
  await optional.focus(); await optional.press('Space'); await optional.press('Tab');
  const action = editor.getByRole('button', { name: 'Disconnect speech.provisional to transcript.provisional', exact: true });
  await expect(action).toBeFocused();
  await action.press('Shift+Tab'); await expect(optional).toBeFocused();
  await optional.press('Tab'); await action.press('Escape');
  await expect(action).toBeHidden(); await expect(editor.locator('.graph-scroll')).toBeFocused();
  await optional.focus(); await optional.press('Enter'); await optional.press('Tab');
  await action.press(key === 'Delete' ? 'Enter' : 'Space');
  await expect(optional).toHaveCount(0); await expect(editor.locator('.graph-scroll')).toBeFocused();
  await save(editor);
  expect((await saved(live)).edges).toEqual([...before.edges.filter(e => !(e.to[0] === 'transcript' && e.to[1] === 'provisional') && e.from[0] !== 'audio'), before.edges[0]]);
});

test('native touch selects and disconnects without hover; saved removal applies only to the next session', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.setViewportSize({ width: 1600, height: 1000 });
  await startGraph(live); const before = await saved(live);
  const workers = await live.evaluate(() => window.graphWorkers.length);
  await editor.locator('#graph-zoom').selectOption('0.5');
  await touch(editor, await wirePoint(editor, 'speech.provisional to transcript.provisional'));
  const wire = wireFor(editor, 'speech.provisional to transcript.provisional'), control = editor.locator('#graph-disconnect');
  await expect(wire).toHaveAttribute('aria-pressed', 'true'); await expect(wire).toHaveClass(/selected-wire/);
  await expect(control).toBeVisible();
  expect(await saved(live)).toEqual(before); await expect(editor.locator('.graph-wire')).toHaveCount(before.edges.length);
  const box = await control.boundingBox(); await touch(editor, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await expect(wire).toHaveCount(0); await expect(control).toBeHidden();
  await expect(editor.locator('.graph-scroll')).toBeFocused(); await save(editor);
  await expect(editor.locator('#graph-state')).toContainText('earlier graph');
  expect(await live.evaluate(() => window.graphWorkers.length)).toBe(workers);
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'active preview' }));
  await expect(live.locator('#partial')).toHaveText('active preview');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled(); await startGraph(live);
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'next preview' }));
  await expect(live.locator('#partial')).toBeEmpty();
  await emitFinal(live, 'next final'); await expect(live.locator('#final')).toHaveText('next final\n');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  expect((await saved(live)).edges).toEqual(before.edges.filter(e => !(e.to[0] === 'transcript' && e.to[1] === 'provisional')));
});

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
    for (const name of ['finalSource', 'finalStatus', 'finalIndex', 'finalError', 'provisionalSource', 'provisionalStatus', 'provisionalError']) await disconnectWire(editor, `translation.${name} to translated.${name}`);
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
