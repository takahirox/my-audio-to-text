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
        ignoreDefaultArgs: ['--disable-extensions', ...(info.title.includes('back-forward cache') ? ['--disable-back-forward-cache'] : [])], args: ['--enable-unsafe-extension-debugging', '--use-fake-device-for-media-stream',
          ...(real ? [`--use-file-for-fake-audio-capture=${path.resolve('tests/fixtures/ordinary-english.wav')}${info.title.includes('overlap') ? '' : '%noloop'}`] : [])] });
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
        window.voiceResources = { workers: [], streams: [] };
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async options => {
          const stream = await getUserMedia(options); window.voiceResources.streams.push(stream); return stream;
        };
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args);
            this.released = false; window.voiceResources.workers.push(this);
            this.addEventListener('message', ({ data }) => { if (data.type === 'final') window.voiceFinals.push({ id: data.id, text: data.text }); });
          }
          terminate() { this.released = true; super.terminate(); }
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
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
// DevTools can inspect closed Shadow DOM without adding page-world access or
// production-only test hooks. Activation still uses real pointer/key events.
async function controlUI(t, focus = false) {
  await expect(widget(t.website)).toBeVisible();
  const cdp = await t.context.newCDPSession(t.website);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = node => node.attributes?.includes('data-local-web-voice') ? node :
      [...node.children || [], ...node.shadowRoots || []].map(find).find(Boolean);
    const host = find(root); expect(host?.shadowRoots).toHaveLength(1);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: host.shadowRoots[0].backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, arguments:[{ value:focus }],
      functionDeclaration: `function(focus) {
        const button = this.querySelector('button'), svg = button.querySelector('svg'), status = this.querySelector('span');
        if (focus) button.focus();
        const style = getComputedStyle(button), motion = getComputedStyle(svg);
        const rect = element => { const r = element.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
        return { icon:svg.dataset.icon, path:svg.firstChild.getAttribute('d'), viewBox:svg.getAttribute('viewBox'),
          ariaHidden:svg.getAttribute('aria-hidden'), focusable:svg.getAttribute('focusable'), text:button.textContent,
          label:button.getAttribute('aria-label'), title:button.title, disabled:button.disabled, status:status.textContent,
          button:rect(button), svg:rect(svg), bubble:rect(status), theme:this.host.dataset.theme,
          circle:style.borderRadius, display:style.display, align:style.alignItems, justify:style.justifyContent,
          padding:style.padding, boxSizing:style.boxSizing, appearance:style.appearance, lineHeight:style.lineHeight,
          color:style.color, background:style.backgroundColor, fill:motion.fill, animation:motion.animationName,
          outline:style.outlineStyle, focused:this.activeElement === button };
      }` });
    return result.value;
  } finally { await cdp.detach(); }
}
function expectIcon(ui, icon) {
  expect(ui.icon).toBe(icon); expect(ui.viewBox).toBe('0 -960 960 960');
  expect(ui.ariaHidden).toBe('true'); expect(ui.focusable).toBe('false'); expect(ui.text).toBe('');
  expect(ui.button.width).toBe(36); expect(ui.button.height).toBe(36);
  // A rotating SVG's bounding rectangle grows mid-animation; its CSS size is
  // asserted at rest/reduced motion, along with the actual centered geometry.
  if (ui.animation === 'none') { expect(ui.svg.width).toBe(20); expect(ui.svg.height).toBe(20); }
  expect(ui.svg.x + ui.svg.width / 2).toBeCloseTo(ui.button.x + 18, 1);
  expect(ui.svg.y + ui.svg.height / 2).toBeCloseTo(ui.button.y + 18, 1);
  expect(ui.fill).toBe(ui.color);
}
function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function enable(t) {
  await t.library.bringToFront();
  await t.library.locator('#web-voice-enabled').click();
  await expect(t.library.getByRole('dialog', { name: 'Show microphone buttons on web pages?' })).toBeVisible();
  await t.library.getByRole('button', { name: 'Continue to website permission' }).click();
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
  await expect(t.library.locator('#web-graph')).toHaveValue(t.graphId);
  expect(await t.library.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-library-v1')).assignments.webVoice)).toBe(t.graphId);
  await t.website.locator('#first').focus(); await expect(widget(t.website)).toHaveCount(0);
  await otherLibrary.locator('#web-graph').selectOption('');
  await expect(t.library.locator('#web-graph')).toHaveValue('');
  await t.library.locator('#web-voice-enabled').click();
  await expect(t.library.locator('#voice-consent')).not.toBeVisible();
  await expect(t.library.locator('#web-voice-enabled')).not.toBeChecked();
  await otherLibrary.locator('#web-graph').selectOption(t.graphId);
  await expect(t.library.locator('#web-graph')).toHaveValue(t.graphId);
  await expect(t.library.locator('#web-voice-enabled')).not.toBeChecked();
  await expect(t.library.locator('#voice-consent')).not.toBeVisible();
  await enable(t);
  await t.library.locator('#web-voice-enabled').uncheck();
  await expect(t.library.locator('#web-graph')).toHaveValue(t.graphId);
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

test('denied microphone, concurrent tabs, fixed target despite focus changes and OFF during capture', async ({ voice: t }) => {
  test.skip(real, 'Deterministic lifecycle coverage runs with controlled inference.');
  await enable(t);
  let runtime = await start(t, '#first', 'denied');
  await expect.poll(() => runtime.isClosed()).toBe(true);
  await expect(widget(t.website)).toHaveAttribute('data-local-web-voice', '');
  runtime = await start(t);
  await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  const other = await t.context.newPage(); await other.goto(t.website.url() + '?other'); await other.locator('#first').focus(); await expect(widget(other)).toBeVisible();
  const otherRuntime = await start({ ...t, website: other });
  await expect(otherRuntime.locator('#voice-state')).toHaveText('Recording');
  expect(t.context.pages().filter(p => p.url().includes('web-voice-runtime.html'))).toHaveLength(2);
  await t.website.locator('#second').focus();
  await runtime.waitForTimeout(500);
  const close = runtime.waitForEvent('close'); await runtime.locator('#voice-stop').click(); await close;
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter'); await expect(t.website.locator('#second')).toHaveValue('left right');
  await expect(otherRuntime.locator('#voice-state')).toHaveText('Recording');
  await expect(other.locator('#first')).toHaveValue('before after');
  runtime = await start(t);
  await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  const closed = runtime.waitForEvent('close'); await t.library.locator('#web-voice-enabled').uncheck(); await closed;
  await expect.poll(() => otherRuntime.isClosed()).toBe(true);
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
  await t.library.evaluate(() => {
    window.permissionCalls = [];
    chrome.permissions.request = async request => { permissionCalls.push({ request, gesture: navigator.userActivation.isActive }); return false; };
  });
  await t.library.locator('#web-voice-enabled').click();
  await expect(t.library.locator('#voice-consent')).toBeVisible();
  await expect(t.library.locator('#consent-description')).toContainText('all HTTP and HTTPS websites');
  expect(await t.library.evaluate(() => permissionCalls)).toEqual([]);
  await t.library.setViewportSize({ width: 390, height: 844 });
  expect(await t.library.locator('#voice-consent').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await t.library.screenshot({ path: 'docs/evidence/library-253-consent-390.png', fullPage: true });
  await t.library.locator('#cancel-voice').click();
  await expect(t.library.locator('#web-voice-enabled')).not.toBeChecked();
  await expect(t.library.locator('#web-voice-enabled')).toBeFocused();
  await t.library.locator('#web-voice-enabled').click(); await t.library.keyboard.press('Escape');
  await expect(t.library.locator('#voice-consent')).not.toBeVisible();
  expect(await t.library.evaluate(() => permissionCalls)).toEqual([]);
  await t.library.locator('#web-voice-enabled').click();
  await expect(t.library.locator('#voice-consent')).toBeVisible();
  await t.library.locator('#confirm-voice').click();
  await expect(t.library.locator('#web-voice-status')).toContainText('Website access denied');
  expect(await t.library.evaluate(() => permissionCalls)).toEqual([{ request: { origins: ['http://*/*', 'https://*/*'] }, gesture: true }]);
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

async function collectFinals(runtime) {
  const events = [];
  runtime.on('console', message => {
    if (message.type() === 'debug' && message.text().startsWith('voice-test-final:')) events.push(JSON.parse(message.text().slice('voice-test-final:'.length)));
  });
  const initial = await runtime.evaluate(() => {
    // Snapshot and subscribe atomically so a final between Playwright calls
    // cannot disappear from the exactly-once output comparison.
    const initial = [...voiceFinals], original = voiceFinals.push.bind(voiceFinals);
    voiceFinals.push = (...items) => { for (const item of items) console.debug('voice-test-final:' + JSON.stringify(item)); return original(...items); };
    return initial;
  });
  events.unshift(...initial);
  return events;
}
async function assignLiveMicrophone(t) {
  await t.library.evaluate(async () => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { graphNode, edge, GRAPH_VERSION } = await import('./graph.js');
    const graph = { version: GRAPH_VERSION, nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('Display', 'display')],
      edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'display', 'input1')] };
    const store = new GraphLibrary(localStorage), next = await store.create({ name: 'Independent Live', graph }, readLibrary(localStorage).revision);
    await store.assign('live', next.graphs.at(-1).id, next.revision);
  });
}
async function openLive(t) {
  const live = await t.context.newPage(); await live.goto(t.url + 'recorder.html');
  await expect(live.locator('#model-status')).toHaveText('Ready');
  return live;
}
async function expectLiveRecording(live) {
  await expect(live.locator('#session-state')).toHaveText('Recording');
  await expect(live.locator('#errors')).toBeEmpty();
  expect(await live.evaluate(() => ({ workers: voiceResources.workers.filter(w => !w.released).length,
    tracks: voiceResources.streams.flatMap(s => s.getTracks()).filter(t => t.readyState === 'live').length }))).toEqual({ workers: 2, tracks: 1 });
}

test('Live and Web overlap Ready, recording, Stop, restart, multiple Live windows, OFF and close', async ({ voice: t }, info) => {
  if (real) test.setTimeout(180000);
  await enable(t); await assignLiveMicrophone(t);
  const live = await openLive(t);
  // Prepared models remain warm while Web starts its own workers and stream.
  let runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  const webFinals = await collectFinals(runtime);
  await expect(live.locator('#model-status')).toHaveText('Ready');
  expect(await live.evaluate(() => voiceResources.workers.every(w => !w.released) && !voiceResources.streams.length)).toBe(true);
  await live.locator('#start').click(); await expectLiveRecording(live);
  const liveFinals = await collectFinals(live);
  // A second Live opens, prepares and starts while both existing owners run.
  const second = await openLive(t); await second.locator('#start').click(); await expectLiveRecording(second);
  await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await expect.poll(() => runtime.evaluate(() => voiceFinals.length), { timeout: 30000 }).toBeGreaterThan(0);
  let closed = runtime.waitForEvent('close'); await runtime.locator('#voice-stop').click(); await closed;
  await expectLiveRecording(live); await expectLiveRecording(second);
  const inserted = [...new Map(webFinals.map(event => [event.id, event.text])).values()].filter(Boolean).join('');
  expect(inserted.trim().length).toBeGreaterThan(0);
  await expect(t.website.locator('#first')).toHaveValue('before ' + inserted + 'after');
  // Starting Web while Live records must also succeed. Stop/restart one Live
  // without reloading, terminating or recapturing anything in the other owners.
  runtime = await start(t, '#second'); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await expect.poll(() => live.evaluate(() => voiceFinals.length), { timeout: 30000 }).toBeGreaterThan(0);
  await live.locator('#stop').click(); await expect(live.locator('#model-status')).toHaveText('Ready');
  const liveDisplayed = liveFinals.map(event => event.text).filter(text => text.trim()).at(-1);
  expect(liveDisplayed).toBeTruthy();
  await expect(live.locator('[data-display="display"] .display-content')).toHaveText(liveDisplayed);
  await expect(runtime.locator('#voice-state')).toHaveText('Recording'); await expectLiveRecording(second);
  await live.locator('#start').click(); await expectLiveRecording(live);
  await second.close(); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  closed = runtime.waitForEvent('close'); await t.library.locator('#web-voice-enabled').uncheck(); await closed;
  await expectLiveRecording(live);
  await enable(t); runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await live.close(); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  expect(await runtime.evaluate(() => voiceResources.workers.every(w => !w.released) && voiceResources.streams[0].active)).toBe(true);
  closed = runtime.waitForEvent('close'); await runtime.locator('#voice-stop').click(); await closed;
  expect(await t.website.evaluate(() => window.submits)).toBe(0);
  const report = { realModel: real, browser: t.context.browser().version(), peakConcurrentSessions: 3,
    fixtureSha256: real ? createHash('sha256').update(await readFile('tests/fixtures/ordinary-english.wav')).digest('hex') : null,
    webInserted: inserted, webFinalsExactlyOnce: true, liveDisplayed, liveOutputMatchesFinal: true,
    independentReadyStartStopRestartClose: true, webOffPreservesLive: true,
    microphone: 'Chrome fake device; native getUserMedia and Browser.setPermission grant',
    remoteRequests: t.remote.length, pageErrors: t.pageErrors };
  await writeFile(info.outputPath('overlap-evidence.json'), JSON.stringify(report, null, 2) + '\n');
  if (real) {
    report.model = 'ReazonSpeech ja-en + Silero VAD, WASM CPU';
    report.assetManifest = JSON.parse(await readFile(path.join(t.root, 'web/vendor/manifest.json'), 'utf8'));
    report.sourceSha256 = {};
    for (const name of ['extension/session.js', 'extension/recorder.js', 'extension/graph-runtime.js', 'extension/web-voice-runtime.js', 'extension/web-voice-background.js', 'web/local-asr-core.js', 'web/transcription-nodes.js']) {
      const bytes = await readFile(name);
      expect((await readFile(path.join(t.root, name))).equals(bytes), `Rebuild changed source: ${name}`).toBe(true);
      report.sourceSha256[name] = createHash('sha256').update(bytes).digest('hex');
    }
    await writeFile('docs/evidence/runtime-concurrency-256-real.json', JSON.stringify(report, null, 2) + '\n');
  }
});

test('Web worker failure, navigation, device end and canceled preparation leave Live and a second tab running', async ({ voice: t }) => {
  test.skip(real, 'Controlled failure and pending initialization.');
  await enable(t); await assignLiveMicrophone(t);
  const peer = await start(t); await expect(peer.locator('#voice-state')).toHaveText('Recording');
  const live = await openLive(t); await live.locator('#start').click(); await expectLiveRecording(live);
  const other = await t.context.newPage(); await other.goto(t.website.url() + '?other');
  let affected = await start({ ...t, website: other }); await expect(affected.locator('#voice-state')).toHaveText('Recording');
  let closed = affected.waitForEvent('close');
  await affected.evaluate(() => voiceResources.workers[0].dispatchEvent(new ErrorEvent('error', { message: 'Controlled GPU memory failure' }))); await closed;
  await expect(widget(other)).toHaveAttribute('title', /Controlled GPU memory failure/);
  await expect(peer.locator('#voice-state')).toHaveText('Recording'); await expectLiveRecording(live);
  affected = await start({ ...t, website: other }); await expect(affected.locator('#voice-state')).toHaveText('Recording');
  closed = affected.waitForEvent('close'); await other.reload(); await closed;
  await expect(peer.locator('#voice-state')).toHaveText('Recording'); await expectLiveRecording(live);
  affected = await start({ ...t, website: other }); await expect(affected.locator('#voice-state')).toHaveText('Recording');
  closed = affected.waitForEvent('close');
  await affected.evaluate(() => voiceResources.streams[0].getAudioTracks()[0].dispatchEvent(new Event('ended'))); await closed;
  await expect(peer.locator('#voice-state')).toHaveText('Recording'); await expectLiveRecording(live);
  await t.context.addInitScript(() => {
    if (!location.href.includes('web-voice-runtime.html')) return;
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker { postMessage(data, ...rest) { if (data.type !== 'load') super.postMessage(data, ...rest); } };
  });
  affected = await start({ ...t, website: other }); await expect(affected.locator('#voice-state')).toHaveText('Preparing…');
  closed = affected.waitForEvent('close'); await mic(other); await closed;
  await expect(peer.locator('#voice-state')).toHaveText('Recording'); await expectLiveRecording(live);
  await expect(other.locator('#first')).toHaveValue('before after');
  closed = peer.waitForEvent('close'); await t.library.locator('#web-voice-enabled').uncheck(); await closed;
  await expectLiveRecording(live); await live.close();
});

test('permission removal removes owners and suppresses later writes', async ({ voice: t }) => {
  test.skip(real, 'Deterministic teardown coverage.');
  await enable(t); await assignLiveMicrophone(t);
  let runtime = await start(t); await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  const live = await openLive(t); await live.locator('#start').click(); await expectLiveRecording(live);
  const closed = runtime.waitForEvent('close');
  await t.library.evaluate(() => chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] })); await closed;
  await expect(t.library.locator('#web-voice-enabled')).not.toBeChecked();
  await expect(widget(t.website)).toHaveCount(0); await expect(t.website.locator('#first')).toHaveValue('before after');
  await expectLiveRecording(live); await live.close();
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
  await t.library.reload(); await enable(t); await assignLiveMicrophone(t);
  await t.cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', origin: t.url.replace(/\/extension\/$/, '') });
  const live = await openLive(t); await live.locator('#start').click(); await expectLiveRecording(live);
  const runtime = await start(t); await expect.poll(() => runtime.isClosed()).toBe(true);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
  await expect(widget(t.website)).toHaveAttribute('title', /cache|Models|files/i);
  await expect(t.website.locator('#first')).toHaveValue('before after');
  await expectLiveRecording(live); await live.close();
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

