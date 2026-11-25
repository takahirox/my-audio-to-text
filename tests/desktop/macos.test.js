import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { _electron } from 'playwright';
import { defaultDesktopGraph, FOCUSED_OUTPUT } from '../../desktop/graph.js';
import { edge, graphNode, GRAPH_VERSION } from '../../extension/graph.js';
import { browserFixture } from './browser-fixture.js';

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

function requireNativeInput(run) {
  assert.deepEqual(JSON.parse(run('permissions')), { accessibility: true, keyboard: true },
    'The macOS test driver needs normal Accessibility and keyboard event permission');
}

async function inputFixture(t) {
  const run = await fixture(t);
  requireNativeInput(run);
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

async function externalChrome(t, run) {
  const { url, state, select } = await browserFixture(t);
  const profile = await mkdtemp(join(tmpdir(), 'desktop-chrome-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${profile}`, url,
  ], { stdio: 'ignore' });
  const closed = once(chrome, 'close');
  void closed.catch(() => {});
  t.after(async () => {
    try {
      if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill();
        const timer = setTimeout(() => chrome.kill('SIGKILL'), 3000);
        try { await closed; }
        finally { clearTimeout(timer); }
      }
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 10 });
    }
  });
  await once(chrome, 'spawn');
  const pid = chrome.pid;
  await eventually(() => Number(run('front-pid')) === pid && state()?.active,
    'The independent Chrome window did not receive focus', 30000);

  const focus = (field, caret, limitOnEdit) => {
    const serial = select(field, caret, limitOnEdit);
    return eventually(() => {
      const current = state();
      return current.selection === serial && current.active && current.focus === field && current.caret === caret && current;
    }, `Chrome did not focus the test caret in ${field}`);
  };
  return { pid, state, focus };
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

test('macOS dispatch rechecks the bound window and field after reading the selection', async t => {
  const directory = await temp(t, 'desktop-macos-dispatch-');
  const tool = join(directory, 'dispatch-fixture');
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon',
    'tests/desktop/macos-dispatch-fixture.m', '-o', tool]);
  const results = execFileSync(tool, { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(JSON.parse);
  assert.deepEqual(results, [{ request: 1, error: 'The authorized TextEdit document changed or lost focus.' }, { request: 2 }]);
});

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

test('macOS rejects a pending edit when focus moves between documents in the same TextEdit process', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  const app = await launch(t);
  const emit = await textProducer(app.desktop);
  await selectFocusedGraph(app, 'Same-process focus change');
  const { pid, text } = await externalEditor(t, run, 'original document', 'left|right');
  const original = run('editor-window');
  run('editor-new');
  const other = await eventually(() => {
    const title = run('editor-window');
    return title !== original && title;
  }, 'TextEdit did not open a second document');
  const focus = async title => {
    run('editor-raise', title);
    await eventually(() => run('editor-window') === title, 'The requested TextEdit document did not receive focus');
    assert.equal(Number(run('front-pid')), pid);
  };
  const otherText = text();
  await focus(original);
  run('caret', '5');
  run('shortcut');
  await runningWithExternalFocus(app, run, pid);
  run('shortcut-down');
  try {
    await emit('must never reach either document🙂');
    await wait(250);
    assert.equal(text(), 'left|right');
    await focus(other);
  } finally { run('shortcut-up'); }
  assert.match((await idle(app.view)).error, /changed or lost focus/);
  assert.equal(text(), otherText);
  await focus(original);
  assert.equal(text(), 'left|right');
});

