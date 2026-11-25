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
  const directory = await temp(t, 'desktop-macos-fixture-');
  const tool = join(directory, 'fixture');
  execFileSync('xcrun', ['swiftc', '-O', 'tests/desktop/macos-fixture.swift', '-o', tool]);
  return (...args) => execFileSync(tool, args, { encoding: 'utf8', timeout: 25000 }).trim();
}

function testGraph(output, text) {
  const literal = graphNode('Text', 'literal', 20, 50);
  literal.settings.value = text;
  return { version: GRAPH_VERSION, nodes: [literal, graphNode(output, 'out', 280, 50)],
    edges: [edge('literal', 'value', 'out', output === 'Display' ? 'input1' : 'text')] };
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

test('native shortcut inserts once at the original caret in an independent TextEdit document', {
  skip: process.env.DESKTOP_MACOS_EDITOR !== '1', timeout: 60000,
}, async t => {
  const run = await fixture(t);
  assert.deepEqual(JSON.parse(run('permissions')), { accessibility: true, keyboard: true },
    'The macOS test driver needs normal Accessibility and keyboard event permission');
  const { desktop, management, view } = await launch(t);
  const text = ' 東京🙂\n ';
  await management.evaluate(async graph => {
    const entry = await window.desktop.add('TextEdit OS target', graph);
    await window.desktop.select(entry.id);
  }, testGraph(FOCUSED_OUTPUT, text));
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/management.html')).close();
  });
  const path = join(await temp(t, 'desktop-textedit-'), 'dictation target.txt');
  await writeFile(path, 'left|right');
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
  await eventually(() => {
    try { return JSON.parse(run('text')) === 'left|right'; }
    catch { return false; }
  }, 'Independent editor did not open the test document');
  run('caret', '5');
  run('shortcut');
  await eventually(async () => {
    const { session } = await view();
    if (session.error) throw Error(session.error);
    return session.phase === 'running';
  }, 'The shortcut did not start the packaged graph');
  await eventually(() => JSON.parse(run('text')) === `left|${text}right`, 'TextEdit did not receive the complete TEXT');
  run('shortcut');
  await eventually(async () => (await view()).session.phase === 'idle', 'The shortcut did not stop the graph');
  assert.equal(run('frontmost'), 'com.apple.TextEdit');
  assert.equal(JSON.parse(run('text')), `left|${text}right`);
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
