import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron } from 'playwright';
import { FOCUSED_OUTPUT } from '../../desktop/graph.js';
import { edge, graphNode, GRAPH_VERSION } from '../../extension/graph.js';
import { browserFixture } from './browser-fixture.js';

const binary = resolve(process.env.DESKTOP_TEST_BINARY || 'dist/desktop/my-audio-to-text');
const hotkey = 'ctrl+alt+shift+d';
const shortcutKeys = ['Control_L', 'Alt_L', 'Shift_L', 'd'];
const x = (...args) => execFileSync('xdotool', args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function eventually(check, description, timeout = 10000) {
  let error;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const result = await check();
      if (result) return result;
    } catch (failure) { error = failure; }
    await wait(100);
  }
  throw Error(`${description}${error ? ` (${error.message})` : ''}`, { cause: error });
}

async function windowId(title, timeout) {
  return eventually(() => x('search', '--onlyvisible', '--name', title).split('\n').at(-1), `X11 window unavailable: ${title}`, timeout);
}

async function activate(window) {
  if (x('getactivewindow') !== window) x('windowactivate', window);
  await eventually(() => x('getactivewindow') === window && x('getwindowfocus') === window,
    `X11 window ${window} did not receive focus`);
}

async function trigger(window, shortcut = hotkey) {
  await activate(window);
  await wait(320);
  x('key', '--clearmodifiers', shortcut);
}

function child(t, executable, args) {
  const process = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  const exited = once(process, 'exit');
  void exited.catch(() => {});
  t.after(async () => {
    if (!process.pid || process.exitCode !== null || process.signalCode !== null) return;
    process.kill();
    const timeout = setTimeout(() => process.kill('SIGKILL'), 3000);
    try { await exited; }
    finally { clearTimeout(timeout); }
  });
  return process;
}

async function editor(t, dir) {
  const first = join(dir, 'first.txt');
  const second = join(dir, 'second.txt');
  await writeFile(first, 'left|right');
  await writeFile(second, '');
  const process = child(t, 'mousepad', ['--disable-server', second, first]);
  const id = await windowId('first\\.txt.*Mousepad$');
  const pid = x('getwindowpid', id);
  const get = () => JSON.parse(execFileSync('/usr/bin/python3', ['tests/desktop/read-editor.py', pid], {
    encoding: 'utf8', timeout: 2500,
  }));
  await eventually(() => get().focus === 1, 'Mousepad did not focus its first document');
  x('key', 'Home', 'Right', 'Right', 'Right', 'Right', 'Right');
  return { id, process, get };
}

async function gtkFixture(t, dir) {
  const path = join(dir, 'editor.json');
  const process = child(t, '/usr/bin/python3', ['tests/desktop/editor.py', path]);
  const id = await windowId('^Voice typing test editor$');
  return { id, process, get: () => JSON.parse(readFileSync(path, 'utf8')) };
}

async function browser(t) {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-chromium-'));
  const { url, state, select } = await browserFixture(t);
  child(t, process.env.DESKTOP_TEST_CHROMIUM || 'chromium', [
    '--no-first-run', '--disable-extensions', '--force-renderer-accessibility', '--ozone-platform=x11',
    `--user-data-dir=${join(dir, 'chromium')}`, url,
  ]);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  const id = await windowId('^Voice typing test browser', 30000);
  await activate(id);
  await eventually(() => state()?.active && state().focus === 'field', 'Chromium did not focus the test input');
  const focus = (target, caret = 1) => {
    const serial = select(target, caret);
    return eventually(() => {
      const current = state();
      return current.selection === serial && current.active && current.focus === target && current.caret === caret && current;
    }, `Chromium did not focus the test caret in ${target}`);
  };
  return { id, get: state, focus };
}

async function launch(t) {
  const profile = await mkdtemp(join(tmpdir(), 'desktop-profile-'));
  let app;
  t.after(async () => {
    await app?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 10 });
  });
  app = await _electron.launch({ executablePath: binary, chromiumSandbox: true, timeout: 45000,
    env: { ...process.env, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile } });
  const page = await eventually(() => app.windows().find(page => page.url().endsWith('/management.html')), 'Management renderer did not load');
  const errors = [];
  for (const window of app.windows()) {
    window.on('pageerror', error => errors.push(error.message));
    window.on('console', message => {
      if (process.env.DESKTOP_TEST_DEBUG) console.log(window.url().split('/').at(-1), message.type(), message.text());
    });
  }
  await expect(page.locator('#graphs article')).not.toHaveCount(0);
  const view = () => page.evaluate(() => window.desktop.get());
  const phase = async (value, timeout = 10000) => {
    await eventually(async () => {
      const { session } = await view();
      if (session.phase !== value) throw Error(JSON.stringify(session));
      return session;
    }, `Expected desktop phase ${value}`, timeout);
  };
  const show = async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const management = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/management.html'));
      management.show();
      management.focus();
    });
  };
  return { app, page, view, phase, show, errors };
}

