import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { _electron, chromium } from 'playwright';
import { defaultDesktopGraph, FOCUSED_OUTPUT } from '../../desktop/graph.js';
import { edge, graphNode, GRAPH_VERSION } from '../../extension/graph.js';

const binary = resolve(process.env.DESKTOP_TEST_BINARY
  || 'dist/desktop/My Audio to Text.app/Contents/MacOS/my-audio-to-text');
const defaultShortcut = 'Control+Alt+Super+D';
const conflictingShortcut = 'Control+Alt+Super+F11';
const audioFixture = resolve('tests/desktop/fixtures/konnichiwa.wav');
const manifest = JSON.parse(await readFile('extension/moonshine-small-ja-assets.json', 'utf8'));

async function eventually(check, description, timeout = 10000) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    const result = await check();
    if (result) return result;
    await wait(100);
  }
  throw Error(description);
}

async function temp(t, prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10 }));
  return path;
}

async function launch(t) {
  const profile = await mkdtemp(join(tmpdir(), 'desktop-macos-'));
  let desktop;
  t.after(async () => {
    await desktop?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 10 });
  });
  desktop = await _electron.launch({
    executablePath: binary, args: ['--user-data-dir=' + profile], chromiumSandbox: true, timeout: 30000,
  });
  const management = await eventually(
    () => desktop.windows().find(page => page.url().endsWith('/management.html')), 'Management window did not load',
  );
  assert.deepEqual(await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged, profile: app.getPath('userData'), name: app.getName(),
  })), { packaged: true, profile: await realpath(profile), name: 'My Audio to Text' });
  const view = () => management.evaluate(() => window.desktop.get());
  return { desktop, management, view };
}

function shortcutClient(t) {
  const process = spawn(join(dirname(binary), 'focused-text'), [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = once(process, 'exit');
  const lines = createInterface({ input: process.stdout });
  t.after(async () => {
    process.stdin.end();
    const timer = setTimeout(() => process.kill(), 2000);
    try { await exited; }
    finally { clearTimeout(timer); }
  });
  let request = 0;
  return async text => {
    const response = once(lines, 'line', { signal: AbortSignal.timeout(5000) });
    process.stdin.write(JSON.stringify({ request: ++request, action: 'set-shortcut', text }) + '\n');
    const [line] = await response;
    const value = JSON.parse(line);
    assert.equal(value.request, request);
    return value.error;
  };
}

async function fixture(t) {
  let tool = process.env.DESKTOP_MACOS_TEST_DRIVER;
  if (!tool) {
    const directory = await temp(t, 'desktop-macos-fixture-');
    tool = join(directory, 'fixture');
    execFileSync('xcrun', ['swiftc', '-O', 'tests/desktop/macos-fixture.swift', '-o', tool]);
  }
  return (...args) => execFileSync(tool, args, { encoding: 'utf8', timeout: 25000 }).trim();
}

async function inputFixture(t) {
  const run = await fixture(t);
  assert.deepEqual(JSON.parse(run('permissions')), { accessibility: true, keyboard: true },
    'The macOS test driver needs normal Accessibility and keyboard event permission');
  return run;
}

function testGraph(output, text) {
  const literal = graphNode('Text', 'literal', 20, 50);
  literal.settings.value = text;
  return { version: GRAPH_VERSION, nodes: [literal, graphNode(output, 'out', 280, 50)],
    edges: [edge('literal', 'value', 'out', output === 'Display' ? 'input1' : 'text')] };
}

async function selectFocusedGraph({ desktop, management }, name, literal = '') {
  await management.evaluate(async ({ graph, name }) => {
    const entry = await window.desktop.add(name, graph);
    await window.desktop.select(entry.id);
  }, { graph: testGraph(FOCUSED_OUTPUT, literal), name });
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/management.html')).close();
  });
}

async function externalEditor(t, run, name, initialText) {
  const path = join(await temp(t, 'desktop-textedit-'), `${name}.txt`);
  await writeFile(path, initialText);
  const existing = new Set(run('textedit-pids').split(' '));
  execFileSync('/usr/bin/open', ['-n', '-a', '/System/Applications/TextEdit.app', path]);
  const pid = await eventually(() => {
    if (run('frontmost') !== 'com.apple.TextEdit') return false;
    const pid = run('front-pid');
    return !existing.has(pid) && Number(pid);
  }, 'The test TextEdit instance did not come to the foreground');
  t.after(() => {
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  });
  const text = () => JSON.parse(run('text'));
  await eventually(() => {
    try { return text() === initialText; }
    catch { return false; }
  }, 'Independent editor did not open the test document');
  return { pid, text };
}

