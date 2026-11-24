import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron } from 'playwright';
import { FOCUSED_OUTPUT } from '../../desktop/graph.js';
import { edge, graphNode, GRAPH_VERSION } from '../../extension/graph.js';

const binary = resolve(process.env.DESKTOP_TEST_BINARY || 'dist/desktop/my-audio-to-text');
const hotkey = 'ctrl+alt+shift+d';
const x = (...args) => execFileSync('xdotool', args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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

async function trigger(window, shortcut = hotkey) {
  if (x('getactivewindow') !== window) x('windowactivate', '--sync', window);
  await wait(320);
  x('key', '--clearmodifiers', shortcut);
}

function child(t, executable, args) {
  const process = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  t.after(() => process.kill());
  return process;
}

async function editor(t, dir) {
  const path = join(dir, 'editor.json');
  const process = child(t, '/usr/bin/python3', ['tests/desktop/editor.py', path]);
  const id = await windowId('^Voice typing test editor$');
  return { id, process, get: () => JSON.parse(readFileSync(path, 'utf8')) };
}

async function browser(t, dir) {
  const page = readFileSync('tests/desktop/browser-target.html');
  let state;
  const http = createServer(async (request, response) => {
    if (request.url === '/state' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      state = JSON.parse(body);
      response.writeHead(204).end();
    } else response.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => http.close());
  const profile = join(dir, 'firefox');
  await mkdir(profile);
  await writeFile(join(profile, 'user.js'), `
    user_pref("browser.aboutwelcome.enabled", false);
    user_pref("browser.shell.checkDefaultBrowser", false);
    user_pref("browser.startup.homepage_override.mstone", "ignore");
    user_pref("browser.startup.firstrunSkipsHomepage", true);
    user_pref("browser.preonboarding.enabled", false);
    user_pref("datareporting.policy.dataSubmissionEnabled", false);
    user_pref("termsofuse.bypassNotification", true);
  `);
  child(t, process.env.DESKTOP_TEST_FIREFOX || 'firefox', ['--no-remote', '--profile', profile, `http://127.0.0.1:${http.address().port}/`]);
  const id = await eventually(() => x('search', '--onlyvisible', '.').split('\n')
    .find(candidate => x('getwindowname', candidate).includes('Voice typing test browser')),
  'Firefox window did not load the test page', 30000);
  await eventually(() => state?.point, 'Firefox did not report the test field geometry');
  x('windowactivate', '--sync', id);
  x('key', 'Escape');
  x('mousemove', ...state.point.map(String), 'click', '1');
  x('key', 'Home', 'Right', 'Right', 'Right', 'Right', 'Right');
  await eventually(() => {
    assert.deepEqual([state.active, state.focus, state.caret], [true, 0, 5]);
    return true;
  }, 'Firefox did not focus the test caret');
  return { id, get: () => state };
}

async function launch(t) {
  const profile = await mkdtemp(join(tmpdir(), 'desktop-profile-'));
  let app;
  t.after(async () => {
    await app?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 10 });
  });
  app = await _electron.launch({ executablePath: binary, chromiumSandbox: true, timeout: 30000,
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

function literalGraph(template, output = FOCUSED_OUTPUT) {
  const nodes = [graphNode('Text', 'literal', 20, 50), graphNode('TextFormatter', 'format', 280, 50),
    graphNode(output, 'result', 570, 50)];
  nodes[0].settings.value = '東京🙂';
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
  await importGraph(page, 'Browser fixture', literalGraph(' [{1}] '));
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
  await trigger(native.id);
  await phase('running');
  await eventually(() => native.get().values[0] === 'left| 東京🙂\nright', 'GTK text did not arrive at original caret');
  assert.equal(x('getactivewindow'), native.id);
  assert.equal(x('getwindowfocus'), native.id);
  assert.equal(native.get().focus, 0);
  await trigger(native.id);
  await phase('idle');
  assert.deepEqual(native.get().values, ['left| 東京🙂\nright', '', 'secret']);

  await trayClick(3);
  x('key', 'Home', 'Return');
  await phase('running');
  await eventually(() => native.get().values[0] === 'left| 東京🙂\n 東京🙂\nright',
    'The tray did not start a fresh session in the authorized editor');
  x('key', 'ctrl+Tab');
  await eventually(() => native.get().focus !== 0, 'GTK focus did not move');
  await phase('idle');
  assert.match((await view()).session.error, /lost focus|changed|closed/i);
  assert.equal(native.get().values[1], '');
  x('key', 'ctrl+Tab');
  await eventually(() => native.get().focus === 2, 'GTK password did not receive focus');
  await trigger(native.id);
  await eventually(async () => (await view()).session.error.includes('editable plain-text'), 'Protected target did not report refusal');
  assert.equal(native.get().values[2], 'secret');

  await show();
  await selectGraph(page, 'Browser fixture');
  const firefox = await browser(t, dir);
  await trigger(firefox.id);
  await phase('running');
  await eventually(async () => {
    assert.equal(firefox.get().values[0], 'left| [東京🙂] right', JSON.stringify((await view()).session));
    return true;
  }, 'Firefox text did not arrive at original caret');
  assert.equal(x('getactivewindow'), firefox.id);
  assert.equal(x('getwindowfocus'), firefox.id);
  await trigger(firefox.id);
  await phase('idle');
  await eventually(() => firefox.get().active, 'Firefox focus did not recover after the keyboard grab');
  assert.equal(x('getwindowfocus'), firefox.id);
  const { values, focus, submits, caret, active } = firefox.get();
  assert.deepEqual({ values, focus, submits, caret, active },
    { values: ['left| [東京🙂] right', '', 'secret'], focus: 0, submits: 0, caret: 13, active: true });

  await show();
  await page.reload();
  await expect(page.getByRole('article', { name: 'Browser fixture', exact: true }).getByText('Shortcut graph')).toBeVisible();
  await trigger(firefox.id);
  await phase('running');
  x('key', 'alt+F4');
  await phase('idle');
  assert.match((await view()).session.error, /lost focus|changed|closed/i);

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
  const text = native.get().values[0];
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