function literalGraph(template, output = FOCUSED_OUTPUT, value = '東京🙂') {
  const nodes = [graphNode('Text', 'literal', 20, 50), graphNode('TextFormatter', 'format', 280, 50),
    graphNode(output, 'result', 570, 50)];
  nodes[0].settings.value = value;
  nodes[1].settings = { template, inputCount: 1 };
  return { version: GRAPH_VERSION, nodes,
    edges: [edge('literal', 'value', 'format', 'input1'), edge('format', 'text', 'result', output === 'Display' ? 'input1' : 'text')] };
}

async function importGraph(page, name, graph) {
  await page.getByRole('button', { name: 'Graph Library' }).click();
  await page.locator('#import-file').setInputFiles({ name: `${name}.json`, mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(graph)) });
  await expect(page.locator('#editor-title')).toHaveText(name);
  await page.getByRole('button', { name: 'Back to graphs' }).click();
}

async function selectGraph(page, name) {
  await page.getByRole('button', { name: 'Graph Library' }).click();
  const entry = page.getByRole('article', { name, exact: true });
  if (await entry.getByRole('button', { name: 'Use for shortcut' }).count()) {
    await entry.getByRole('button', { name: 'Use for shortcut' }).click();
  }
  await expect(entry.getByText('Shortcut graph')).toBeVisible();
}

async function trayClick(button) {
  // The fixed-width trayer from run-x11.sh embeds the application's X11 icon.
  x('mousemove', '1383', '13', 'click', String(button));
  await wait(350);
}