test('back-forward cache restores idle controls and selection listeners without resuming capture', async ({ voice: t }) => {
  test.skip(real, 'Cached-document lifecycle uses controlled inference.');
  await enable(t);
  let runtime = await start(t);
  await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await t.website.bringToFront();
  await t.website.evaluate(() => {
    window.cachedVoiceDocument = true;
    window.addEventListener('pageshow', event => { window.voiceRestored = event.persisted; });
  });
  const original = t.website.url();
  const closed = runtime.waitForEvent('close');
  await t.website.goto(original + '?away'); await closed;
  await t.website.goBack({ waitUntil: 'commit' });
  await expect.poll(() => t.website.evaluate(() => window.cachedVoiceDocument && window.voiceRestored)).toBe(true);
  await t.website.locator('#second').focus();
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'idle');
  expect(t.context.pages().filter(page => page.url().includes('web-voice-runtime.html'))).toHaveLength(0);
  await expect(t.website.locator('#first')).toHaveValue('before after');
  await expect(t.website.locator('#second')).toHaveValue('left right');

  runtime = await start(t, '#second');
  await expect(runtime.locator('#voice-state')).toHaveText('Recording');
  await t.website.bringToFront();
  await t.website.locator('#second').evaluate(element => element.setSelectionRange(5, 5));
  await runtime.waitForTimeout(600);
  const stopped = runtime.waitForEvent('close'); await mic(t.website); await stopped;
  await expect(t.website.locator('#second')).toHaveValue('left confirmed fixtureright');
  expect(await t.website.evaluate(() => window.submits)).toBe(0);

  // A second cache round trip must restore listeners again and recheck consent.
  await t.website.goto(original + '?away-again');
  await t.library.locator('#web-voice-enabled').uncheck();
  await t.website.goBack({ waitUntil: 'commit' });
  await expect.poll(() => t.website.evaluate(() => window.voiceRestored)).toBe(true);
  await t.website.locator('#first').focus();
  await expect(widget(t.website)).toHaveCount(0);
  expect(t.context.pages().filter(page => page.url().includes('web-voice-runtime.html'))).toHaveLength(0);
});

