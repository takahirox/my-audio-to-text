import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const real = process.env.WEB_VOICE_REAL === '1';
const test = base.extend({
  voice: async ({}, use, info) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'web-voice-')), root = path.join(temporary, 'bundle');
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<title>Voice fields</title><form><input id="first" value="before after"><textarea id="second">left right</textarea><button type="submit">Send</button></form>
        <input id="password" type="password"><input id="otp" autocomplete="one-time-code"><input id="card" autocomplete="cc-number"><input id="readonly" readonly><input id="disabled" disabled>
        <div contenteditable="true" id="basic">hello world</div><iframe src="/frame"></iframe>
        <script>window.submits=0;window.edits=[];document.querySelector('form').onsubmit=e=>{e.preventDefault();submits++};document.addEventListener('input',e=>edits.push(e.target.id));document.querySelector('iframe').remove();</script>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let context;
    const pageErrors = [], remote = [];
    try {
      if (real) await cp(path.resolve('dist/chrome-extension'), root, { recursive: true });
      else {
        await cp('extension', path.join(root, 'extension'), { recursive: true });
        await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !/\/(vendor|tts-assets|correction-assets)(\/|$)/.test(source) });
        await cp('extension/manifest.json', path.join(root, 'manifest.json'));
        for (const role of ['sherpa', 'silero']) await writeFile(path.join(root, `web/${role}-worker.js`), `self.onmessage=({data})=>{
          if(data.type==='load')postMessage({type:'ready'});
          if(data.type==='vad-audio')postMessage({type:'vad',session:data.session,frames:[{audio:data.audio,speaking:data.audio.some(x=>Math.abs(x)>.001)}]});
          if(data.type==='vad-stop')postMessage({type:'vad-stopped',session:data.session});
          if(data.type==='decode'){postMessage({type:data.final?'final':'partial',text:data.final?'confirmed fixture':'pending fixture',session:data.session,id:data.id});postMessage({type:'decoded',session:data.session});}
        };`);
      }
      context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
        ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--use-fake-device-for-media-stream',
          ...(real ? [`--use-file-for-fake-audio-capture=${path.resolve('tests/fixtures/ordinary-english.wav')}%noloop`] : [])] });
      const cdp = await context.browser().newBrowserCDPSession();
      // Seed a real Chrome host grant as an installation/upgrade fixture. The
      // production optional-only manifest is restored before any feature test.
      // Native permission-bubble button automation is outside Playwright/CDP.
      const manifestPath = path.join(root, 'manifest.json'), originalManifest = await readFile(manifestPath, 'utf8');
      if (!info.title.includes('fresh install')) await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest), host_permissions: ['http://*/*', 'https://*/*'] }));
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
      await writeFile(manifestPath, originalManifest);
      await cdp.send('Extensions.loadUnpacked', { path: root });
      const url = `chrome-extension://${id}/extension/`;
      await context.addInitScript(() => {
        if (location.protocol !== 'chrome-extension:') return;
        window.voiceFinals = [];
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', ({ data }) => { if (data.type === 'final') window.voiceFinals.push({ id: data.id, text: data.text }); });
          }
        };
      });
      context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
      context.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) remote.push(request.url()); });
      const library = await context.newPage(); await library.goto(url + 'graph-library.html');
      await expect(library.locator('#graph-list button')).toHaveCount(1);
      const graphId = await library.evaluate(async () => {
        const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { graphNode, edge } = await import('./graph.js');
        const graph = { version: 15, nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')],
          edges: [edge('mic','audio','asr','audio'),edge('asr','final','field','text')] };
        const store = new GraphLibrary(localStorage), next = await store.create({ name: 'Dictation', graph }, readLibrary(localStorage).revision);
        const id = next.graphs.at(-1).id; await store.assign('webVoice', id, next.revision); return id;
      });
      await library.reload();
      const website = await context.newPage(); await website.goto(`http://127.0.0.1:${server.address().port}/`);
      await use({ context, library, website, url, cdp, id, graphId, pageErrors, remote, root });
      expect(pageErrors).toEqual([]); expect(remote).toEqual([]);
    } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); await new Promise(resolve => server.close(resolve)); }
  },
});
const widget = page => page.locator('[data-local-web-voice]');
// The closed shadow root prevents page-world code from inspecting the control.
// A real pointer click is delivered using its host's visible geometry.
async function mic(page) {
  const box = await widget(page).boundingBox(); expect(box).not.toBeNull();
  await page.mouse.click(box.x + 15, box.y + 14);
}
async function enable(t) {
  await t.library.bringToFront();
  await t.library.locator('#web-voice-enabled').check();
  await expect(t.library.locator('#web-voice-status')).toContainText('ON', { timeout: 10000 });
  await expect.poll(() => t.library.evaluate(async () => (await chrome.permissions.getAll()).origins)).toEqual(['http://*/*', 'https://*/*']);
}
async function start(t, selector = '#first', permission = 'granted') {
  await t.cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: permission, origin: t.url.replace(/\/extension\/$/, '') });
  await t.website.bringToFront(); await t.website.locator(selector).focus();
  await t.website.locator(selector).evaluate(e => {
    if (e.setSelectionRange) e.setSelectionRange(7, 7);
    else { const range = document.createRange(); range.setStart(e.firstChild, 6); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  });
  await expect(widget(t.website)).toBeVisible();
  const created = t.context.waitForEvent('page', { predicate: page => page.url().includes('web-voice-runtime.html') });
  await mic(t.website); const runtime = await created;
  return runtime;
}