test('Cancel during X11 target lookup revokes the pending edit', () => {
  const output = execFileSync('/usr/bin/python3', ['-B', 'tests/desktop/x11-cancel-fixture.py'], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.deepEqual(output.trim().split('\n').map(line => JSON.parse(line)), [
    { request: 1 },
    { request: 2, error: 'The voice typing session is no longer authorized.' },
    { request: 3 },
  ]);
});

test('X11 edits recheck focus and recover from transient failures in order', () => {
  execFileSync('/usr/bin/python3', ['-B', 'tests/desktop/x11-insert-fixture.py'], {
    encoding: 'utf8', timeout: 5000,
  });
});

test('packaged app uses the real tray, editor, shortcut and focused desktop controls', { timeout: 150000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-x11-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  const { app, page, view, phase, show, errors } = await launch(t);
  assert.equal(await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      return 'granted';
    } catch (error) { return error.name; }
  }), 'NotAllowedError');
  const native = await editor(t, dir);
  await show();
  const owner = spawn('/usr/bin/python3', ['tests/desktop/shortcut-owner.py'], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => owner.kill());
  assert.equal((await once(owner.stdout, 'data'))[0].toString().trim(), 'ready');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#shortcut').fill('Control+Alt+Shift+F10');
  await page.getByRole('button', { name: 'Save shortcut' }).click();
  await expect(page.locator('#shortcut-error')).toContainText('is unavailable');
  assert.equal((await view()).library.shortcut, 'Control+Alt+Shift+D');
  owner.stdin.end();
  await once(owner, 'exit');
  await page.getByRole('button', { name: 'Save shortcut' }).click();
  await expect(page.locator('#shortcut-error')).toBeEmpty();
  assert.equal((await view()).library.shortcut, 'Control+Alt+Shift+F10');
  await page.locator('#shortcut').fill('Control+Alt+Shift+D');
  await page.getByRole('button', { name: 'Save shortcut' }).click();
  await page.getByRole('button', { name: 'Graph Library' }).click();
  await page.getByRole('textbox', { name: 'New graph name' }).fill('New graph');
  await page.getByRole('button', { name: 'Create graph' }).click();
  await expect(page.locator('#editor-title')).toHaveText('New graph');
  await page.getByRole('button', { name: 'Back to graphs' }).click();
  await page.getByRole('article', { name: 'New graph', exact: true }).getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.locator('#editor-title')).toHaveText('New graph copy');
  await page.getByRole('button', { name: 'Back to graphs' }).click();
  await importGraph(page, 'GTK fixture', literalGraph(' {1}\n'));
  await importGraph(page, 'Live fixture', literalGraph(' {1}\n', 'Display'));

  const live = page.getByRole('article', { name: 'Live fixture', exact: true });
  await live.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Add Node', exact: true }).click();
  await expect(page.locator('#graph-palette')).not.toContainText('Chrome tab audio');
  await page.keyboard.press('Escape');
  await page.locator('[data-node="format"] .graph-heading').click();
  const template = page.locator('.graph-inspector textarea');
  await expect(template).toHaveValue(' {1}\n');
  await template.fill('before {1} after');
  await page.locator('#editor-title').click();
  await expect(page.locator('#graph-state')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(template).toHaveValue(' {1}\n');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(template).toHaveValue('before {1} after');
  await page.getByRole('button', { name: 'Back to graphs' }).click();

  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.locator('#live-graph').selectOption({ label: 'Live fixture' });
  await page.locator('#start-live').click();
  await phase('running');
  await expect(page.getByRole('tabpanel')).toHaveText('before 東京🙂 after');
  await page.getByRole('button', { name: 'Graph Library' }).click();
  await live.getByRole('button', { name: 'Edit' }).click();
  if (!await template.isVisible()) await page.locator('[data-node="format"] .graph-heading').click();
  await template.fill('next {1}');
  await page.getByRole('button', { name: 'Back to graphs' }).click();
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toHaveText('before 東京🙂 after');
  await page.locator('#stop-live').click();
  await phase('idle');
  await page.locator('#start-live').click();
  await phase('running');
  await expect(page.getByRole('tabpanel')).toHaveText('next 東京🙂');
  await page.locator('#cancel-live').click();
  await phase('idle');

  await page.getByRole('button', { name: 'Graph Library' }).click();
  await page.locator('#import-file').setInputFiles({ name: 'unsupported.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: GRAPH_VERSION, nodes: [graphNode('ChromeTabAudio', 'tab')], edges: [] })) });
  await expect(page.locator('#errors')).toContainText('Unsupported desktop Node');
  await selectGraph(page, 'GTK fixture');
  const exportedPath = join(dir, 'processing-graph.json');
  await app.evaluate(({ dialog }, path) => {
    const original = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => {
      dialog.showSaveDialog = original;
      return { canceled: false, filePath: path };
    };
  }, exportedPath);
  await page.getByRole('article', { name: 'GTK fixture', exact: true }).getByRole('button', { name: 'Export JSON' }).click();
  await eventually(() => {
    assert.deepEqual(JSON.parse(readFileSync(exportedPath, 'utf8')), literalGraph(' {1}\n'));
    return true;
  }, 'Graph export did not preserve the saved JSON');

  const management = await windowId('^My Audio to Text$');
  x('windowactivate', '--sync', management);
  x('key', 'alt+F4');
  await eventually(async () => !(await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(win => win.webContents.getURL().endsWith('/management.html') && win.isVisible()))),
  'Management window remained visible after close');
  if (x('getactivewindow') !== native.id) x('windowactivate', '--sync', native.id);
  await wait(320);
  x('keydown', hotkey);
  try {
    // Hold the real grab long enough for Xvfb to deliver keyboard auto-repeat.
    await wait(1250);
  } finally {
    x('keyup', hotkey);
  }
  await phase('running');
  await eventually(() => native.get().values[1] === 'left| 東京🙂\nright', 'GTK text did not arrive at original caret');
  assert.equal(x('getactivewindow'), native.id);
  assert.equal(x('getwindowfocus'), native.id);
  assert.equal(native.get().focus, 1);
  await trigger(native.id);
  await phase('idle');
  assert.deepEqual(native.get().values, ['', 'left| 東京🙂\nright']);

  await trayClick(3);
  await wait(1000);
  x('key', 'Home', 'Return');
  await phase('running');
  await eventually(() => native.get().values[1] === 'left| 東京🙂\n 東京🙂\nright',
    'The tray did not start a fresh session in the focused editor');
  x('key', 'ctrl+Page_Up');
  await eventually(() => native.get().focus === 0, 'GTK focus did not move');
  assert.equal((await view()).session.phase, 'running');
  assert.equal(native.get().values[0], '');

  // Losing the editor leaves the graph running until explicit Stop.
  native.process.kill();
  await show();
  await phase('running');
  await app.windows().find(window => window.url().endsWith('/indicator.html'))
    .getByRole('button', { name: 'Stop', exact: true }).evaluate(button => button.click());
  await phase('idle');
  assert.equal((await view()).session.error, '');

  await selectGraph(page, 'GTK fixture');
  await page.reload();
  await expect(page.getByRole('article', { name: 'GTK fixture', exact: true }).getByText('Shortcut graph')).toBeVisible();

  // Quit through the real XEmbed tray menu with a graph still running.
  await show();
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.locator('#live-graph').selectOption({ label: 'Live fixture' });
  await page.locator('#start-live').click();
  await phase('running');
  const process = app.process();
  await trayClick(3);
  x('key', 'End', 'Return');
  await eventually(() => process.exitCode !== null, 'Native tray Quit did not exit');
  assert.equal(process.exitCode, 0);
  const reclaimed = spawn('/usr/bin/python3', ['tests/desktop/shortcut-owner.py', 'D'], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => reclaimed.kill());
  assert.equal((await once(reclaimed.stdout, 'data'))[0].toString().trim(), 'ready');
  reclaimed.stdin.end();
  await once(reclaimed, 'exit');
  assert.deepEqual(errors, []);
});