async function runningWithExternalFocus({ desktop, view }, run, pid) {
  await eventually(async () => {
    const { session } = await view();
    if (session.error) throw Error(session.error);
    return session.phase === 'running';
  }, 'The packaged graph did not start');
  const indicator = await eventually(() => desktop.windows().find(page => page.url().endsWith('/indicator.html')),
    'The indicator did not load');
  await eventually(async () => (await indicator.getByRole('status').textContent()) === 'Running',
    'The indicator did not show the running graph');
  const indicatorState = await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/indicator.html'));
    return { visible: window.isVisible(), focused: window.isFocused() };
  });
  assert.deepEqual(indicatorState, { visible: true, focused: false });
  assert.equal(Number(run('front-pid')), pid);
}

async function idle(view) {
  return eventually(async () => {
    const { session } = await view();
    return session.phase === 'idle' && session;
  }, 'The packaged graph did not stop');
}

async function textProducer(desktop) {
  const runtime = await eventually(() => desktop.windows().find(page => page.url().endsWith('/runtime.html')),
    'The packaged runtime did not load');
  await runtime.evaluate(async () => {
    // Control the timing of one graph source. Pipeline, IPC, and the native
    // output helper are the production path, including output serialization.
    const { TextNode } = await import(new URL('../web/text-constant-node.js', location.href));
    TextNode.prototype.start = function (context) {
      globalThis.emitTestText = values => values.forEach(value => context.emit('value', value));
    };
  });
  return (...values) => runtime.evaluate(values => globalThis.emitTestText(values), values);
}

test('macOS package launches, retains its shortcut after closing management, and releases it on Quit', {
  timeout: 45000,
}, async t => {
  const { desktop, management, view } = await launch(t);
  const reserve = shortcutClient(t);
  assert.equal((await view()).library.shortcut, defaultShortcut);
  assert.equal((await view()).shortcutError, '');
  assert.match(await reserve(defaultShortcut), /unavailable/);
  assert.equal(await reserve(conflictingShortcut), undefined);
  await assert.rejects(management.evaluate(value => window.desktop.shortcut(value), conflictingShortcut), /unavailable/);
  assert.equal((await view()).library.shortcut, defaultShortcut);
  await reserve('');

  const graph = testGraph('Display', ' 東京🙂\n');
  await management.evaluate(async graph => {
    const entry = await window.desktop.add('Packaged display test', graph);
    await window.desktop.startLive(entry.id);
  }, graph);
  await eventually(async () => (await view()).items.some(item => JSON.stringify(item).includes('東京🙂')),
    'Packaged Pipeline did not reach Live display');
  await management.evaluate(() => window.desktop.stop());
  await eventually(async () => (await view()).session.phase === 'idle', 'Desktop did not finish the graph');

  assert.equal(await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/management.html'));
    window.close();
    return window.isVisible();
  }), false);
  assert.match(await reserve(defaultShortcut), /unavailable/);
  await desktop.close();
  assert.equal(await reserve(defaultShortcut), undefined);
});

test('macOS host ignores a shortcut release from an ended Display-only session', {
  timeout: 45000,
}, async t => {
  const { desktop, management, view } = await launch(t);
  await desktop.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const load = createRequire(`${app.getAppPath()}/package.json`);
    const { FocusedTarget } = load('./desktop/focused-target.js');
    const request = FocusedTarget.prototype.request;
    FocusedTarget.prototype.request = function (action, token, text) {
      // Control only the shortcut message timing at the helper boundary.
      if (action === 'shortcut-context' && token) {
        globalThis.releaseTestShortcut = value => this.worker.process.stdout.emit('data', Buffer.from(
          JSON.stringify({ shortcut: value, release: 0, context: text }) + '\n',
        ));
      }
      return request.call(this, action, token, text);
    };
  });
  const entry = await management.evaluate(graph => window.desktop.add('Held Live shortcut', graph),
    testGraph('Display', 'Live output'));
  const startLive = async () => {
    await management.evaluate(id => window.desktop.startLive(id), entry.id);
    await eventually(async () => (await view()).session.phase === 'running', 'Live did not start');
  };
  const release = () => desktop.evaluate((_electron, value) => globalThis.releaseTestShortcut(value), defaultShortcut);
  await startLive();
  await management.evaluate(() => window.desktop.stop());
  assert.equal((await idle(view)).error, '');
  await release();
  await wait(250);
  const { session } = await view();
  assert.equal(session.phase, 'idle');
  assert.equal(session.error, '');

  await startLive();
  await release();
  assert.equal((await idle(view)).error, '');
});

