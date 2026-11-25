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
import { FocusedTarget } from '../../desktop/focused-target.js';
import { defaultDesktopGraph, FOCUSED_OUTPUT } from '../../desktop/graph.js';
import { DesktopSession } from '../../desktop/session.js';
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

async function compileDispatchFixture(t) {
  const directory = await temp(t, 'desktop-macos-dispatch-');
  const tool = join(directory, 'dispatch-fixture');
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon',
    'tests/desktop/macos-dispatch-fixture.m', '-o', tool]);
  return tool;
}

test('macOS dispatch rechecks the bound window and field after reading the selection', async t => {
  const tool = await compileDispatchFixture(t);
  const results = execFileSync(tool, { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(JSON.parse);
  assert.deepEqual(results, [{ request: 1, error: 'The authorized window or text field changed or lost focus.' }, { request: 2 }]);
});

test('macOS queue keeps Safari edits bound to the authorized field, including delayed consumption', async t => {
  const tool = await compileDispatchFixture(t);
  const target = new FocusedTarget(tool, ['browser'], {
    onInvalid: (id, error) => { void controller.cancel(error, id); },
    onLost: () => {},
  });
  const controller = new DesktopSession({ target, run: async () => {}, onChange: () => {} });
  const lines = createInterface({ input: target.connect().process.stdout });
  t.after(() => {
    lines.close();
    target.close();
  });
  let state;
  let waiting;
  lines.on('line', line => {
    const message = JSON.parse(line);
    state = message.fixture ?? state;
    waiting = message.waiting ?? waiting;
  });
  const configure = async (options = {}) => {
    state = undefined;
    await target.request('fixture', null, options);
    return state;
  };
  const plan = { focused: true, microphone: false, displays: [], graph: {} };
  const start = async () => {
    await target.request('snapshot-tray');
    await controller.start(plan, 'bind-tray');
    return controller.current?.id;
  };
  const commits = [];
  const expectDispatches = async () => assert.deepEqual((await configure()).dispatches, commits);

  for (const options of [{ secure: true }, { readOnly: true }, { denyAccessibility: true },
    { missingOperation: true }, { foreignRange: true }, { chrome: true }]) {
    await configure(options);
    assert.equal(await start(), undefined);
    assert.match(controller.state.error, /cannot be safely edited|Accessibility/);
    assert.deepEqual((await configure(options)).dispatches, []);
  }

  await configure({ singleLine: true });
  let id = await start();
  assert.ok(id);
  await assert.rejects(controller.insert(id, '\n'), /can treat a lone line break as Submit/);
  await controller.cancel();
  await expectDispatches();

  id = await start();
  assert.ok(id);
  const chunks = [' 東京', '🙂\n ', 'か\u3099'];
  const pending = chunks.map(text => controller.insert(id, text));
  await controller.stop();
  await Promise.all(pending);
  commits.push(...chunks);
  let observed = await configure();
  assert.deepEqual(observed.dispatches, commits);
  let prefix = 'left|' + chunks.join('');
  assert.equal(observed.text, prefix + 'right');

  await configure({ editLimit: 1 });
  id = await start();
  await controller.insert(id, 'A東京🙂\n');
  await controller.stop();
  commits.push('A東京🙂\n');
  prefix += 'A';
  observed = await configure();
  assert.deepEqual(observed.dispatches, commits);
  assert.equal(observed.text, prefix + 'right');

  // A caret-only change occurs while consumption is delayed. The first
  // request must remain pending and the second must not be dispatched.
  await configure({ moveCaretBeforeConsumption: true });
  id = await start();
  const delayed = controller.insert(id, ' delayed');
  const next = controller.insert(id, ' then next');
  await eventually(async () => {
    const snapshot = await configure({ moveCaretBeforeConsumption: true });
    if (snapshot.consumed || snapshot.dispatches.length === commits.length) return false;
    assert.deepEqual(snapshot.dispatches, [...commits, ' delayed']);
    assert.equal(snapshot.text, prefix + 'right');
    return true;
  }, 'Did not observe the pending write after a caret-only change');
  await controller.stop();
  await Promise.all([delayed, next]);
  commits.push(' delayed', ' then next');
  prefix += ' delayed then next';
  observed = await configure();
  assert.deepEqual(observed.dispatches, commits);
  assert.equal(observed.text, prefix + 'right');

  // An acknowledged request that produced no edit is ambiguous. Stop
  // without retry or another dispatch.
  await configure({ editLimit: 0 });
  id = await start();
  await Promise.all([
    assert.rejects(controller.insert(id, 'a rejected edit'), /did not confirm/),
    assert.rejects(controller.insert(id, 'must stay queued'), /no longer authorized/),
  ]);
  commits.push('a rejected edit');
  await controller.cancel();
  await expectDispatches();

  await configure({ held: true });
  id = await start();
  const canceled = assert.rejects(controller.insert(id, 'discard while held'), /changed or lost focus/);
  await eventually(() => waiting, 'The native adapter did not hold the pending edit');
  await controller.cancel();
  await canceled;
  await assert.rejects(controller.insert(id, 'late callback'), /no longer authorized/);
  await expectDispatches();

  await configure({ held: true });
  id = await start();
  waiting = false;
  const madeReadOnly = assert.rejects(controller.insert(id, 'became read only'), /cannot be safely edited/);
  await eventually(() => waiting, 'The native adapter did not hold the pending edit');
  await configure({ readOnly: true });
  await madeReadOnly;
  await controller.cancel();
  await expectDispatches();

  id = await start();
  await configure({ stale: true });
  await assert.rejects(controller.insert(id, 'stale focus'), /changed or lost focus/);
  await controller.cancel();
  observed = await configure({ restoreFocus: true });
  assert.deepEqual(observed.dispatches, commits);
  assert.equal(observed.text, prefix + 'right');
  assert.equal(observed.other, 'other');

  id = await start();
  await configure({ focusBeforeConsumption: true });
  await Promise.all([
    assert.rejects(controller.insert(id, ' original only'), /changed or lost focus/),
    assert.rejects(controller.insert(id, 'must never dispatch'), /no longer authorized/),
  ]);
  await controller.cancel();
  commits.push(' original only');
  observed = await eventually(async () => {
    const snapshot = await configure();
    return snapshot.consumed && snapshot;
  }, 'The original field did not consume the addressed edit');
  assert.equal(observed.focused, 1);
  assert.equal(observed.other, 'other');
  assert.equal(observed.text, prefix + ' original onlyright');
  assert.deepEqual(observed.dispatches, commits);
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

test('native shortcut inserts rapid Unicode commits at the caret in independent Safari', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  if (!run) return;
  const app = await launch(t);
  const emit = await textProducer(app.desktop);
  await selectFocusedGraph(app, 'Safari OS target');
  const safari = await externalSafari(t, run);
  const before = await safari.focus('notes', 5);
  const commits = [' 東京', '🙂\n ', 'か\u3099'];
  const prefix = 'left|' + commits.join('');
  const expected = { ...before.values, notes: prefix + 'right' };

  run('shortcut');
  await runningWithExternalFocus(app, run, safari.pid);
  await emit(...commits);
  await eventually(() => safari.state().values.notes === expected.notes,
    'Safari did not receive the complete committed TEXT in order');
  const inserted = safari.state();
  assert.deepEqual(inserted.values, expected);
  assert.equal(inserted.focus, 'notes');
  assert.equal(inserted.caret, prefix.length);
  assert.equal(inserted.active, true);
  assert.equal(inserted.submits, 0);
  run('shortcut');
  assert.equal((await idle(app.view)).error, '');
  assert.equal(Number(run('front-pid')), safari.pid);

  run('shortcut');
  await runningWithExternalFocus(app, run, safari.pid);
  run('shortcut-down');
  try {
    await emit('must never reach the newly focused field🙂');
    await safari.focus('field', 5);
    assert.match((await idle(app.view)).error, /changed or lost focus/);
  } finally { run('shortcut-up'); }
  const released = safari.state().report;
  await eventually(() => safari.state().report > released, 'Safari stopped reporting state after shortcut release');
  assert.deepEqual(safari.state().values, expected);
  assert.equal(safari.state().submits, 0);
});

test('macOS rejects protected and read-only controls in independent Safari before editing', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  if (!run) return;
  const app = await launch(t);
  await selectFocusedGraph(app, 'Browser safety target', ' 東京🙂\n ');
  const indicator = app.desktop.windows().find(page => page.url().endsWith('/indicator.html'));
  const safari = await externalSafari(t, run);
  for (const field of ['password', 'readonly']) {
    const { report: _report, ...original } = await safari.focus(field, 1);
    run('shortcut');
    await eventually(async () => {
      const { session } = await app.view();
      if (session.phase !== 'idle' || !session.error) return false;
      assert.match(session.error, /cannot be safely edited/i);
      return true;
    }, `The packaged app did not refuse ${field}`);
    const report = safari.state().report;
    const after = await eventually(() => {
      const current = safari.state();
      if (current.report <= report) return false;
      const { report: _, ...snapshot } = current;
      return snapshot;
    }, 'Safari did not report its state after the refusal');
    assert.deepEqual(after, original);
    assert.deepEqual(original.edits, []);
    assert.equal(original.submits, 0);
    await indicator.getByRole('button', { name: 'Dismiss' }).evaluate(button => button.click());
    await eventually(async () => !(await app.view()).session.error, 'The previous refusal was not dismissed');
  }
});

test('macOS lets independent Safari enforce existing and late length limits during native text entry', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 90000,
}, async t => {
  const run = await inputFixture(t);
  if (!run) return;
  const app = await launch(t);
  const emit = await textProducer(app.desktop);
  await selectFocusedGraph(app, 'Late browser length constraint');
  const safari = await externalSafari(t, run);
  for (const [field, caret, late, expected] of [
    ['multiline', 2, false, 'xyA東'],
    ['notes', 5, true, 'left|Aright'],
  ]) {
    const before = await safari.focus(field, caret, late);
    if (late) assert.equal(before.notesMaxLength, -1);
    run('shortcut');
    await runningWithExternalFocus(app, run, safari.pid);
    await emit('A東京🙂\n');
    await eventually(() => safari.state().values[field] === expected, 'Safari did not apply its normal length limit');
    run('shortcut');
    assert.equal((await idle(app.view)).error, '');
    const report = safari.state().report;
    const after = await eventually(() => {
      const current = safari.state();
      return current.report > report && current;
    }, 'Safari did not report its state after Stop');
    assert.deepEqual(after.values, { ...before.values, [field]: expected });
    assert.deepEqual(after.edits.slice(before.edits.length), [['beforeinput', field], ['input', field]]);
    if (!late) assert.equal(after.caret, expected.length);
    assert.equal(after.focus, field);
    assert.equal(after.active, true);
    assert.equal(Number(run('front-pid')), safari.pid);
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