async function committedText(app) {
  const runtime = app.windows().find(window => window.url().endsWith('/runtime.html'));
  await runtime.evaluate(() => {
    window.runtimeHost.onCommand(({ action, args }) => {
      if (action === 'start') window.testSession = args[0];
    });
  });
  return text => runtime.evaluate(chunk => window.runtimeHost.insert(window.testSession, chunk), text);
}

test('packaged app skips a stalled GTK target and keeps delivering in the same session', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-x11-stall-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  const { app, page, phase, view } = await launch(t);
  await importGraph(page, 'Stall fixture', literalGraph('{1}', FOCUSED_OUTPUT, ''));
  await selectGraph(page, 'Stall fixture');
  const commit = await committedText(app);
  x('key', 'alt+F4');
  const native = await editor(t, dir);
  const stalled = await gtkFixture(t, dir);
  await trigger(stalled.id);
  await phase('running');
  const initial = stalled.get().values;

  assert.ok(stalled.process.kill('SIGSTOP'));
  try {
    await commit('skip stalled target');
    assert.equal((await view()).session.phase, 'running');
    await activate(native.id);
    await commit('next');
    await eventually(() => native.get().values[1] === 'left|nextright',
      'The next chunk did not reach the responsive editor');
    assert.equal((await view()).session.phase, 'running');
  } finally {
    stalled.process.kill('SIGCONT');
  }
  await trigger(stalled.id);
  await phase('idle');
  assert.equal((await view()).session.error, '');
  assert.deepEqual(stalled.get().values, initial);
});

test('packaged app follows GTK focus and skips protected controls during a session', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-gtk-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  const { app, page, phase, view } = await launch(t);
  await importGraph(page, 'Length fixture', literalGraph('{1}', FOCUSED_OUTPUT, ''));
  await selectGraph(page, 'Length fixture');
  const commit = await committedText(app);
  x('key', 'alt+F4');
  const native = await gtkFixture(t, dir);
  await activate(native.id);
  const focus = (key, field, ...keys) => {
    x('key', key, ...keys);
    return eventually(() => native.get().focus === field, `GTK did not focus fixture control ${field}`);
  };

  x('key', 'ctrl+Tab');
  await focus('ctrl+Tab', 2);
  await trigger(native.id);
  await phase('running');
  await commit('skip password');
  await focus('Tab', 3, 'Home', 'Right');
  await commit('abcdef');
  await focus('Tab', 4);
  await commit('skip locked text');
  await focus('ctrl+Tab', 5);
  await commit('abcdef');

  assert.equal((await view()).session.phase, 'running');
  assert.equal(x('getwindowfocus'), native.id);
  await trigger(native.id);
  await phase('idle');
  assert.equal((await view()).session.error, '');
  assert.deepEqual(native.get(), {
    values: ['left|right', '', 'secret', 'xaby'], focus: 5, limitedEdits: 1,
    tagged: 'open locked tail', constrained: 'left|abright', constrainedCaret: 7, constrainedEdits: 1,
  });
});