test('native shortcut and menu insert ordered Unicode at the TextEdit caret with the indicator visible', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  const app = await launch(t);
  const { desktop, view } = app;
  const emit = await textProducer(desktop);
  await selectFocusedGraph(app, 'TextEdit OS target');
  const { pid, text } = await externalEditor(t, run, 'dictation target', 'left|right');
  run('caret', '5');
  run('shortcut');
  await runningWithExternalFocus(app, run, pid);
  await emit(' 東京', '🙂\n ', 'か\u3099');
  const prefix = 'left| 東京🙂\n か\u3099';
  await eventually(() => text() === prefix + 'right', 'TextEdit did not receive the complete TEXT in order');
  run('shortcut-down');
  try {
    await emit(' held ');
    await wait(250);
    assert.equal(text(), prefix + 'right');
  } finally { run('shortcut-up'); }
  assert.equal((await idle(view)).error, '');
  assert.equal(Number(run('front-pid')), pid);
  assert.equal(text(), prefix + ' held right');

  const tray = label => run('tray', String(desktop.process().pid), label);
  tray('Start voice typing');
  await runningWithExternalFocus(app, run, pid);
  await emit('tray ');
  await eventually(() => text() === prefix + ' held tray right', 'Native menu Start did not authorize the caret');
  tray('Stop voice typing');
  assert.equal((await idle(view)).error, '');
  assert.equal(Number(run('front-pid')), pid);
  assert.equal(text(), prefix + ' held tray right');

  tray('Start voice typing');
  await runningWithExternalFocus(app, run, pid);
  const reserve = shortcutClient(t);
  assert.match(await reserve(defaultShortcut), /unavailable/);
  const exited = once(desktop.process(), 'exit');
  tray('Quit');
  await exited;
  assert.equal(await reserve(defaultShortcut), undefined);
  assert.equal(text(), prefix + ' held tray right');
});

test('held macOS shortcut cannot restart ended Live or commit after cancellation or a change of target', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  const app = await launch(t);
  const { desktop, management, view } = app;
  const emit = await textProducer(desktop);
  await selectFocusedGraph(app, 'Held shortcut target');
  const second = await externalEditor(t, run, 'other target', 'other');
  const first = await externalEditor(t, run, 'original target', 'left|right');
  run('caret', '5');

  const live = await management.evaluate(graph => window.desktop.add('Display-only Live', graph), testGraph('Display', ''));
  await management.evaluate(id => window.desktop.startLive(id), live.id);
  await runningWithExternalFocus(app, run, first.pid);
  run('shortcut-down');
  try {
    await management.evaluate(() => window.desktop.stop());
    assert.equal((await idle(view)).error, '');
  } finally { run('shortcut-up'); }
  await wait(250);
  assert.equal((await view()).session.phase, 'idle');
  assert.equal((await view()).session.error, '');
  assert.equal(first.text(), 'left|right');

  run('shortcut');
  await runningWithExternalFocus(app, run, first.pid);
  run('shortcut-down');
  try {
    await emit('must never be inserted🙂\n');
    await wait(250);
    assert.equal(first.text(), 'left|right');
    await management.evaluate(() => window.desktop.cancel());
    assert.equal((await idle(view)).error, '');
  } finally { run('shortcut-up'); }
  await wait(250);
  assert.equal((await view()).session.phase, 'idle');
  assert.equal((await view()).session.error, '');
  assert.equal(first.text(), 'left|right');

  run('shortcut');
  await runningWithExternalFocus(app, run, first.pid);
  run('shortcut-down');
  try {
    await emit('must never cross windows🙂\n');
    await wait(250);
    assert.equal(first.text(), 'left|right');
    run('activate', String(second.pid));
    await eventually(() => Number(run('front-pid')) === second.pid, 'The second TextEdit window did not receive focus');
    assert.match((await idle(view)).error, /changed or lost focus/);
  } finally { run('shortcut-up'); }
  assert.equal(second.text(), 'other');
  run('activate', String(first.pid));
  await eventually(() => Number(run('front-pid')) === first.pid, 'The original TextEdit window did not receive focus');
  assert.equal(first.text(), 'left|right');
});