test('Material Symbols circle: isolated styles, light/dark, focus, hover, reduced motion and forced colors', async ({ voice: t }, info) => {
  test.skip(real, 'Visual checks use the lightweight installed extension.');
  await enable(t); await t.website.bringToFront();
  await t.website.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `body{padding:70px;background:#fafafa} input{width:220px;height:34px}
      button,svg{width:100px!important;padding:40px!important;fill:lime!important}
      [data-local-web-voice]{width:300px!important;margin:20px!important;font-size:80px!important}`;
    document.head.append(style);
  });
  await t.website.locator('#first').focus();
  let ui = await controlUI(t); expectIcon(ui, 'mic');
  const micSource = await readFile(path.join(t.root,'extension/icons/material-symbols/mic.svg'), 'utf8');
  expect(micSource).toContain(`d="${ui.path}"`);
  expect(ui).toMatchObject({ circle:'50%', display:'inline-flex', align:'center', justify:'center', padding:'0px', boxSizing:'border-box', appearance:'none', lineHeight:'14px', theme:'light', disabled:false, label:'Start voice typing', title:'Start voice typing', status:'' });
  expect(await t.website.locator('[data-local-web-voice]').evaluate(e => e.shadowRoot)).toBeNull();
  const idleBackground = ui.background;
  await t.website.mouse.move(ui.button.x + 18, ui.button.y + 18);
  expect((await controlUI(t)).background).not.toBe(idleBackground);
  ui = await controlUI(t, true); expect(ui.focused).toBe(true); expect(ui.outline).toBe('solid');
  await t.website.screenshot({ path:info.outputPath('mic-light-focus.png'),clip:{x:0,y:50,width:600,height:220} });
  await t.website.locator('#first').focus();
  await t.website.locator('#first').evaluate(e => e.setSelectionRange(0,0));
  await t.website.keyboard.type('normal typing');
  await expect(t.website.locator('#first')).toHaveValue('normal typingbefore after');
  await t.website.mouse.move(0,0);
  for (const colorScheme of ['dark', 'light']) {
    await t.website.emulateMedia({ colorScheme, reducedMotion:'reduce' });
    await t.website.evaluate(dark => { document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; document.body.style.background = dark ? '#141820' : '#fafafa'; }, colorScheme === 'dark');
    await expect.poll(async () => (await controlUI(t)).theme).toBe(colorScheme);
    ui = await controlUI(t); expectIcon(ui, 'mic');
    if (colorScheme === 'dark') { expect(ui.background).toBe('rgb(32, 40, 51)'); await t.website.screenshot({ path:info.outputPath('mic-dark.png'),clip:{x:0,y:50,width:600,height:220} }); }
  }
  await t.website.emulateMedia({ forcedColors:'active' });
  ui = await controlUI(t); expectIcon(ui, 'mic'); expect(ui.color).not.toBe(ui.background);
  await t.website.screenshot({ path:info.outputPath('mic-forced-colors.png') });
  await t.cdp.send('Browser.setPermission', { permission:{ name:'microphone' }, setting:'denied', origin:t.url.replace(/\/extension\/$/,'') });
  const created = t.context.waitForEvent('page', { predicate:page => page.url().includes('web-voice-runtime.html') });
  await controlUI(t,true); await t.website.keyboard.press('Space');
  const runtime = await created; await expect.poll(() => runtime.isClosed()).toBe(true);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state','error');
});