test('packaged app skips unsupported Chromium targets and follows focus back to an editor', { timeout: 90000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-browser-focus-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  const { app, page, phase, view } = await launch(t);
  await importGraph(page, 'Browser fixture', literalGraph('{1}', FOCUSED_OUTPUT, ''));
  await selectGraph(page, 'Browser fixture');
  const commit = await committedText(app);
  x('key', 'alt+F4');
  const native = await editor(t, dir);
  const chromium = await browser(t);
  await trigger(chromium.id);
  await phase('running');
  const values = {
    field: 'left|right', notes: 'left|right', limited: 'xy', multiline: 'xy', editable: 'xy', readonly: 'xy', password: 'secret',
  };

  for (const target of ['notes', 'readonly', 'password']) {
    const before = await chromium.focus(target);
    await commit('skip unsupported target');
    const report = chromium.get().report;
    const { focus, caret, values: currentValues, edits, submits } = await eventually(() => {
      const current = chromium.get();
      return current.report > report && current.active && current;
    }, 'Chromium did not report its focused state after the chunk');
    assert.deepEqual({ focus, caret, values: currentValues, edits, submits }, {
      focus: target, caret: before.caret, values, edits: [], submits: 0,
    });
    assert.equal(x('getwindowfocus'), chromium.id);
  }

  await activate(native.id);
  await eventually(() => native.get().focus === 1, 'Mousepad did not regain field focus');
  await commit('東京🙂');
  await eventually(() => native.get().values[1] === 'left|東京🙂right', 'The next chunk did not reach Mousepad');
  assert.equal((await view()).session.phase, 'running');
  await trigger(native.id);
  await phase('idle');
  assert.equal((await view()).session.error, '');
});

test('authorized focused TEXT waits for the Stop shortcut grab and follows the current GTK field', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-stop-shortcut-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  const { app, page, view, phase, show } = await launch(t);
  const native = await editor(t, dir);
  await show();
  await importGraph(page, 'Stop fixture', literalGraph('{1}', FOCUSED_OUTPUT, ''));
  await selectGraph(page, 'Stop fixture');
  const runtime = app.windows().find(window => window.url().endsWith('/runtime.html'));
  // Deliver focused TEXT through the real runtime-to-host IPC while
  // the native shortcut holds the keyboard grab.
  await runtime.evaluate(() => {
    window.runtimeHost.onCommand(({ action, args }) => {
      if (action === 'start') window.testSession = args[0];
    });
  });

  const text = '東京🙂';
  const queued = () => runtime.evaluate(text => {
    window.testInsertResult = null;
    window.testInsert = window.runtimeHost.insert(window.testSession, text).then(
      () => ({ inserted: true }), error => ({ inserted: false, error: error.message }),
    ).then(result => { window.testInsertResult = result; return result; });
  }, text);
  const initial = ['', 'left|right'];
  await trigger(native.id);
  await phase('running');
  x('keydown', ...shortcutKeys);
  try {
    await queued();
    // Exceed the helper's normal request timeout as well as the repeat delay.
    await wait(7500);
    assert.equal(await runtime.evaluate(() => window.testInsertResult), null);
    assert.deepEqual(native.get().values, initial);
    const { session } = await view();
    assert.equal(session.phase, 'running', session.error);
  } finally {
    x('keyup', ...shortcutKeys.toReversed());
  }
  await phase('idle');
  assert.deepEqual(await runtime.evaluate(() => window.testInsert), { inserted: true });
  assert.equal((await view()).session.error, '');
  const afterStop = ['', 'left|東京🙂right'];
  await eventually(() => {
    assert.deepEqual(native.get().values, afterStop);
    return true;
  }, 'Stop did not insert exactly one TEXT delivery');
  assert.equal(native.get().focus, 1);
  assert.equal(x('getwindowfocus'), native.id);

  await trigger(native.id);
  await phase('running');
  x('keydown', ...shortcutKeys);
  try {
    await queued();
    await wait(350);
    assert.equal(await runtime.evaluate(() => window.testInsertResult), null);
    const { session } = await view();
    assert.equal(session.phase, 'running', session.error);
  } finally {
    x('keyup', '--delay', '1', ...shortcutKeys.toReversed(), 'key', '--delay', '1', 'ctrl+Page_Up');
  }
  await eventually(() => native.get().focus === 0, 'GTK focus did not move during shortcut release');
  await phase('idle');
  assert.deepEqual(await runtime.evaluate(() => window.testInsert), { inserted: true });
  assert.equal((await view()).session.error, '');
  await eventually(() => native.get().values[0] === text, 'Stop did not drain into the newly focused tab');
  assert.deepEqual(native.get().values, [text, afterStop[1]]);
});