test('macOS rejects protected, read-only, and constrained controls in independent Chrome before editing', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  const app = await launch(t);
  await selectFocusedGraph(app, 'Browser safety target', ' 東京🙂\n ');
  const indicator = app.desktop.windows().find(page => page.url().endsWith('/indicator.html'));
  const fixture = await readFile('tests/desktop/browser-target.html');
  const server = createServer((request, response) => {
    if (request.url === '/state') {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('null');
    } else response.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const browser = await chromium.launch({
    channel: 'chrome', headless: false, args: ['--disable-extensions'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.bringToFront();
  await eventually(() => run('frontmost') === 'com.google.Chrome', 'Independent Chrome did not become active');
  const state = () => page.evaluate(() => ({
    values: Object.fromEntries(fields.map(field => [field.id, field.value ?? field.textContent])),
    focus: document.activeElement.id, caret: caret(), edits, submits, active: document.hasFocus(),
  }));
  for (const field of ['password', 'readonly', 'limited', 'multiline']) {
    await page.locator('#' + field).click();
    const original = await state();
    assert.equal(original.focus, field);
    assert.equal(original.active, true);
    run('shortcut');
    await eventually(async () => {
      const { session } = await app.view();
      if (session.phase !== 'idle' || !session.error) return false;
      assert.match(session.error, /cannot be safely edited/i);
      return true;
    }, `The packaged app did not refuse ${field}`);
    assert.deepEqual(await state(), original);
    assert.deepEqual(original.edits, []);
    assert.equal(original.submits, 0);
    await indicator.getByRole('button', { name: 'Dismiss' }).evaluate(button => button.click());
    await eventually(async () => !(await app.view()).session.error, 'The previous refusal was not dismissed');
  }
});

test('macOS package captures a virtual microphone and delivers a real offline Japanese Moonshine final to Live', {
  skip: process.env.DESKTOP_REAL_ASR !== '1', timeout: 900000,
}, async t => {
  const run = await fixture(t);
  const { desktop, management, view } = await launch(t);
  assert.equal(await desktop.evaluate(({ systemPreferences }) => systemPreferences.getMediaAccessStatus('microphone')), 'granted',
    'The extracted app needs normal macOS microphone permission');
  const live = defaultDesktopGraph();
  const sink = live.nodes.find(node => node.type === FOCUSED_OUTPUT);
  live.nodes[live.nodes.indexOf(sink)] = graphNode('Display', sink.id, sink.position.x, sink.position.y);
  live.edges[1] = edge(live.edges[1].from[0], 'final', sink.id, 'input1');
  const entry = await management.evaluate(graph => window.desktop.add('Japanese loopback smoke', graph), live);
  const prepare = await management.evaluate(() => window.desktop.model('modelPrepare'));
  assert.equal(prepare.state, 'Ready', JSON.stringify(prepare));
  await desktop.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }));
  });

  const previousInput = run('input');
  const loopback = run('blackhole');
  try {
    run('set-input', loopback);
    assert.equal(run('input'), loopback);
    await management.evaluate(id => window.desktop.startLive(id), entry.id);
    await eventually(async () => {
      const { session } = await view();
      if (session.error) throw Error(session.error);
      return session.phase === 'running' && session.microphone;
    }, 'The packaged app did not start recording from the virtual input', 90000);
    run('play', audioFixture);
    await management.evaluate(() => window.desktop.stop());
    await eventually(async () => (await view()).session.phase === 'idle', 'The recording did not stop', 90000);
  } finally {
    if (run('input') === loopback && previousInput !== loopback) run('set-input', previousInput);
  }
  const { session, items } = await view();
  assert.equal(session.error, '');
  const transcript = items.find(item => item.node === sink.id)?.item;
  assert.equal(typeof transcript, 'string', JSON.stringify(items));
  assert.match(transcript, /\S/);
  console.log(JSON.stringify({ model: manifest.id, revision: manifest.revision,
    fixture: 'tests/desktop/fixtures/konnichiwa.wav', transcript, output: 'Live Display', network: 'HTTP(S) blocked' }));
});