test('consent stays OFF for an existing assignment; permission and UI activation, sensitive fields and OFF cleanup', async ({ voice: t }) => {
  await expect(t.library.locator('#web-voice-enabled')).not.toBeChecked();
  await t.website.locator('#first').focus(); await expect(widget(t.website)).toHaveCount(0);
  expect(await t.library.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBe(0);
  await enable(t);
  await t.website.bringToFront(); await t.website.locator('#first').focus(); await expect(widget(t.website)).toBeVisible();
  for (const selector of ['#password', '#otp', '#card', '#readonly']) { await t.website.locator(selector).focus(); await expect(widget(t.website)).toHaveCount(0); }
  const otherLibrary = await t.context.newPage(); await otherLibrary.goto(t.url + 'graph-library.html');
  await expect(otherLibrary.locator('#web-voice-enabled')).toBeChecked();
  await otherLibrary.locator('#web-voice-enabled').uncheck(); await expect(t.library.locator('#web-voice-enabled')).not.toBeChecked();
  await t.website.locator('#first').focus(); await expect(widget(t.website)).toHaveCount(0);
});

test('native input and textarea: selected caret, real microphone permission, final drain, no submit and cleanup', async ({ voice: t }, info) => {
  test.setTimeout(real ? 180000 : 45000);
  await enable(t);
  const evidence = [];
  for (const [selector, prefix, suffix] of [['#first', 'before ', 'after'], ['#second', 'left ri', 'ght']]) {
    const runtime = await start(t, selector);
    await expect(runtime.locator('#voice-state')).toHaveText('Recording', { timeout: 120000 });
    await expect(runtime.locator('#voice-error')).toBeEmpty();
    // Fake microphone device carries actual fixture speech in real mode. The
    // mock mode still uses native gUM/audio normalization and production ASR
    // Nodes/Pipeline, replacing only worker inference responses.
    await runtime.waitForTimeout(real ? 16000 : 600);
    const finals = await runtime.evaluate(() => window.voiceFinals);
    // Capture finals accepted during graceful Stop as well as during capture.
    const finalEvents = [...finals];
    runtime.on('console', message => { if (message.type() === 'debug' && message.text().startsWith('voice-test-final:')) finalEvents.push(JSON.parse(message.text().slice('voice-test-final:'.length))); });
    await runtime.evaluate(() => {
      const original = window.voiceFinals.push.bind(window.voiceFinals);
      window.voiceFinals.push = (...items) => { for (const item of items) console.debug('voice-test-final:' + JSON.stringify(item)); return original(...items); };
    });
    const closed = runtime.waitForEvent('close');
    await t.website.bringToFront(); await mic(t.website); await closed;
    const text = await t.website.locator(selector).inputValue();
    expect(text.startsWith(prefix)).toBe(true); expect(text.endsWith(suffix)).toBe(true);
    const inserted = text.slice(prefix.length, -suffix.length);
    expect(inserted.trim().length).toBeGreaterThan(0);
    if (!real) expect(inserted).toBe('confirmed fixture');
    const uniqueFinals = [...new Map(finalEvents.map(event => [event.id, event.text])).values()].filter(Boolean);
    expect(inserted).toBe(uniqueFinals.join(''));
    expect(await t.website.evaluate(() => window.submits)).toBe(0);
    const previous = text; await t.website.waitForTimeout(150); await expect(t.website.locator(selector)).toHaveValue(previous);
    evidence.push({ field: selector, inserted, finalUtterances: uniqueFinals.length, exactlyOnce: true, nativeGetUserMedia: true, drained: true });
  }
  const report = { realModel: real, fixtureSha256: real ? createHash('sha256').update(await readFile('tests/fixtures/ordinary-english.wav')).digest('hex') : null, browser: t.context.browser().version(), hostPermission: 'Chrome-native upgrade grant fixture; production manifest restored before feature tests; native prompt button not automated', microphonePermission: 'Native Browser.setPermission grant; fake microphone device', evidence, remoteRequests: t.remote.length, pageErrors: t.pageErrors };
  await writeFile(info.outputPath('voice-evidence.json'), JSON.stringify(report, null, 2) + '\n');
  if (real) await writeFile('docs/evidence/web-voice-247-real.json', JSON.stringify(report, null, 2) + '\n');
});

test('denied microphone, busy tabs, fixed target despite focus changes and OFF during capture', async ({ voice: t }) => {
  test.skip(real, 'Deterministic lifecycle coverage runs with controlled inference.');
  await enable(t);
  let runtime = await start(t, '#first', 'denied');
  await expect.poll(() => runtime.isClosed()).toBe(true);
  await expect(widget(t.website)).toHaveAttribute('data-local-web-voice', '');
  runtime = await start(t);
  await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  const other = await t.context.newPage(); await other.goto(t.website.url() + '?other'); await other.locator('#first').focus(); await expect(widget(other)).toBeVisible();
  await mic(other);
  expect(t.context.pages().filter(p => p.url().includes('web-voice-runtime.html'))).toHaveLength(1);
  await t.website.locator('#second').focus();
  await runtime.waitForTimeout(500);
  const close = runtime.waitForEvent('close'); await runtime.locator('#voice-stop').click(); await close;
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter'); await expect(t.website.locator('#second')).toHaveValue('left right');
  runtime = await start(t);
  await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  const closed = runtime.waitForEvent('close'); await t.library.locator('#web-voice-enabled').uncheck(); await closed;
  await expect(widget(t.website)).toHaveCount(0); await expect(widget(other)).toHaveCount(0);
});

test('completed sessions refresh the idle target and remove the mic when focus is not editable', async ({ voice: t }) => {
  test.skip(real, 'Repeated-session target binding uses controlled inference.');
  await enable(t);
  let runtime = await start(t);
  await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await t.website.bringToFront();
  await t.website.locator('#second').focus();
  await t.website.locator('#second').evaluate(e => e.setSelectionRange(5, 5));
  await runtime.waitForTimeout(600);
  let closed = runtime.waitForEvent('close'); await mic(t.website); await closed;
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter');
  await expect(t.website.locator('#second')).toHaveValue('left right');
  await expect(t.website.locator('#second')).toBeFocused();
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'idle');

  // Click the remaining mic directly: refocusing through start() would mask a
  // stale target left over from the previous session.
  const created = t.context.waitForEvent('page', { predicate: page => page.url().includes('web-voice-runtime.html') });
  await mic(t.website); runtime = await created;
  await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await t.website.bringToFront();
  await t.website.locator('button[type="submit"]').focus();
  await runtime.waitForTimeout(600);
  closed = runtime.waitForEvent('close'); await mic(t.website); await closed;
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter');
  await expect(t.website.locator('#second')).toHaveValue('left confirmed fixtureright');
  await expect(widget(t.website)).toHaveCount(0);
  expect(await t.website.evaluate(() => window.submits)).toBe(0);
});