test('Models can retry cache inspection and preparation after the packaged runtime crashes', { timeout: 60000 }, async t => {
  const { app, page } = await launch(t);
  // Hold the model request open so the real download stays in progress without using the network.
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://download.moonshine.ai/*'] }, () => {});
  });
  const runtime = await eventually(() => app.windows().find(win => win.url().endsWith('/runtime.html')),
    'Runtime renderer did not load');
  // Pause the real first inspection at the cache boundary, before it can reply.
  await runtime.evaluate(() => {
    CacheStorage.prototype.open = () => {
      window.inspectPending = true;
      return new Promise(() => {});
    };
  });
  const crashRuntime = () => app.evaluate(({ BrowserWindow }) => {
    const runtime = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/runtime.html'));
    runtime.webContents.forcefullyCrashRenderer();
  });
  const status = page.locator('#model-status');
  const prepare = page.locator('#prepare');
  await page.getByRole('button', { name: 'Models' }).click();
  await runtime.waitForFunction(() => window.inspectPending);
  await expect(status).toHaveText('Checking cache…');
  await expect(prepare).toBeDisabled();
  await crashRuntime();
  await expect(status).toHaveText('Error');
  await expect(page.locator('#model-error')).toContainText('runtime closed unexpectedly');
  await expect(prepare).toHaveText('Retry');
  await prepare.click();
  await expect(status).toHaveText('Not downloaded');
  await expect(page.locator('#model-error')).toBeEmpty();
  await expect(page.locator('#errors')).toBeEmpty();
  await expect(prepare).toHaveText('Prepare');
  await prepare.click();
  await expect(status).toHaveText('Downloading');
  await crashRuntime();
  await expect(status).toHaveText('Error');
  await expect(page.locator('#model-error')).toContainText('runtime closed unexpectedly');
  await expect(prepare).toHaveText('Retry');
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect(status).toHaveText('Downloading');
  await page.locator('#cancel-download').click();
  await expect(status).toHaveText('Canceled');
});

test('pinned Japanese Moonshine captures PulseAudio and inserts a real offline final', {
  skip: process.env.DESKTOP_REAL_ASR !== '1', timeout: 900000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-real-asr-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  const { app, page, view, phase, show } = await launch(t);
  const native = await editor(t, dir);
  await show();
  const model = () => page.locator('#model-status');
  const select = (name) => selectGraph(page, name);
  await select('Japanese voice typing');
  await trigger(native.id);
  await eventually(async () => /not downloaded|missing|evicted/i.test((await view()).session.error),
    'Starting without a prepared model did not fail before capture');
  assert.equal((await view()).session.microphone, false);

  await show();
  await page.getByRole('button', { name: 'Models' }).click();
  await expect(model()).toHaveText('Not downloaded');
  await page.locator('#prepare').click();
  await expect(model()).toHaveText('Downloading', { timeout: 20000 });
  await page.locator('#cancel-download').click();
  await expect(model()).toHaveText('Canceled', { timeout: 20000 });
  await page.locator('#prepare').click();
  await expect(model()).toHaveText('Ready', { timeout: 700000 });
  const manifest = JSON.parse(readFileSync('extension/moonshine-small-ja-assets.json', 'utf8'));
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }));
  });
  await trigger(native.id);
  await phase('running', 90000);
  assert.equal((await view()).session.microphone, true);
  assert.equal(x('getactivewindow'), native.id);
  assert.equal(x('getwindowfocus'), native.id);
  const audio = spawn('paplay', ['--device=voice_fixture', 'tests/desktop/fixtures/konnichiwa.wav'], { stdio: 'inherit' });
  assert.equal((await once(audio, 'exit'))[0], 0);
  await assert.rejects(page.evaluate(() => window.desktop.model('modelDelete')), /Stop the active session/);
  const indicator = await windowId('^Voice typing status$');
  x('mousemove', '--window', indicator, '195', '25', 'click', '1');
  await phase('idle', 90000);
  const text = native.get().values[1];
  assert.ok(text.startsWith('left|') && text.endsWith('right'));
  const transcript = text.slice(5, -5);
  assert.match(transcript, /\S/);
  assert.equal((await view()).session.error, '');
  assert.equal(x('getactivewindow'), native.id);
  assert.equal(x('getwindowfocus'), native.id);
  console.log(JSON.stringify({ model: manifest.id, revision: manifest.revision,
    fixture: 'tests/desktop/fixtures/konnichiwa.wav', transcript, network: 'HTTP(S) blocked' }));

  await show();
  await page.locator('#delete-model').click();
  await expect(model()).toHaveText('Not downloaded', { timeout: 20000 });
  await page.locator('#prepare').click();
  await expect(model()).toHaveText('Error', { timeout: 20000 });
});