test('native shortcut inserts rapid Unicode commits at the caret in independent Chrome', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await fixture(t);
  const app = await launch(t);
  const emit = await textProducer(app.desktop);
  await selectFocusedGraph(app, 'Chrome OS target');
  const chrome = await externalChrome(t, run);
  const before = await chrome.focus('notes', 5);
  t.diagnostic('The independent Chrome window and ordinary textarea received focus.');
  requireNativeInput(run);
  const commits = [' 東京', '🙂\n ', 'か\u3099'];
  const prefix = 'left|' + commits.join('');
  const expected = { ...before.values, notes: prefix + 'right' };

  run('shortcut');
  await runningWithExternalFocus(app, run, chrome.pid);
  await emit(...commits);
  await eventually(() => chrome.state().values.notes === expected.notes,
    'Chrome did not receive the complete committed TEXT in order');
  const inserted = chrome.state();
  assert.deepEqual(inserted.values, expected);
  assert.equal(inserted.focus, 'notes');
  assert.equal(inserted.caret, prefix.length);
  assert.equal(inserted.active, true);
  assert.equal(inserted.submits, 0);
  run('shortcut');
  assert.equal((await idle(app.view)).error, '');
  assert.equal(Number(run('front-pid')), chrome.pid);

  run('shortcut');
  await runningWithExternalFocus(app, run, chrome.pid);
  run('shortcut-down');
  try {
    await emit('must never reach the newly focused field🙂');
    await chrome.focus('field', 5);
    assert.match((await idle(app.view)).error, /changed or lost focus/);
  } finally { run('shortcut-up'); }
  const released = chrome.state().report;
  await eventually(() => chrome.state().report > released, 'Chrome stopped reporting state after shortcut release');
  assert.deepEqual(chrome.state().values, expected);
  assert.equal(chrome.state().submits, 0);
});

test('macOS rejects protected, read-only, and constrained controls in independent Chrome before editing', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  const app = await launch(t);
  await selectFocusedGraph(app, 'Browser safety target', ' 東京🙂\n ');
  const indicator = app.desktop.windows().find(page => page.url().endsWith('/indicator.html'));
  const chrome = await externalChrome(t, run);
  for (const field of ['password', 'readonly', 'limited', 'multiline']) {
    const { report: _report, ...original } = await chrome.focus(field, 1);
    run('shortcut');
    await eventually(async () => {
      const { session } = await app.view();
      if (session.phase !== 'idle' || !session.error) return false;
      assert.match(session.error, /cannot be safely edited/i);
      return true;
    }, `The packaged app did not refuse ${field}`);
    const report = chrome.state().report;
    const after = await eventually(() => {
      const current = chrome.state();
      if (current.report <= report) return false;
      const { report: _, ...snapshot } = current;
      return snapshot;
    }, 'Chrome did not report its state after the refusal');
    assert.deepEqual(after, original);
    assert.deepEqual(original.edits, []);
    assert.equal(original.submits, 0);
    await indicator.getByRole('button', { name: 'Dismiss' }).evaluate(button => button.click());
    await eventually(async () => !(await app.view()).session.error, 'The previous refusal was not dismissed');
  }
});

test('macOS avoids a partial edit when Chrome constrains a textarea during insertion', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  const app = await launch(t);
  const emit = await textProducer(app.desktop);
  await selectFocusedGraph(app, 'Late browser length constraint');
  const chrome = await externalChrome(t, run);
  const before = await chrome.focus('notes', 5, true);
  assert.equal(before.notesMaxLength, -1);

  run('shortcut');
  await runningWithExternalFocus(app, run, chrome.pid);
  await emit('A東京🙂\n');
  assert.ok((await idle(app.view)).error, 'The packaged app did not report the rejected edit');
  const report = chrome.state().report;
  const after = await eventually(() => {
    const current = chrome.state();
    return current.report > report && current;
  }, 'Chrome did not report its state after the rejected edit');

  assert.deepEqual(after.values, before.values);
  assert.equal(after.caret, before.caret);
  assert.equal(after.focus, 'notes');
  assert.equal(after.active, true);
  assert.equal(Number(run('front-pid')), chrome.pid);
  assert.equal(after.submits, 0);
  assert.equal(after.edits.some(([event]) => event === 'input'), false, 'A partial edit reached the page');
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