test('field attachment avoids neighbours, stays in viewport across reflow, zoom, resize and scroll', async ({ voice: t }, info) => {
  test.skip(real, 'Layout coverage uses controlled inference.');
  await enable(t); await t.website.bringToFront();
  await t.website.locator('#first').focus();
  const crowded = await controlUI(t);
  for (const selector of ['#first','#second','#password','#otp','#card','#readonly','button[type="submit"]']) {
    expect(intersects(crowded.button, await t.website.locator(selector).boundingBox())).toBe(false);
  }
  await t.website.evaluate(() => {
    document.body.style.cssText = 'margin:0;min-height:2000px';
    for (const e of document.querySelectorAll('body > input, [contenteditable]')) e.remove();
    document.querySelector('form').style.cssText = 'position:absolute;left:100px;top:100px;display:flex;align-items:center;gap:2px';
    document.querySelector('#first').style.cssText = 'box-sizing:border-box;width:92px;height:22px';
    document.querySelector('#second').style.cssText = 'width:50px;height:22px';
  });
  await t.website.locator('#first').focus();
  const check = async () => {
    const ui = await controlUI(t), viewport = await t.website.evaluate(() => ({ width:innerWidth,height:innerHeight }));
    expect(ui.button.x).toBeGreaterThanOrEqual(4); expect(ui.button.y).toBeGreaterThanOrEqual(4);
    expect(ui.button.x + 36).toBeLessThanOrEqual(viewport.width - 4);
    expect(ui.button.y + 36).toBeLessThanOrEqual(viewport.height - 4);
    for (const selector of ['#first','#second','button[type="submit"]']) expect(intersects(ui.button, await t.website.locator(selector).boundingBox())).toBe(false);
    const field = await t.website.locator('#first').boundingBox();
    const distance = Math.max(field.x - ui.button.x - 36, ui.button.x - field.x - field.width, field.y - ui.button.y - 36, ui.button.y - field.y - field.height);
    expect(distance).toBeLessThanOrEqual(6.1); expect(distance).toBeGreaterThanOrEqual(0);
  };
  await check();
  for (const [width, height, left, top] of [[320,240,0,0],[320,240,228,0],[320,240,228,218],[600,360,250,160]]) {
    await t.website.setViewportSize({ width,height });
    await t.website.locator('form').evaluate((e, p) => { e.style.left = p.left+'px'; e.style.top = p.top+'px'; }, { left,top });
    // Reflow can occur without a resize or one of the observed attributes.
    await expect(check).toPass({ timeout:5000 });
  }
  await t.website.evaluate(() => { document.body.style.zoom = '1.25'; });
  await expect(check).toPass({ timeout:5000 });
  await t.library.evaluate(async websiteURL => {
    const [tab] = await chrome.tabs.query({ url:websiteURL });
    await chrome.tabs.setZoom(tab.id,1.25);
  }, t.website.url());
  const metrics = await t.context.newCDPSession(t.website);
  await metrics.send('Emulation.setDeviceMetricsOverride', { width:600,height:360,deviceScaleFactor:2,mobile:false });
  await expect(check).toPass({ timeout:5000 });
  expect(await t.website.evaluate(() => devicePixelRatio)).toBeGreaterThan(1);
  await metrics.detach();
  await t.website.screenshot({ path:info.outputPath('mic-small-field-zoom.png') });
  await t.website.evaluate(() => scrollTo(0,900)); await expect(widget(t.website)).toBeHidden();
  await t.website.evaluate(() => scrollTo(0,0)); await expect(widget(t.website)).toBeVisible(); await check();
});