test('fresh install has no site permission or injected scripts; assignment is not consent and denial stays OFF', async ({ voice: t }) => {
  test.skip(real, 'Permission boundary does not require real inference.');
  expect(await t.library.evaluate(async () => (await chrome.permissions.getAll()).origins)).toEqual([]);
  await expect(t.library.locator('#web-voice-enabled')).not.toBeChecked();
  await t.website.locator('#first').focus(); await expect(widget(t.website)).toHaveCount(0);
  expect(await t.library.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBe(0);
  // Only the permission decision is controlled here. No site authorization or
  // script injection is substituted; Chrome must still report no hosts.
  await t.library.evaluate(() => { chrome.permissions.request = async () => false; });
  await t.library.locator('#web-voice-enabled').click();
  await expect(t.library.locator('#web-voice-status')).toContainText('Website access denied');
  await expect(t.library.locator('#web-voice-enabled')).not.toBeChecked();
  expect(await t.library.evaluate(async () => (await chrome.permissions.getAll()).origins)).toEqual([]);
  await t.website.reload(); await t.website.locator('#first').focus(); await expect(widget(t.website)).toHaveCount(0);
});

test('snapshotted graph, wrong sender rejection, field removal and navigation abort without retargeting', async ({ voice: t }) => {
  test.skip(real, 'Deterministic message and lifecycle coverage.');
  await enable(t);
  let runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  // Saving an incompatible next graph does not mutate the active snapshot.
  await t.library.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { defaultGraph } = await import('./graph.js');
    const entry = readLibrary(localStorage).graphs.find(e => e.id === id);
    await new GraphLibrary(localStorage).save(id, entry.revision, defaultGraph());
  }, t.graphId);
  expect(await t.library.evaluate(async () => {
    const tab = (await chrome.tabs.query({ url: 'http://127.0.0.1/*' }))[0];
    const [document] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => true });
    const { PageConnection } = await import('./page-target.js');
    const connection = new PageConnection({ tabId: tab.id, documentId: document.documentId, portName: 'web-voice-output', capability: crypto.randomUUID() });
    try { await connection.request('append', { sequence: 0, text: 'spoofed' }); return false; } catch { return true; } finally { connection.close(); }
  })).toBe(true);
  await t.website.locator('#second').focus();
  await runtime.waitForTimeout(600);
  let closed = runtime.waitForEvent('close'); await runtime.locator('#voice-stop').click(); await closed;
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter'); await expect(t.website.locator('#second')).toHaveValue('left right');
  // The next session refuses the edited graph instead of using Live.
  runtime = await start(t); await expect.poll(() => runtime.isClosed()).toBe(true);
  await expect(t.website.locator('#second')).toHaveValue('left right');
  await t.library.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { graphNode, edge } = await import('./graph.js');
    const entry = readLibrary(localStorage).graphs.find(e => e.id === id);
    await new GraphLibrary(localStorage).save(id, entry.revision, { version: 15,
      nodes: [graphNode('MicrophoneAudio','mic'),graphNode('SpeechToTextReazonSpeech','asr'),graphNode('FocusedInputTextOutputNode','field')],
      edges: [edge('mic','audio','asr','audio'),edge('asr','final','field','text')] });
  }, t.graphId);
  runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  closed = runtime.waitForEvent('close'); await t.website.locator('#first').evaluate(e => e.remove()); await closed;
  await expect(widget(t.website)).toBeVisible();
  await expect(widget(t.website)).toHaveAttribute('title', /removed|supported/);
  await expect(t.website.locator('#second')).toHaveValue('left right');
  await t.website.reload(); runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  closed = runtime.waitForEvent('close'); await t.website.reload(); await closed;
  await expect(t.website.locator('#first')).toHaveValue('before after');
});

