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
import { FocusedApplicationTextOutputNode } from '../../desktop/focused-output.js';
import { FocusedTarget } from '../../desktop/focused-target.js';
import { defaultDesktopGraph, FOCUSED_OUTPUT } from '../../desktop/graph.js';
import { DesktopSession } from '../../desktop/session.js';
import { edge, graphNode, GRAPH_VERSION } from '../../extension/graph.js';
import { Pipeline } from '../../web/pipeline.js';
import { TEXT } from '../../web/port-contracts.js';
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

async function launch(t, existingProfile) {
  const profile = existingProfile ?? await mkdtemp(join(tmpdir(), 'desktop-macos-'));
  let desktop;
  t.after(async () => {
    await desktop?.close().catch(() => {});
    if (!existingProfile) await rm(profile, { recursive: true, force: true, maxRetries: 10 });
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
  // The renderer can load before the tray and shortcut have initialized.
  await eventually(
    () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .some(window => window.webContents.getURL().endsWith('/management.html') && window.isVisible())),
    'The packaged app did not show the management window',
  );
  const view = () => management.evaluate(() => window.desktop.get());
  return { desktop, management, view, profile };
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
  const permissions = JSON.parse(run('permissions'));
  if (!permissions.accessibility || !permissions.keyboard) {
    t.skip(`Native input permission preflight blocked: ${JSON.stringify(permissions)}`);
    return;
  }
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
  const existing = new Set(run('app-pids', 'com.apple.TextEdit').split(' '));
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

async function externalSafari(t, run) {
  const { url, state, select } = await browserFixture(t);
  const bundle = 'com.apple.Safari';
  const existing = new Set(run('app-pids', bundle).split(' '));
  execFileSync('/usr/bin/open', ['-n', '-a', '/Applications/Safari.app', url]);
  const pid = await eventually(() => {
    if (run('frontmost') !== bundle) return false;
    const pid = run('front-pid');
    return !existing.has(pid) && Number(pid);
  }, 'The independent Safari test instance did not come to the foreground', 30000);
  t.after(() => {
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  });
  await eventually(() => state()?.active, 'The Safari test page did not receive focus');

  const focus = (field, caret, limitOnEdit) => {
    const serial = select(field, caret, limitOnEdit);
    return eventually(() => {
      const current = state();
      return current.selection === serial && current.active && current.focus === field && current.caret === caret && current;
    }, `Safari did not focus the test caret in ${field}`);
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

async function compileDispatchFixture(t) {
  const directory = await temp(t, 'desktop-macos-dispatch-');
  const tool = join(directory, 'dispatch-fixture');
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon',
    'tests/desktop/macos-dispatch-fixture.m', '-o', tool]);
  return tool;
}

const plainText = 'public.utf8-plain-text';
const originalClipboard = [
  { [plainText]: 'existing', 'public.html': '<b>existing</b>' },
  { 'net.example.binary': 'AP8=' },
];

function dispatchFixture(t, tool) {
  const target = new FocusedTarget(tool, [], {
    onInvalid: (id, error) => { void controller.cancel(error, id); },
    onLost: () => {},
  });
  const controller = new DesktopSession({ target, run: async () => {}, onChange: () => {} });
  const lines = createInterface({ input: target.connect().process.stdout });
  t.after(() => {
    lines.close();
    target.close();
  });
  let state, waiting, focusReadPaused;
  lines.on('line', line => {
    const message = JSON.parse(line);
    state = message.fixture ?? state;
    waiting = message.waiting ?? waiting;
    focusReadPaused = message.focusReadPaused ?? focusReadPaused;
  });
  const configure = async (options = {}) => {
    await target.request('fixture', null, options);
    return state;
  };
  const dispatched = count => eventually(async () => {
    const current = await configure();
    return current.keyDowns === count && current;
  }, 'The helper did not dispatch the expected number of pastes');
  const start = async () => {
    await target.request('snapshot-tray');
    await controller.start({ focused: true, microphone: false, displays: [], graph: {} }, 'bind-tray');
    return controller.current?.id;
  };
  // The stdin reader signals the blocked AX call without waiting for main.
  const resumeFocus = () => target.connect().process.stdin.write('{"action":"resume-focus"}\n');
  return { target, controller, configure, dispatched, start, resumeFocus, waiting: () => waiting, focusReadPaused: () => focusReadPaused };
}

test('macOS clipboard paste', async t => {
  const tool = await compileDispatchFixture(t);

  await t.test('streams rapid committed TEXT through a delayed AppKit editor read', async t => {
    const { controller, configure, dispatched, start } = dispatchFixture(t, tool);
    await configure({ frontPid: 200, noRole: true, noField: true, noWindow: true });
    const id = await start();
    assert.ok(id);
    let source;
    const pipeline = new Pipeline({
      nodes: {
        source: { outputs: { text: TEXT }, start(context) { source = context; } },
        target: new FocusedApplicationTextOutputNode(text => controller.insert(id, text)),
      },
      connections: [edge('source', 'text', 'target', 'text')],
    });
    await pipeline.start();
    t.after(() => pipeline.dispose());
    const chunks = [' 東京🙂\n\t', ' 東京🙂\n\t', ' か\u3099 '];
    source.emitOutputs({ text: 'unfinished hypothesis' }, { provisional: true });
    source.emit('text', '');
    for (const chunk of chunks) source.emit('text', chunk);
    source.emitOutputs({ text: 'another hypothesis' }, { provisional: true });

    let prefix = 'left';
    for (const [index, chunk] of chunks.entries()) {
      const staged = await dispatched(index + 1);
      assert.equal(controller.state.phase, 'running');
      assert.equal(staged.keyUps, index + 1);
      assert.deepEqual(staged.keyCodes.slice(-2), [47, 47]); // Command+V in Dvorak.
      assert.equal(staged.clipboard[0][plainText], chunk);
      assert.equal(staged.currentHostOnly, true);
      assert.deepEqual(staged.reads, chunks.slice(0, index));
      assert.deepEqual((await configure({ advance: 149 })).reads, chunks.slice(0, index));

      prefix += chunk;
      const consumed = await configure({ advance: 1 });
      assert.deepEqual(consumed.reads, chunks.slice(0, index + 1));
      assert.equal(consumed.text, prefix + 'right');
      assert.equal(consumed.clipboard[0][plainText], chunk);
      const settled = await configure({ advance: 100 });
      assert.deepEqual(settled.clipboard, originalClipboard);
      assert.equal(settled.currentHostOnly, true);
    }
    await pipeline.stop();
    await controller.stop();
    assert.equal(controller.state.error, '');
    assert.equal((await configure()).keyDowns, chunks.length);
  });

  await t.test('uses the keyboard layout selected during clipboard staging', async t => {
    const { controller, configure, dispatched, start } = dispatchFixture(t, tool);
    await configure({ switchLayoutAfterStage: true });
    const id = await start();
    assert.ok(id);
    const pending = controller.insert(id, 'new layout');
    await dispatched(1);
    const settled = await configure({ advance: 250 });
    await pending;
    await controller.stop();
    assert.deepEqual(settled.keyCodes, [9, 9]); // Command+V in US.
    assert.deepEqual(settled.clipboard, originalClipboard);
  });

  await t.test('waits for modifiers and drains accepted chunks on Stop', async t => {
    const { controller, configure, dispatched, start, waiting } = dispatchFixture(t, tool);
    await configure({ clear: true });
    const id = await start();
    assert.ok(id);
    await configure({ modifiers: true });
    const first = controller.insert(id, 'one');
    const second = controller.insert(id, 'two');
    const stopped = controller.stop();
    await eventually(waiting, 'The helper did not wait for modifier release');
    const held = await configure({ advance: 1000 });
    assert.deepEqual(held.clipboard, []);
    assert.equal(held.keyDowns, 0);
    assert.equal(controller.state.phase, 'stopping');
    const released = await configure({ modifiers: false, advance: 100 });
    assert.equal(released.keyDowns, 1);
    await configure({ advance: 250 });
    await first;
    await dispatched(2);
    await configure({ advance: 250 });
    await second;
    await stopped;
    const state = await configure();
    assert.deepEqual(state.reads, ['one', 'two']);
    assert.deepEqual(state.clipboard, []);
    assert.equal(controller.state.error, '');
  });

  await t.test('preserves a newer copy before dispatch and after dispatch', async t => {
    const { controller, configure, dispatched, start } = dispatchFixture(t, tool);
    const id = await start();
    const first = controller.insert(id, 'same text');
    await dispatched(1);
    await configure({ advance: 150 });
    // Same text still creates a new generation with its own ownership.
    await configure({ copy: 'same text', advance: 100 });
    await first;
    assert.deepEqual((await configure()).clipboard, [{ [plainText]: 'same text' }]);

    await configure({ copyAfterStage: true });
    await assert.rejects(controller.insert(id, 'discarded'), /clipboard changed before Paste/);
    await controller.current?.canceling;
    const state = await configure();
    assert.deepEqual(state.clipboard, [{ [plainText]: 'copied before dispatch' }]);
    assert.deepEqual(state.reads, ['same text']);
    assert.equal(state.keyDowns, 1);
  });

  await t.test('protects the clipboard on read or stage failure and never retries an ambiguous paste', async t => {
    const { controller, configure, dispatched, start } = dispatchFixture(t, tool);
    let id = await start();
    await configure({ failSnapshot: true });
    await assert.rejects(controller.insert(id, 'never staged'), /read the existing clipboard/);
    await controller.current?.canceling;
    assert.deepEqual((await configure()).clipboard, originalClipboard);

    id = await start();
    await configure({ failSnapshot: false, failStage: true });
    await assert.rejects(controller.insert(id, 'never posted'), /stage text/);
    await controller.current?.canceling;
    const afterFailure = await configure({ failStage: false, failRestore: true });
    assert.equal(afterFailure.keyDowns, 0);
    assert.deepEqual(afterFailure.clipboard, originalClipboard);

    id = await start();
    const first = assert.rejects(controller.insert(id, 'already posted'), /restore the clipboard/);
    const second = assert.rejects(controller.insert(id, 'queued'), /no longer authorized/);
    await dispatched(1);
    await configure({ advance: 250 });
    await Promise.all([first, second]);
    await controller.current?.canceling;
    const state = await configure({ advance: 1000 });
    assert.equal(state.keyDowns, 1);
    assert.deepEqual(state.reads, ['already posted']);
  });

  await t.test('Cancel before dispatch restores staged data and drops pending text', async t => {
    const { controller, configure, start, focusReadPaused, resumeFocus } = dispatchFixture(t, tool);
    const id = await start();
    await configure({ pauseAfterStage: true });
    const first = assert.rejects(controller.insert(id, 'staged'), /changed or lost focus/);
    const second = assert.rejects(controller.insert(id, 'queued'), /no longer authorized/);
    await eventually(focusReadPaused, 'The helper did not reach its dispatch focus check');
    const canceled = controller.cancel();
    resumeFocus();
    await Promise.all([first, second, canceled]);
    const state = await configure({ advance: 1000 });
    assert.equal(state.keyDowns, 0);
    assert.deepEqual(state.clipboard, originalClipboard);
  });

  await t.test('Cancel restores staged data without pasting when focus outlasts the request timeout', {
    timeout: 15000,
  }, async t => {
    const { target, controller, configure, start, focusReadPaused } = dispatchFixture(t, tool);
    const child = target.connect().process;
    const closed = once(child, 'close');
    t.after(() => { child.kill(); });
    const quitReport = join(await temp(t, 'desktop-macos-cancel-'), 'result.json');
    await configure({ pauseAfterStage: true, focusStallMs: 8000, quitReport });
    const id = await start();
    assert.ok(id);
    const first = assert.rejects(controller.insert(id, 'staged during Cancel'), /did not respond/);
    const second = assert.rejects(controller.insert(id, 'queued during Cancel'), /no longer authorized/);
    await eventually(focusReadPaused, 'The helper did not stall after staging');
    await Promise.all([first, second, controller.cancel()]);

    assert.match(controller.state.error, /did not respond/);
    assert.deepEqual(await closed, [0, null], 'The helper must be allowed to finish clipboard cleanup');
    const state = JSON.parse(await readFile(quitReport, 'utf8'));
    assert.deepEqual(state.clipboard, originalClipboard);
    assert.deepEqual(state.reads, []);
    assert.equal(state.keyDowns, 0);
    assert.equal(state.keyUps, 0);
  });

  await t.test('Cancel after dispatch lets the editor read before restoring and drops queued text', async t => {
    const { controller, configure, dispatched, start } = dispatchFixture(t, tool);
    const id = await start();
    const first = controller.insert(id, 'already posted');
    const second = assert.rejects(controller.insert(id, 'queued'), /no longer authorized/);
    await dispatched(1);
    const canceled = controller.cancel();
    const beforeRead = await configure();
    assert.equal(controller.state.phase, 'canceling');
    assert.equal(beforeRead.clipboard[0][plainText], 'already posted');
    await configure({ advance: 250 });
    await Promise.all([first, second, canceled]);
    const state = await configure();
    assert.deepEqual(state.reads, ['already posted']);
    assert.equal(state.keyDowns, 1);
    assert.deepEqual(state.clipboard, originalClipboard);
    assert.equal(controller.state.phase, 'idle');
  });

  await t.test('lets the native editor reject Paste when Accessibility exposes no editing metadata', async t => {
    const { controller, configure, dispatched, start } = dispatchFixture(t, tool);
    await configure({ noRole: true, editorEditable: false });
    const id = await start();
    assert.ok(id);
    const pending = controller.insert(id, 'native constraint');
    await dispatched(1);
    const settled = await configure({ advance: 250 });
    await pending;
    await controller.stop();
    assert.equal(settled.text, 'left|right');
    assert.deepEqual(settled.reads, ['native constraint']);
    assert.deepEqual(settled.clipboard, originalClipboard);
    assert.equal((await configure()).keyDowns, 1);
    assert.equal(controller.state.error, '');
  });

  await t.test('refuses known protection and authorization failures at Start or dispatch', async t => {
    const cases = [
      ['protected', true, /protected/], ['secureInput', true, /Secure Keyboard Entry/],
      ['disabled', true, /disabled/], ['readOnly', true, /read-only/], ['notEditable', true, /read-only/],
      ['canPost', false, /post keyboard events/], ['trusted', false, /Accessibility/],
    ];
    for (const [option, value, error] of cases) {
      const { controller, configure, start } = dispatchFixture(t, tool);
      await configure({ [option]: value });
      assert.equal(await start(), undefined);
      assert.match(controller.state.error, error);

      await configure({ [option]: !value });
      const id = await start();
      assert.ok(id);
      await configure({ [option]: value });
      await assert.rejects(controller.insert(id, 'must not dispatch'), error);
      await controller.current?.canceling;
      const state = await configure();
      assert.equal(state.keyDowns, 0);
      assert.deepEqual(state.clipboard, originalClipboard);
    }
  });

  await t.test('stops on an observed app, window or field change', async t => {
    const cases = [
      [{ noField: true, noWindow: true }, { frontPid: 200 }],
      [{ noField: true }, { focused: 1 }],
      [{ noField: true, systemField: true, sameWindow: true }, { switchAfterStage: true }],
    ];
    for (const [initial, changed] of cases) {
      const { controller, configure, start } = dispatchFixture(t, tool);
      await configure(initial);
      const id = await start();
      assert.ok(id);
      await configure(changed);
      await assert.rejects(controller.insert(id, 'must not cross targets'), /changed or lost focus/);
      await controller.current?.canceling;
      const state = await configure();
      assert.equal(state.keyDowns, 0);
      assert.equal(state.other, 'other');
      assert.deepEqual(state.clipboard, originalClipboard);
    }
  });

  await t.test('restores the clipboard without posting Paste when focus moves during the last protection check', async t => {
    const { controller, configure, start } = dispatchFixture(t, tool);
    await configure({ sameWindow: true });
    const id = await start();
    assert.ok(id);
    await configure({ switchDuringProtection: true });

    await assert.rejects(controller.insert(id, 'must not cross fields'), /changed or lost focus/);
    await controller.current?.canceling;
    const state = await configure();
    assert.equal(state.keyDowns, 0);
    assert.equal(state.keyUps, 0);
    assert.deepEqual(state.clipboard, originalClipboard);
  });
});

test('macOS WebKit Paste honors native field limits and pastes a newline without submitting', async t => {
  const directory = await temp(t, 'desktop-macos-webkit-');
  const tool = join(directory, 'webkit-fixture');
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
    '-framework', 'AppKit', '-framework', 'WebKit', 'tests/desktop/macos-webkit-fixture.m', '-o', tool]);
  execFileSync(tool, { timeout: 10000 });
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

test('macOS Quit waits for clipboard restoration when the helper is stalled after staging', {
  timeout: 45000,
}, async t => {
  const tool = await compileDispatchFixture(t);
  const quitReport = join(await temp(t, 'desktop-macos-quit-'), 'result.json');
  const { desktop, management, view } = await launch(t);
  await desktop.evaluate(({ app }, { tool, quitReport }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const load = createRequire(`${app.getAppPath()}/package.json`);
    const { DesktopSession } = load('./desktop/session.js');
    const { createInterface } = process.getBuiltinModule('node:readline');
    const start = DesktopSession.prototype.start;
    DesktopSession.prototype.start = async function (plan) {
      // Exercise the packaged Quit handler with a private clipboard and a
      // controlled focus stall, without posting system-wide keyboard events.
      this.target.onLost = () => {};
      this.target.close();
      this.target.command = tool;
      const reader = createInterface({ input: this.target.connect().process.stdout });
      reader.on('line', line => {
        if (JSON.parse(line).focusReadPaused) globalThis.testFocusReadPaused = true;
      });
      await this.target.request('fixture', null, { pauseAfterStage: true, focusStallMs: 4000, quitReport });
      await this.target.request('snapshot-tray');
      await start.call(this, { ...plan, focused: true }, 'bind-tray');
      const id = this.current.id;
      void this.insert(id, 'staged during Quit').catch(() => {});
      void this.insert(id, 'queued during Quit').catch(() => {});
    };
  }, { tool, quitReport });
  await management.evaluate(async graph => {
    const entry = await window.desktop.add('Quit clipboard test', graph);
    await window.desktop.startLive(entry.id);
  }, testGraph('Display', ''));
  await eventually(() => desktop.evaluate(() => globalThis.testFocusReadPaused), 'The helper did not stall after staging');
  assert.equal((await view()).session.phase, 'running');

  await desktop.close();
  const state = JSON.parse(await readFile(quitReport, 'utf8'));
  assert.deepEqual(state.clipboard, originalClipboard);
  assert.equal(state.currentHostOnly, true);
  assert.equal(state.keyDowns, 0);
  assert.equal(state.keyUps, 0);
});

test('macOS Live Cancel clears unfinished text, keeps committed text, and ignores stale deliveries', {
  timeout: 45000,
}, async t => {
  const { desktop, management, view } = await launch(t);
  const runtime = await eventually(() => desktop.windows().find(page => page.url().endsWith('/runtime.html')),
    'The packaged runtime did not load');
  await runtime.evaluate(async () => {
    const { TextNode } = await import(new URL('../web/text-constant-node.js', location.href));
    TextNode.prototype.start = function (context) {
      globalThis.deliver = (text, provisional) => context.emitOutputs({ value: text }, { provisional });
    };
  });

  await management.evaluate(async graph => {
    const entry = await window.desktop.add('Preview cancellation', graph);
    await window.desktop.startLive(entry.id);
  }, testGraph('Display', ''));
  await management.getByRole('button', { name: 'Live', exact: true }).click();
  await eventually(async () => (await view()).session.phase === 'running', 'Live did not start');
  const display = management.locator('#displays');
  const cancel = management.getByRole('button', { name: 'Cancel', exact: true });
  const deliver = (text, provisional) => runtime.evaluate(
    ({ text, provisional }) => globalThis.deliver(text, provisional), { text, provisional });

  // Restore the committed snapshot after a newer preview.
  await deliver('東京🙂', false);
  await display.getByText('東京🙂', { exact: true }).waitFor();
  await deliver('unfinished prediction', true);
  await display.getByText('unfinished prediction', { exact: true }).waitFor();
  await cancel.click();
  assert.equal((await idle(view)).error, '');
  await display.getByText('東京🙂', { exact: true }).waitFor();
  assert.equal(await display.getByText('unfinished prediction', { exact: true }).count(), 0);

  await deliver('stale final', false);
  assert.deepEqual((await view()).items.map(({ item }) => item), ['東京🙂']);

  await management.getByRole('button', { name: 'Start', exact: true }).click();
  await eventually(async () => (await view()).session.phase === 'running', 'Live did not restart');
  await deliver('preview only', true);
  await display.getByText('preview only', { exact: true }).waitFor();
  await cancel.click();
  await idle(view);
  await display.getByText('preview only', { exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual((await view()).items.map(({ item }) => item), [[]]);
});

test('macOS package reopens an invalid Auto Save draft for repair or Undo', {
  timeout: 60000,
}, async t => {
  let app = await launch(t);
  const name = 'Recover formatter draft';
  const graph = testGraph('Display', 'hello');
  graph.nodes.push(graphNode('TextFormatter', 'format', 260, 260));
  graph.edges = [edge('literal', 'value', 'format', 'input1'), edge('format', 'text', 'out', 'input1')];
  const { id } = await app.management.evaluate(({ name, graph }) => window.desktop.add(name, graph), { name, graph });
  const saved = async () => (await app.view()).library.graphs.find(entry => entry.id === id);
  const openEditor = async () => {
    const { management } = app;
    await management.getByRole('article', { name }).getByRole('button', { name: 'Edit' }).click();
    await management.getByRole('button', { name: 'Select format', exact: true }).click();
    return management.getByRole('textbox', { name: 'format template' });
  };
  const invalid = async (control, template, expected) => {
    await control.fill(template);
    await app.management.locator('#graph-state').filter({ hasText: /^Save failed$/ }).waitFor();
    assert.match(await app.management.locator('#graph-save-error').textContent(), /99/);
    assert.deepEqual(await saved(), expected);
  };
  const relaunch = async () => {
    await app.desktop.close();
    app = await launch(t, app.profile);
  };

  const original = await saved();
  await invalid(await openEditor(), '{99}', original);
  await relaunch();
  let control = await openEditor();
  assert.equal(await control.inputValue(), '{99}');
  assert.deepEqual(await saved(), original);
  await control.fill('Fixed {1}');
  await app.management.locator('#graph-state').filter({ hasText: /^Saved$/ }).waitFor();
  const repaired = await saved();
  assert.equal(repaired.graph.nodes.find(node => node.id === 'format').settings.template, 'Fixed {1}');

  await invalid(control, 'Discard {99}', repaired);
  await relaunch();
  control = await openEditor();
  assert.equal(await control.inputValue(), 'Discard {99}');
  await app.management.locator('#graph-state').filter({ hasText: /^Save failed$/ }).waitFor();
  await relaunch();
  control = await openEditor();
  assert.equal(await control.inputValue(), 'Discard {99}');
  await app.management.getByRole('button', { name: 'Undo', exact: true }).click();
  await app.management.locator('#graph-state').filter({ hasText: /^Saved$/ }).waitFor();
  assert.deepEqual(await saved(), repaired);
  await relaunch();
  assert.equal(await (await openEditor()).inputValue(), 'Fixed {1}');
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
  if (!run) return;
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
  if (!run) return;
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
  if (!run) return;
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

test('native Safari receives ordered Unicode without submitting and refuses protected fields', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  if (!run) return;
  const app = await launch(t);
  const emit = await textProducer(app.desktop);
  await selectFocusedGraph(app, 'Safari OS target');
  const safari = await externalSafari(t, run);
  await safari.focus('notes', 5);
  run('shortcut');
  await runningWithExternalFocus(app, run, safari.pid);
  await emit(' 東京', '🙂\n ', 'か\u3099');
  const prefix = 'left| 東京🙂\n か\u3099';
  const edited = await eventually(() => {
    const current = safari.state();
    return current.values.notes === prefix + 'right' && current.caret === prefix.length && current;
  }, 'Safari did not receive the complete TEXT at the caret');
  assert.equal(edited.focus, 'notes');
  assert.equal(edited.values.field, 'left|right');
  assert.deepEqual(edited.edits.filter(([event]) => event === 'input'), Array(3).fill(['input', 'notes']));
  assert.equal(edited.submits, 0);
  run('shortcut');
  assert.equal((await idle(app.view)).error, '');

  await safari.focus('multiline', 1);
  run('shortcut');
  await runningWithExternalFocus(app, run, safari.pid);
  await emit('AB東京');
  await eventually(() => safari.state().values.multiline === 'xABy', 'Safari did not apply the native field limit');
  assert.equal(safari.state().caret, 3);
  run('shortcut');
  assert.equal((await idle(app.view)).error, '');

  await safari.focus('field', 5);
  run('shortcut');
  await runningWithExternalFocus(app, run, safari.pid);
  await emit('\n');
  run('shortcut');
  assert.equal((await idle(app.view)).error, '');
  assert.equal(safari.state().submits, 0);
  assert.equal(safari.state().values.field, 'left|right');

  const indicator = app.desktop.windows().find(page => page.url().endsWith('/indicator.html'));
  const dismissError = async () => {
    await indicator.getByRole('button', { name: 'Dismiss' }).evaluate(button => button.click());
    await eventually(async () => !(await app.view()).session.error, 'The previous error was not dismissed');
  };
  if ((await app.view()).session.error) await dismissError();
  for (const field of ['password', 'readonly']) {
    const original = await safari.focus(field, 1);
    run('shortcut');
    const session = await eventually(async () => {
      const { session } = await app.view();
      return (session.phase === 'running' || (session.phase === 'idle' && session.error)) && session;
    }, `The packaged app did not handle ${field}`);
    if (field === 'password' || session.error) {
      assert.match(session.error, field === 'password' ? /protected|Secure Keyboard Entry/ : /read-only/);
      await dismissError();
    } else {
      // Safari can expose a read-only field without an explicit read-only flag.
      // In that case its native editor is responsible for ignoring the input.
      await emit('must not change this field');
      run('shortcut');
      assert.equal((await idle(app.view)).error, '');
    }
    const after = await eventually(() => safari.state().report > original.report && safari.state(),
      'Safari did not report its state after the protected field check');
    assert.deepEqual(after.values, original.values);
    assert.deepEqual(after.edits, original.edits);
    assert.equal(after.submits, 0);
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