test('all visual states use local SVGs, keep the caret and expose a visible keyboard stop', async ({ voice: t }, info) => {
  test.skip(real, 'State rendering uses controlled Worker scheduling.');
  await enable(t);
  await t.website.evaluate(() => {
    document.body.style.cssText = 'margin:0;padding:60px';
    document.querySelector('form').style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:60px';
    document.querySelector('#first').style.cssText = 'width:200px;height:32px';
  });
  await t.context.addInitScript(() => {
    if (!location.href.includes('web-voice-runtime.html')) return;
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      postMessage(data, ...rest) {
        const send = () => super.postMessage(data, ...rest);
        if (data.type === 'load') setTimeout(send, 700);
        else if (data.type === 'vad-stop') setTimeout(send, 700);
        else send();
      }
    };
  });
  const runtime = await start(t);
  expect(await readFile(path.join(t.root,'extension/icons/material-symbols/LICENSE'),'utf8')).toContain('Apache License');
  expect(await readFile(path.join(t.root,'extension/icons/material-symbols/README.md'),'utf8')).toContain('10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7');
  let ui = await controlUI(t); expectIcon(ui, 'progress_activity');
  expect(await readFile(path.join(t.root,'extension/icons/material-symbols/progress_activity.svg'),'utf8')).toContain(`d="${ui.path}"`);
  expect(ui.label).toContain('cancel'); expect(ui.disabled).toBe(false); expect(ui.animation).toBe('voice-spin');
  await t.website.emulateMedia({ reducedMotion:'reduce' });
  expect((await controlUI(t)).animation).toBe('none');
  await expect(t.website.locator('#first')).toBeFocused();
  expect(await t.website.locator('#first').evaluate(e => [e.selectionStart,e.selectionEnd])).toEqual([7,7]);
  await t.website.screenshot({ path:info.outputPath('mic-preparing.png'),clip:{x:0,y:0,width:600,height:240} });
  await expect(widget(t.website)).toHaveAttribute('data-voice-state','recording');
  ui = await controlUI(t); expectIcon(ui, 'stop');
  expect(await readFile(path.join(t.root,'extension/icons/material-symbols/stop.svg'),'utf8')).toContain(`d="${ui.path}"`);
  expect(ui.label).toBe('Recording · Stop voice typing');
  expect(ui.color).toBe('rgb(180, 35, 24)'); expect(ui.status).toBe('Recording');
  await t.website.screenshot({ path:info.outputPath('mic-recording.png'),clip:{x:0,y:0,width:600,height:240} });
  await t.website.mouse.move(0,0);
  await t.website.evaluate(() => { document.documentElement.style.colorScheme = 'dark'; document.body.style.background = '#141820'; });
  await t.website.emulateMedia({ colorScheme:'dark',reducedMotion:'reduce' });
  await expect.poll(async () => (await controlUI(t)).theme).toBe('dark');
  ui = await controlUI(t); expectIcon(ui,'stop'); expect(ui.background).toBe('rgb(96, 27, 22)');
  await t.website.screenshot({ path:info.outputPath('mic-recording-dark.png'),clip:{x:0,y:0,width:600,height:240} });
  await t.website.emulateMedia({ colorScheme:'light',reducedMotion:'reduce' });
  await t.website.evaluate(() => { document.documentElement.style.colorScheme = 'light'; document.body.style.background = '#fff'; });
  await t.website.evaluate(() => { for (const e of document.querySelectorAll('input,textarea,button,[contenteditable]')) e.tabIndex = -1; document.body.style.minHeight = '2000px'; scrollTo(0,1000); });
  await expect(widget(t.website)).toBeVisible();
  await t.website.keyboard.press('Tab');
  expect((await controlUI(t)).focused).toBe(true);
  const closed = runtime.waitForEvent('close'); await t.website.keyboard.press('Enter');
  await expect(widget(t.website)).toHaveAttribute('data-voice-state','stopping');
  ui = await controlUI(t); expectIcon(ui, 'progress_activity'); expect(ui.disabled).toBe(true); expect(ui.label).toBe('Stopping…');
  await t.website.screenshot({ path:info.outputPath('mic-stopping.png') });
  await closed;
  await t.website.evaluate(() => scrollTo(0,0));
  const denied = await start(t, '#first', 'denied'); await expect.poll(() => denied.isClosed()).toBe(true);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state','error');
  ui = await controlUI(t); expectIcon(ui, 'error'); expect(ui.title.length).toBeGreaterThan(0); expect(ui.label).toContain('Retry');
  expect(ui.status).toBe(ui.title);
  const viewport = t.website.viewportSize();
  expect(ui.bubble.x).toBeGreaterThanOrEqual(4); expect(ui.bubble.y).toBeGreaterThanOrEqual(4);
  expect(ui.bubble.x + ui.bubble.width).toBeLessThanOrEqual(viewport.width - 4);
  await t.website.screenshot({ path:info.outputPath('mic-error.png'),clip:{x:0,y:0,width:600,height:240} });
  expect(await readFile(path.join(t.root,'extension/icons/material-symbols/error.svg'),'utf8')).toContain(`d="${ui.path}"`);
  await writeFile(info.outputPath('mic-ui-evidence.json'), JSON.stringify({ browser:t.context.browser().version(),
    installedExtension:true, productionManifest:true, isolatedClosedShadow:true, controlledInference:true,
    states:['idle','preparing','recording','stopping','error'], remoteRequests:t.remote.length, pageErrors:t.pageErrors,
    inputCaretPreserved:true, pointerStart:true, keyboardStop:true }, null, 2)+'\n');
});