test('Live preparation owns resources; Web voice reports busy without stealing its Workers', async ({ voice: t }) => {
  test.skip(real, 'Resource admission does not require another model initialization.');
  await enable(t);
  const live = await t.context.newPage(); await live.goto(t.url + 'recorder.html');
  await expect(live.locator('#model-status')).toHaveText('Ready');
  const runtime = await start(t); await expect.poll(() => runtime.isClosed()).toBe(true);
  await expect(live.locator('#model-status')).toHaveText('Ready');
  await expect(live.locator('#errors')).toBeEmpty();
  await expect(t.website.locator('#first')).toHaveValue('before after');
  await live.close();
  const retry = await start(t); await expect(retry.locator('#voice-state')).toHaveText('Recording');
  const closed = retry.waitForEvent('close'); await retry.locator('#voice-stop').click(); await closed;
});

test('permission removal removes owners and suppresses later writes', async ({ voice: t }) => {
  test.skip(real, 'Deterministic teardown coverage.');
  await enable(t);
  let runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  const closed = runtime.waitForEvent('close');
  await t.library.evaluate(() => chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] })); await closed;
  await expect(t.library.locator('#web-voice-enabled')).not.toBeChecked();
  await expect(widget(t.website)).toHaveCount(0); await expect(t.website.locator('#first')).toHaveValue('before after');
});

test('cancel during model preparation aborts safely', async ({ voice: t }) => {
  test.skip(real, 'Controlled loading failure and delayed readiness.');
  await enable(t);
  await t.context.addInitScript(() => {
    if (!location.href.includes('web-voice-runtime.html')) return;
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker { postMessage(data, ...rest) { if (data.type !== 'load') super.postMessage(data, ...rest); } };
  });
  const runtime = await start(t);
  await expect(runtime.locator('#voice-state')).toHaveText('Preparing…');
  await t.website.bringToFront();
  const closed = runtime.waitForEvent('close'); await mic(t.website); await closed;
  await expect(t.website.locator('#first')).toHaveValue('before after');
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
});

test('basic contenteditable selection, continued manual editing and device end preserve unrelated text', async ({ voice: t }) => {
  test.skip(real, 'Representative basic editable and lifecycle coverage uses controlled inference.');
  await enable(t);
  let runtime = await start(t, '#basic'); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await runtime.waitForTimeout(600);
  let closed = runtime.waitForEvent('close'); await runtime.locator('#voice-stop').click(); await closed;
  await expect(t.website.locator('#basic')).toHaveText('hello confirmed fixtureworld');
  await t.website.locator('#basic').click(); await t.website.keyboard.press('End'); await t.website.keyboard.type(' edited');
  await expect(t.website.locator('#basic')).toContainText(' edited');
  await t.context.addInitScript(() => {
    if (!location.href.includes('web-voice-runtime.html')) return;
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await original(options); window.voiceStream = stream; return stream; };
  });
  runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  closed = runtime.waitForEvent('close');
  await runtime.evaluate(() => window.voiceStream.getAudioTracks()[0].dispatchEvent(new Event('ended'))); await closed;
  await expect(t.website.locator('#first')).toHaveValue('before after');
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
});

test('missing verified translation cache reports recovery before microphone access, without network downloads', async ({ voice: t }) => {
  test.skip(real, 'Missing-assets boundary requires an empty cache, not inference.');
  await t.library.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { graphNode, edge } = await import('./graph.js');
    const entry = readLibrary(localStorage).graphs.find(e => e.id === id), graph = entry.graph;
    graph.nodes.push(graphNode('OpusMtJaEn', 'translate'));
    graph.edges[1] = edge('asr','final','translate','text'); graph.edges.push(edge('translate','text','field','text'));
    await new GraphLibrary(localStorage).save(id, entry.revision, graph);
  }, t.graphId);
  await t.library.reload(); await enable(t);
  const runtime = await start(t, '#first', 'denied'); await expect.poll(() => runtime.isClosed()).toBe(true);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
  await expect(widget(t.website)).toHaveAttribute('title', /cache|Models|files/i);
  await expect(t.website.locator('#first')).toHaveValue('before after');
});

test('replayed output messages insert once; a running Worker failure aborts the owner', async ({ voice: t }) => {
  test.skip(real, 'Controlled replay/crash validation.');
  await enable(t);
  await t.context.addInitScript(() => {
    if (!location.href.includes('web-voice-runtime.html')) return;
    const connect = chrome.tabs.connect.bind(chrome.tabs), NativeWorker = Worker;
    window.voiceWorkers = [];
    window.Worker = class extends NativeWorker { constructor(...args) { super(...args); window.voiceWorkers.push(this); } };
    chrome.tabs.connect = (...args) => {
      const port = connect(...args), send = port.postMessage.bind(port);
      port.postMessage = message => { send(message); if (message.action === 'append') send(message); };
      return port;
    };
  });
  let runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await runtime.waitForTimeout(600);
  let closed = runtime.waitForEvent('close'); await runtime.locator('#voice-stop').click(); await closed;
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter');
  runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  closed = runtime.waitForEvent('close');
  await runtime.evaluate(() => window.voiceWorkers[0].dispatchEvent(new ErrorEvent('error', { message: 'Controlled Worker failure' }))); await closed;
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter');
});

test('extension reload cancels capture and reinstalls only an idle opt-in widget', async ({ voice: t }) => {
  test.skip(real, 'Native extension lifecycle needs no real inference.');
  await enable(t);
  const runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await t.cdp.send('Extensions.loadUnpacked', { path: t.root });
  await expect.poll(() => runtime.isClosed()).toBe(true);
  await t.website.bringToFront(); await t.website.locator('#first').focus();
  await expect(widget(t.website)).toHaveCount(1);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'idle');
  await expect(t.website.locator('#first')).toHaveValue('before after');
});
