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
      // Assemble the current extension sources directly. Real mode includes
      // the pinned Reazon/Silero bundle; no unrelated optional weights required.
      if (real) await readFile('web/vendor/manifest.json');
      await cp('extension', path.join(root, 'extension'), { recursive: true });
      await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !/\/(tts-assets|correction-assets)(\/|$)/.test(source) && (real || !/\/vendor(\/|$)/.test(source)) });
      await cp('extension/manifest.json', path.join(root, 'manifest.json'));
      if (!real) {
        // Modal tests recognize one utterance, regardless of Chromium's fake
        // microphone tone/silence cycle or how long placement checks take.
        const singleUtterance = /^(closed-shadow modal|stacked modal dialogs)/.test(info.title);
        for (const role of ['sherpa', 'silero', 'whisper']) await writeFile(path.join(root, `web/${role}-worker.js`), `let samples=0;self.onmessage=({data})=>{
          if(data.type==='load')postMessage({type:'ready'});
          if(data.type==='vad-start')samples=0;
          if(data.type==='vad-audio'){
            const speaking=${singleUtterance ? 'samples < 8000' : 'data.audio.some(x=>Math.abs(x)>.001)'};samples+=data.audio.length;
            postMessage({type:'vad',session:data.session,frames:[{audio:data.audio,speaking}]});
          }
          if(data.type==='vad-stop')postMessage({type:'vad-stopped',session:data.session});
          if(data.type==='decode'){postMessage({type:data.final?'final':'partial',text:data.final?'${role === 'whisper' ? 'whisper fixture' : 'confirmed fixture'}':'pending fixture',session:data.session,id:data.id});postMessage({type:'decoded',session:data.session});}
        };`);
      }
      const launch = () => chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
        ignoreDefaultArgs: ['--disable-extensions', ...(info.title.includes('back-forward cache') ? ['--disable-back-forward-cache'] : [])], args: ['--enable-unsafe-extension-debugging', '--use-fake-device-for-media-stream',
          ...(real ? [`--use-file-for-fake-audio-capture=${path.resolve('tests/fixtures/ordinary-english.wav')}${info.title.includes('overlap') ? '' : '%noloop'}`] : [])] });
      context = await launch();
      context.on('serviceworker', worker => worker.on('console', message => { if (message.type() === 'warning') console.log(message.text()); }));
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
      const instrument = () => {
        if (location.protocol !== 'chrome-extension:') return;
        window.voiceFinals = [];
        window.voiceResources = { workers: [], streams: [], audioSamples: 0 };
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async options => {
          const stream = await getUserMedia(options); window.voiceResources.streams.push(stream); return stream;
        };
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args);
            this.released = false; window.voiceResources.workers.push(this);
            this.addEventListener('message', ({ data }) => { if (data.type === 'final') { const item = { id: data.id, text: data.text }; window.voiceFinals.push(item); console.debug('voice-test-final:' + JSON.stringify(item)); } });
          }
          postMessage(data, ...rest) {
            if (data.type === 'vad-audio') window.voiceResources.audioSamples += data.audio.length;
            if (window.voiceDelay && ['load', 'vad-stop'].includes(data.type)) { setTimeout(() => super.postMessage(data, ...rest), window.voiceDelay); return; }
            return super.postMessage(data, ...rest);
          }
          terminate() { this.released = true; super.terminate(); }
        };
      };
      await context.addInitScript(instrument);
      await writeFile(path.join(root, 'extension/voice-test-probe.js'), `(${instrument.toString()})();`);
      const runtimeHTML = path.join(root, 'extension/web-voice-runtime.html');
      await writeFile(runtimeHTML, (await readFile(runtimeHTML, 'utf8')).replace('<body>', '<body><script src="voice-test-probe.js"></script>'));
      context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
      context.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) remote.push(request.url()); });
      const library = await context.newPage(); await library.goto(url + 'graph-library.html');
      await expect(library.locator('#graph-list button[data-id]')).toHaveCount(1);
      const graphId = await library.evaluate(async () => {
        const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { graphNode, edge } = await import('./graph.js');
        const graph = { version: 15, nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')],
          edges: [edge('mic','audio','asr','audio'),edge('asr','final','field','text')] };
        const store = new GraphLibrary(localStorage), next = await store.create({ name: 'Dictation', graph }, readLibrary(localStorage).revision);
        const id = next.graphs.at(-1).id; await store.assign('webVoice', id, next.revision); return id;
      });
      await library.reload();
      const website = await context.newPage(); await website.goto(`http://127.0.0.1:${server.address().port}/`);
      await use({ context, library, website, url, cdp, id, graphId, pageErrors, remote, root,
        async restart() {
          const websiteURL = website.url(); await context.close(); context = await launch();
          this.context = context; this.cdp = await context.browser().newBrowserCDPSession();
          // Reapply the fixture's native host grant: loading an unpacked optional-only
          // manifest does not persist the earlier required-host installation grant.
          await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest), host_permissions: ['http://*/*', 'https://*/*'] }));
          expect((await this.cdp.send('Extensions.loadUnpacked', { path: root })).id).toBe(id);
          await writeFile(manifestPath, originalManifest);
          await this.cdp.send('Extensions.loadUnpacked', { path: root });
          this.library = await context.newPage(); await this.library.goto(url + 'graph-library.html');
          this.website = await context.newPage(); await this.website.goto(websiteURL);
        } });
      if (info.status !== info.expectedStatus && !library.isClosed()) console.log('Voice test state:', await library.evaluate(async () => ({
        preferences: await chrome.storage.local.get(['web-voice-typing-v1', 'web-microphone-default-v1']),
        origins: (await chrome.permissions.getAll()).origins, registered: (await chrome.scripting.getRegisteredContentScripts()).length,
        offscreen: (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length
      })));
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
  return inspectControl(t, focus);
}
// A widget relocated into a site's closed-root modal is also opaque to
// Playwright locators. Inspect it through DevTools, just like its own root.
async function inspectControl(t, focus = false) {
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
          button:rect(button), svg:rect(svg), bubble:rect(status), bubbleClip:getComputedStyle(status).clipPath, theme:this.host.dataset.theme,
          circle:style.borderRadius, display:style.display, align:style.alignItems, justify:style.justifyContent,
          padding:style.padding, boxSizing:style.boxSizing, appearance:style.appearance, lineHeight:style.lineHeight,
          color:style.color, background:style.backgroundColor, fill:motion.fill, animation:motion.animationName,
          outline:style.outlineStyle, focused:this.activeElement === button, visibility:style.visibility };
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
async function permission(t, setting) {
  await t.cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting, origin: t.url.replace(/\/extension\/$/, '') });
}
async function start(t, selector = '#first', grant = 'granted') {
  if (grant) await permission(t, grant);
  await t.website.bringToFront(); await t.website.locator(selector).focus();
  await t.website.locator(selector).evaluate(e => {
    if (e.setSelectionRange) e.setSelectionRange(7, 7);
    else { const range = document.createRange(); range.setStart(e.firstChild, 6); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  });
  await expect(widget(t.website)).toBeVisible(); await mic(t.website);
}
const recording = t => expect(widget(t.website)).toHaveAttribute('data-voice-state', 'recording', { timeout: real ? 120000 : 10000 });
async function offscreenCount(t) {
  return t.library.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
}
async function idle(t) { await expect.poll(() => offscreenCount(t)).toBe(0); }
async function stop(t) {
  await t.website.bringToFront(); await mic(t.website);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'idle');
}
async function noVisibleRuntime(t, pages) {
  expect(t.context.pages().filter(p => /web-voice-(runtime|permission)\.html/.test(p.url()))).toHaveLength(0);
  if (pages) expect(t.context.pages()).toHaveLength(pages);
  const contexts = await t.library.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  expect(contexts).toHaveLength(1);
}
// Offscreen documents are CDP targets, not Playwright Pages. Inspect the real
// target directly; never open a visible runtime document for test access.
async function runtime(t) {
  let target;
  await expect.poll(async () => {
    target = (await t.cdp.send('Target.getTargets')).targetInfos.find(x => x.url.includes('web-voice-runtime.html'));
    return !!target;
  }).toBe(true);
  const { sessionId } = await t.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let next = 0;
  const pending = new Map(), finals = [], errors = [];
  const listener = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message); }
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = message.params.args[0]?.value;
      if (typeof text === 'string' && text.startsWith('voice-test-final:')) finals.push(JSON.parse(text.slice('voice-test-final:'.length)));
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  t.cdp.on('Target.receivedMessageFromTarget', listener);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, message => message.error ? reject(Error(message.error.message)) : resolve(message.result));
    t.cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
  });
  await send('Runtime.enable');
  return { finals, errors, targetId: target.targetId,
    async evaluate(fn, arg) {
      const result = await send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    async detach() { t.cdp.off('Target.receivedMessageFromTarget', listener); await t.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); },
  };
}
async function bootstrap(t, source) {
  await idle(t); // Ensure the next offscreen generation loads this test instrumentation.
  const file = path.join(t.root, 'extension/voice-test-probe.js');
  await writeFile(file, (await readFile(file, 'utf8')) + '\n' + source);
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
  await expect(t.library.locator('#web-graph')).toHaveCount(0);
  expect(await t.library.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-library-v1')).assignments.webVoice)).toBe(t.graphId);
  await t.website.locator('#first').focus(); await expect(widget(t.website)).toHaveCount(0);
  await enable(t);
  await t.library.locator('#web-voice-enabled').uncheck();
  expect(await t.library.evaluate(async () => (await chrome.storage.local.get('web-microphone-default-v1'))['web-microphone-default-v1'])).toBe(t.graphId);
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
  await controlUI(t,true); await t.website.keyboard.press('Space');
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
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
    // Focus-ring clearance can require the next field-adjacent candidate.
    expect(distance).toBeLessThanOrEqual(90.1); expect(distance).toBeGreaterThanOrEqual(0);
  };
  await expect(check).toPass({ timeout:5000 });
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


// Positioning fixtures use the installed content script and trusted activation;
// no page-world handles into its closed root or substituted collision APIs.
async function placementPage(t, extra = '') {
  await enable(t); await t.website.bringToFront();
  await t.website.setViewportSize({ width:480, height:320 });
  await t.website.evaluate(extra => {
    document.body.innerHTML = `<style>body{margin:0} #field{position:absolute;box-sizing:border-box;left:160px;top:120px;width:120px;height:36px}</style>
      <input id="field" value="before after">` + extra;
    window.siteClicks = 0;
    document.body.addEventListener('click', e => { if (e.target.closest('button,a,label')) siteClicks++; });
  }, extra);
  await t.website.locator('#field').focus();
}
async function clearOf(t, selectors) {
  const ui = await controlUI(t);
  for (const selector of selectors) {
    const rect = await t.website.locator(selector).boundingBox();
    expect(intersects({ x:ui.button.x-6,y:ui.button.y-6,width:48,height:48 }, rect)).toBe(false);
    if (ui.status && ui.bubbleClip === 'none') expect(intersects(ui.bubble, rect)).toBe(false);
  }
  return ui;
}

test('safe placement prefers the right, protects an adjacent site button and catches thin partial overlaps', async ({ voice: t }) => {
  test.skip(real); await placementPage(t);
  await expect.poll(async () => (await controlUI(t)).button.x).toBe(286);
  await t.website.evaluate(() => {
    const button = document.createElement('button'); button.id = 'neighbour'; button.textContent = 'Send';
    button.style.cssText = 'position:absolute;left:286px;top:120px;width:60px;height:36px'; document.body.append(button);
  });
  await expect(async () => {
    const ui = await clearOf(t, ['#field', '#neighbour']); expect(ui.button.x).toBe(118);
  }).toPass();
  await t.website.locator('#neighbour').click();
  expect(await t.website.evaluate(() => siteClicks)).toBe(1);
  await t.website.locator('#field').focus();
  await t.website.locator('#neighbour').evaluate(e => { e.style.cssText = 'position:absolute;left:294px;top:110px;width:2px;height:60px;padding:0;border:0;pointer-events:none'; });
  await expect(async () => {
    const ui = await clearOf(t, ['#field', '#neighbour']); expect(ui.button.x).toBe(118);
  }).toPass();
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'idle');
  await idle(t);
});

test('idle mic hides in a packed viewport and returns when controls leave without changing page layout', async ({ voice: t }) => {
  test.skip(real); await placementPage(t, '<button id="cover" style="position:fixed;inset:0;width:100%;height:100%">Site action</button>');
  await expect(widget(t.website)).toBeHidden();
  expect(await t.website.locator('#field').boundingBox()).toMatchObject({ x:160,y:120,width:120,height:36 });
  await t.website.mouse.click(20,20); expect(await t.website.evaluate(() => siteClicks)).toBe(1);
  await t.website.locator('#field').focus();
  await t.website.locator('#cover').evaluate(e => e.remove());
  await expect(widget(t.website)).toBeVisible();
  expect(await t.website.locator('#field').boundingBox()).toMatchObject({ x:160,y:120,width:120,height:36 });
  expect(await t.website.locator('#field').evaluate(e => e.parentElement === document.body)).toBe(true);
  await idle(t);
});

test('shadow controls, clipped controls and labels remain conservative geometry obstructions', async ({ voice: t }) => {
  test.skip(real); await placementPage(t, '<span id="open"></span><div id="closed"></div>');
  await t.website.evaluate(() => {
    const open = document.querySelector('#open');
    open.style.cssText = 'position:absolute;left:286px;top:120px;width:0;height:0';
    open.attachShadow({mode:'open'}).innerHTML = '<button style="position:absolute;left:0;top:0;width:36px;height:36px">Shadow</button>';
    const closed = document.querySelector('#closed');
    closed.style.cssText = 'position:absolute;left:118px;top:120px;width:36px;height:36px;overflow:hidden';
    closed.attachShadow({mode:'closed'}).innerHTML = '<button style="width:60px;height:36px">Closed</button>';
  });
  await expect(async () => {
    const ui = await clearOf(t, ['#field', '#open button', '#closed']);
    expect(ui.button.y + ui.button.height).toBeLessThanOrEqual(114);
  }).toPass();
  // An interactive label introduced inside an existing open root must trigger
  // rediscovery too, even though light-DOM observers cannot see this mutation.
  await t.website.locator('#open').evaluate(e => {
    const label = document.createElement('label'); label.id = 'shadow-label'; label.textContent = 'Label';
    label.style.cssText = 'position:fixed;left:244px;top:78px;width:36px;height:36px'; e.shadowRoot.append(label);
  });
  await expect(async () => { await clearOf(t, ['#field', '#open button', '#closed', '#open #shadow-label']); }).toPass();
});

test('transformed root placement verifies the rendered mic and preserves native button clicks', async ({ voice: t }) => {
  test.skip(real); await placementPage(t);
  await t.website.setViewportSize({ width:800, height:320 });
  await t.website.evaluate(() => {
    document.documentElement.style.transform = 'translateX(100px)';
    const button = document.createElement('button'); button.id = 'neighbour'; button.textContent = 'Send';
    button.style.cssText = 'position:absolute;left:386px;top:120px;width:36px;height:36px'; document.body.append(button);
  });
  await expect(async () => {
    const ui = await clearOf(t, ['#field', '#neighbour']); expect(ui.button.x).toBe(386);
  }).toPass();
  await t.website.locator('#neighbour').click(); expect(await t.website.evaluate(() => siteClicks)).toBe(1);
  await start(t, '#field'); await recording(t);
  await expect(async () => { await clearOf(t, ['#field', '#neighbour']); }).toPass();
  await stop(t); await idle(t);
  // Transforms that cannot be corrected by a translation must fail closed.
  await t.website.locator('#field').focus();
  await t.website.evaluate(() => { document.documentElement.style.transform = 'scale(1.2)'; });
  await expect(widget(t.website)).toBeHidden();
  await t.website.evaluate(() => { document.documentElement.style.transform = ''; });
  await expect(widget(t.website)).toBeVisible();
});

test('collapsed closed-shadow overflow uses descendant geometry for idle safety', async ({ voice: t }) => {
  test.skip(real); await placementPage(t);
  for (const offset of [8, -8]) {
    await t.website.evaluate(offset => {
      const host = document.createElement('div'); host.id = 'opaque';
      host.style.cssText = 'position:absolute;left:286px;top:120px;width:0;height:0'; document.body.append(host);
      const button = document.createElement('button'); button.setAttribute('aria-label', 'Native shadow action');
      button.style.cssText = `position:absolute;left:${offset}px;top:0;width:2px;height:36px;padding:0;border:0`;
      window.shadowClicks = 0; button.onclick = () => shadowClicks++;
      host.attachShadow({ mode:'closed' }).append(button);
    }, offset);
    await expect(async () => {
      const ui = await controlUI(t);
      expect(intersects({ x:ui.button.x-6,y:ui.button.y-6,width:48,height:48 },
        { x:286+offset,y:120,width:2,height:36 })).toBe(false);
    }).toPass();
    await t.website.mouse.click(287 + offset, 138);
    expect(await t.website.evaluate(() => shadowClicks)).toBe(1);
    await t.website.locator('#opaque').evaluate(e => e.remove());
    await t.website.locator('#field').focus();
    await expect(widget(t.website)).toBeVisible();
  }
});

for (const variant of ['absolute', 'hidden light child', 'fixed']) test(`noncollapsed closed-shadow ${variant} preserves thin native button clicks`, async ({ voice: t }) => {
  test.skip(real); await placementPage(t);
  await expect.poll(async () => (await controlUI(t)).button.x).toBe(286);
  await t.website.evaluate(variant => {
    const host = document.createElement('div'); host.id = 'opaque';
    host.style.cssText = 'position:absolute;left:0;top:0;width:10px;height:10px';
    const button = document.createElement('button');
    button.style.cssText = `position:${variant === 'fixed' ? 'fixed' : 'absolute'};left:294px;top:120px;width:2px;height:36px;padding:0;border:0`;
    window.shadowClicks = 0; button.onclick = () => shadowClicks++;
    window.moveShadowButton = (left, top) => { button.style.left = `${left}px`; button.style.top = `${top}px`; };
    host.attachShadow({ mode:'closed' }).append(button);
    if (variant === 'hidden light child') {
      const child = document.createElement('span'); child.hidden = true; host.append(child);
    }
    document.body.append(host);
  }, variant);
  await expect(async () => {
    const ui = await controlUI(t);
    expect(intersects({ x:ui.button.x-6,y:ui.button.y-6,width:48,height:48 },
      { x:294,y:120,width:2,height:36 })).toBe(false);
  }).toPass();
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'idle');
  await t.website.mouse.click(295, 138);
  expect(await t.website.evaluate(() => shadowClicks)).toBe(1);
  await idle(t);
  if (variant === 'fixed') {
    await t.website.locator('#field').focus();
    const ui = await controlUI(t), native = { x:ui.button.x+8,y:ui.button.y,width:2,height:36 };
    await t.website.evaluate(rect => moveShadowButton(rect.x, rect.y), native);
    // Closed-root mutations must invalidate cached discovery/placement too.
    await expect(async () => {
      const moved = await controlUI(t);
      expect(intersects({ x:moved.button.x-6,y:moved.button.y-6,width:48,height:48 }, native)).toBe(false);
    }).toPass();
    await t.website.mouse.click(native.x+1, native.y+18);
    expect(await t.website.evaluate(() => shadowClicks)).toBe(2); await idle(t);
  }
  await t.website.locator('#opaque').evaluate(e => e.remove());
  await t.website.locator('#field').focus();
  await expect.poll(async () => (await controlUI(t)).button.x).toBe(286);
});

test('layout and CSS animation rechecks move idle mic away from newly occupied space', async ({ voice: t }) => {
  test.skip(real); await placementPage(t);
  await expect.poll(async () => (await controlUI(t)).button.x).toBe(286);
  await t.website.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '@keyframes arrive{from{transform:translateX(100px)}to{transform:translateX(0)}} #moving{position:absolute;left:286px;top:120px;width:36px;height:36px;animation:arrive .5s .2s forwards}';
    document.head.append(style);
    const button = document.createElement('button'); button.id = 'moving'; button.textContent = 'Action'; document.body.append(button);
  });
  await expect.poll(async () => (await t.website.locator('#moving').boundingBox()).x).toBe(286);
  await expect(async () => { await clearOf(t, ['#field','#moving']); }).toPass();
  await t.website.locator('#moving').click(); expect(await t.website.evaluate(() => siteClicks)).toBe(1);
  await t.website.locator('#field').focus();
  await t.website.locator('#field').evaluate(e => { e.style.left = '350px'; e.style.top = '280px'; });
  await expect(async () => {
    const ui = await clearOf(t, ['#field','#moving']);
    expect(ui.button.x + 36).toBeLessThanOrEqual(476); expect(ui.button.y + 36).toBeLessThanOrEqual(316);
  }).toPass();
});

async function occupyViewport(t, pocket = false) {
  await t.website.evaluate(pocket => {
    const cover = document.createElement('button'); cover.id = 'cover'; cover.textContent = 'Website';
    cover.style.cssText = `position:fixed;left:0;top:0;width:100%;height:${pocket ? '250px' : '100%'};border:0;padding:0`;
    document.body.append(cover);
    if (pocket) {
      const bottom = document.createElement('button'); bottom.id = 'bottom'; bottom.textContent = 'Website';
      bottom.style.cssText = 'position:fixed;left:0;top:250px;width:410px;height:70px;border:0;padding:0'; document.body.append(bottom);
    }
  }, pocket);
}

test('active recording relocates to a viewport pocket and keeps the same Stop, target, focus and status click-through', async ({ voice: t }) => {
  test.skip(real); await placementPage(t); await start(t, '#field'); await recording(t);
  await t.website.locator('#field').evaluate(e => e.setSelectionRange(7,7));
  const ui = await controlUI(t);
  // Status labels never intercept native page clicks, including when the label
  // has to disappear visually to avoid a new control.
  await t.website.evaluate(bubble => {
    const link = document.createElement('a'); link.id = 'under-status'; link.href = '#'; link.textContent = 'Link';
    link.style.cssText = `position:fixed;left:${bubble.x}px;top:${bubble.y}px;width:${bubble.width}px;height:${bubble.height}px`;
    link.onclick = e => e.preventDefault(); document.body.append(link);
  }, ui.bubble);
  await t.website.locator('#under-status').click();
  await t.website.locator('#field').focus();
  await occupyViewport(t, true);
  await expect(async () => {
    const relocated = await clearOf(t, ['#cover','#bottom']);
    expect(relocated.button.x).toBeGreaterThanOrEqual(416); expect(relocated.button.y).toBeGreaterThanOrEqual(256);
  }).toPass();
  await expect(t.website.locator('#field')).toBeFocused();
  await expect(widget(t.website)).toHaveCount(1); await recording(t); await noVisibleRuntime(t);
  const clicks = await t.website.evaluate(() => siteClicks);
  const owner = await runtime(t);
  await expect.poll(() => owner.evaluate(() => voiceResources.audioSamples)).toBeGreaterThan(8000);
  await owner.detach();
  await stop(t); await idle(t);
  expect(await t.website.evaluate(() => siteClicks)).toBe(clicks);
  await expect(t.website.locator('#field')).toHaveValue('before confirmed fixtureafter');
  await expect(widget(t.website)).toBeHidden();
});

test('fully occupied active viewport retains Cancel and Stop, and returns to clear placement when space opens', async ({ voice: t }) => {
  test.skip(real); await placementPage(t); await bootstrap(t, 'window.voiceDelay = 1000;');
  await start(t, '#field');
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'preparing');
  await occupyViewport(t);
  await expect(widget(t.website)).toBeVisible();
  await expect.poll(async () => (await controlUI(t)).button.x).toBe(10);
  await expect(t.website.locator('#field')).toBeFocused();
  await mic(t.website); await idle(t);
  expect(await t.website.evaluate(() => siteClicks)).toBe(0);
  await expect(widget(t.website)).toBeHidden();
  await t.website.locator('#cover').evaluate(e => e.remove());
  await start(t, '#field'); await recording(t);
  await occupyViewport(t);
  await expect.poll(async () => (await controlUI(t)).button.x).toBe(10);
  const fallback = await controlUI(t); expectIcon(fallback, 'stop'); expect(fallback.disabled).toBe(false);
  expect(fallback.bubbleClip).toBe('inset(50%)');
  await t.website.locator('#cover').evaluate(e => e.remove());
  await expect.poll(async () => (await controlUI(t)).button.x).toBe(286);
  await recording(t); await expect(widget(t.website)).toHaveCount(1);
  await occupyViewport(t);
  await expect.poll(async () => (await controlUI(t)).button.x).toBe(10);
  await stop(t); await idle(t);
  expect(await t.website.evaluate(() => siteClicks)).toBe(0);
});


test('active Stop remains clickable above later maximum-z-index overlays, popovers and modal dialogs', async ({ voice: t }) => {
  test.skip(real); await placementPage(t); await start(t, '#field'); await recording(t);
  await occupyViewport(t);
  await t.website.locator('#cover').evaluate(e => { e.style.zIndex = '2147483647'; });
  const reachable = async () => {
    const rect = await widget(t.website).boundingBox();
    expect(await t.website.evaluate(rect => document.elementFromPoint(rect.x+18,rect.y+18)?.hasAttribute('data-local-web-voice'), rect)).toBe(true);
  };
  await expect(reachable).toPass();
  await t.website.evaluate(() => {
    const overlay = document.createElement('div'); overlay.id = 'popover'; overlay.popover = 'manual';
    overlay.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0';
    document.body.append(overlay); overlay.showPopover();
  });
  await expect(reachable).toPass();
  await t.website.evaluate(() => {
    document.querySelector('#popover').remove();
    const dialog = document.createElement('dialog'); dialog.id = 'modal'; dialog.textContent = 'Site dialog';
    document.body.append(dialog); dialog.showModal();
  });
  await expect(reachable).toPass();
  await controlUI(t, true); await t.website.keyboard.press('Enter'); await idle(t);
  expect(await t.website.evaluate(() => siteClicks)).toBe(0);
  await expect(widget(t.website)).toBeHidden();
});


for (const phase of ['preparing', 'recording']) test(`open-shadow modal keeps ${phase === 'preparing' ? 'Cancel' : 'Stop'} clickable and keyboard focusable`, async ({ voice: t }) => {
  test.skip(real); await placementPage(t);
  if (phase === 'preparing') await bootstrap(t, 'window.voiceDelay = 3000;');
  await start(t, '#field');
  if (phase === 'recording') await recording(t);
  else await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'preparing');
  await t.website.evaluate(() => {
    const outer = document.createElement('div'), inner = document.createElement('span');
    const dialog = document.createElement('dialog'); dialog.id = 'shadow-modal'; dialog.textContent = 'Site dialog';
    inner.attachShadow({ mode:'open' }).append(dialog);
    outer.attachShadow({ mode:'open' }).append(inner); document.body.append(outer);
    dialog.showModal();
  });
  await expect.poll(() => widget(t.website).evaluate(e => e.parentElement.id)).toBe('shadow-modal');
  await expect(widget(t.website)).toHaveCount(1);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', phase);
  await controlUI(t, true);
  // A placement recheck must not re-promote a reachable shadow control and
  // discard its keyboard focus just because document hits retarget its host.
  await t.website.evaluate(async () => {
    window.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect((await controlUI(t)).focused).toBe(true);
  await mic(t.website); await idle(t);
  await expect(widget(t.website)).toBeHidden();
  expect(await t.website.evaluate(() => siteClicks)).toBe(0);
});

for (const phase of ['preparing', 'recording']) test(`closed-shadow modal keeps ${phase === 'preparing' ? 'Cancel' : 'Stop'} reachable without replacing the control or session`, async ({ voice: t }) => {
  test.skip(real); await placementPage(t);
  if (phase === 'preparing') await bootstrap(t, 'window.voiceDelay = 3000;');
  await start(t, '#field');
  if (phase === 'recording') await recording(t);
  else await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'preparing');
  const owner = await runtime(t);
  // Stop drains transcription, so make recording output deterministic before
  // opening the modal; preparation cancellation must not insert any text.
  if (phase === 'recording') await expect.poll(() => owner.evaluate(() => voiceResources.audioSamples)).toBeGreaterThan(8000);
  await t.website.evaluate(() => {
    window.originalVoiceControl = document.querySelector('[data-local-web-voice]');
    const outer = document.createElement('div'), inner = document.createElement('span');
    const dialog = window.siteModal = document.createElement('dialog'); dialog.textContent = 'Site dialog';
    inner.attachShadow({ mode:'closed' }).append(dialog);
    outer.attachShadow({ mode:'closed' }).append(inner); document.body.append(outer); dialog.showModal();
  });
  await expect.poll(() => t.website.evaluate(() => originalVoiceControl.parentElement === siteModal)).toBe(true);
  const ui = await inspectControl(t, true);
  expect(ui.visibility).toBe('visible'); expect(ui.focused).toBe(true); expect(ui.disabled).toBe(false);
  expect(ui.icon).toBe(phase === 'recording' ? 'stop' : 'progress_activity');
  await t.website.evaluate(async () => {
    window.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect((await inspectControl(t)).focused).toBe(true);
  expect(await t.website.evaluate(() => siteModal.querySelector('[data-local-web-voice]') === originalVoiceControl)).toBe(true);
  const current = await runtime(t); expect(current.targetId).toBe(owner.targetId); await current.detach();
  const reachable = await inspectControl(t);
  await t.website.mouse.click(reachable.button.x + 18, reachable.button.y + 18);
  await idle(t); await owner.detach();
  await expect(t.website.locator('#field')).toHaveValue(phase === 'recording' ? 'before confirmed fixtureafter' : 'before after');
  expect(await t.website.evaluate(() => siteClicks)).toBe(0);
  await expect(widget(t.website)).toBeHidden();
});

for (const phase of ['preparing', 'recording']) test(`stacked modal dialogs keep ${phase === 'preparing' ? 'Cancel' : 'Stop'} in the active modal regardless of DOM order`, async ({ voice: t }) => {
  test.skip(real); await placementPage(t);
  if (phase === 'preparing') await bootstrap(t, 'window.voiceDelay = 3000;');
  await start(t, '#field');
  if (phase === 'recording') await recording(t);
  else await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'preparing');
  await t.website.evaluate(() => {
    const first = document.createElement('dialog'), second = document.createElement('dialog');
    first.id = 'first-modal'; second.id = 'second-modal';
    first.textContent = 'First dialog'; second.textContent = 'Second dialog';
    document.body.append(first, second); first.showModal(); second.showModal();
  });
  const inModal = async id => {
    await expect(async () => {
      expect(await widget(t.website).evaluate(e => e.parentElement.id)).toBe(id);
      const rect = await widget(t.website).boundingBox();
      expect(await t.website.evaluate(rect => document.elementFromPoint(rect.x + 18, rect.y + 18)?.hasAttribute('data-local-web-voice'), rect)).toBe(true);
    }).toPass();
  };
  await inModal('second-modal');
  await t.website.locator('#second-modal').evaluate(e => e.close()); await inModal('first-modal');
  // Reverse opening order without changing DOM order. Neither the first nor
  // last matching :modal can identify the active dialog in both cases.
  await t.website.evaluate(() => {
    document.querySelector('#second-modal').showModal();
    document.querySelector('#first-modal').close(); document.querySelector('#first-modal').showModal();
  });
  await inModal('first-modal');
  await t.website.locator('#first-modal').evaluate(e => e.close()); await inModal('second-modal');
  await expect(widget(t.website)).toHaveCount(1);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', phase);
  if (phase === 'recording') {
    const owner = await runtime(t);
    await expect.poll(() => owner.evaluate(() => voiceResources.audioSamples)).toBeGreaterThan(8000);
    await owner.detach();
  }
  // Keyboard focus proves that the button is outside the inert subtree,
  // and a trusted click proves hit-testing reaches the same Cancel/Stop.
  await controlUI(t, true);
  expect((await controlUI(t)).focused).toBe(true);
  await mic(t.website); await idle(t);
  await expect(t.website.locator('#field')).toHaveValue(phase === 'recording' ? 'before confirmed fixtureafter' : 'before after');
  expect(await t.website.evaluate(() => siteClicks)).toBe(0);
});

test('clipped or covered focused targets hide idle placement until visible again', async ({ voice: t }) => {
  test.skip(real); await placementPage(t);
  await t.website.locator('#field').evaluate(e => {
    const clip = document.createElement('div'); clip.id = 'clip';
    clip.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:60px;overflow:hidden';
    e.before(clip); clip.append(e); e.focus({preventScroll:true});
  });
  await expect(widget(t.website)).toBeHidden();
  await t.website.locator('#clip').evaluate(e => { e.style.overflow = 'visible'; });
  await expect(widget(t.website)).toBeVisible();
  await occupyViewport(t);
  await expect(widget(t.website)).toBeHidden();
  await t.website.locator('#cover').evaluate(e => e.remove());
  await expect(widget(t.website)).toBeVisible(); await idle(t);
});

test('active viewport search finds a narrow interior pocket between controls', async ({ voice: t }) => {
  test.skip(real); await placementPage(t); await start(t, '#field'); await recording(t);
  await t.website.evaluate(() => {
    for (const [id,left,top,width,height] of [['top',0,0,480,231],['bottom',0,283,480,37],['left',0,231,337,52],['right',389,231,91,52]]) {
      const button = document.createElement('button'); button.id = id; button.textContent = 'Website';
      button.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;border:0;padding:0`;
      document.body.append(button);
    }
  });
  await expect(async () => {
    const ui = await clearOf(t, ['#top','#bottom','#left','#right']);
    expect(ui.button.x).toBeGreaterThanOrEqual(343); expect(ui.button.x).toBeLessThanOrEqual(347);
    expect(ui.button.y).toBeGreaterThanOrEqual(237); expect(ui.button.y).toBeLessThanOrEqual(241);
  }).toPass();
  await expect(t.website.locator('#field')).toBeFocused();
  await stop(t); await idle(t); expect(await t.website.evaluate(() => siteClicks)).toBe(0);
});


async function realEvidence(t) {
  if (!real) return {};
  const sourceSha256 = {};
  for (const name of ['extension/session.js', 'extension/media-source.js', 'extension/page-target.js',
    'extension/web-voice-runtime.js', 'extension/web-voice-background.js', 'extension/web-voice-content.js',
    'web/local-asr-core.js', 'web/transcription-nodes.js']) {
    const bytes = await readFile(name);
    expect((await readFile(path.join(t.root, name))).equals(bytes), `Use current source: ${name}`).toBe(true);
    sourceSha256[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return { sourceSha256, fixtureSha256: createHash('sha256').update(await readFile('tests/fixtures/ordinary-english.wav')).digest('hex'),
    model: 'ReazonSpeech ja-en + Silero VAD, CPU/WASM', assetManifest: JSON.parse(await readFile('web/vendor/manifest.json', 'utf8')) };
}

test('already granted input and textarea dictation stays in place, drains exactly once and closes offscreen resources', async ({ voice: t }, info) => {
  if (real) test.setTimeout(180000);
  await enable(t);
  const evidence = [];
  for (const [selector, prefix, suffix] of [['#first', 'before ', 'after'], ['#second', 'left ri', 'ght']]) {
    const pages = t.context.pages().length;
    await start(t, selector); await recording(t);
    await noVisibleRuntime(t, pages);
    await expect(t.website.locator(selector)).toBeFocused();
    expect(await t.website.locator(selector).evaluate(e => [e.selectionStart, e.selectionEnd])).toEqual([7, 7]);
    const r = await runtime(t);
    expect(await r.evaluate(() => ({ storage: !!chrome.storage, tabs: !!chrome.tabs, isolated: crossOriginIsolated }))).toEqual({ storage: false, tabs: false, isolated: true });
    await t.website.waitForTimeout(real ? 16000 : 650);
    await stop(t); await idle(t);
    const inserted = (await t.website.locator(selector).inputValue()).slice(prefix.length, -suffix.length);
    expect(inserted.trim()).toBeTruthy();
    expect(inserted).toBe([...new Map(r.finals.map(event => [event.id, event.text])).values()].filter(Boolean).join(''));
    if (!real) expect(inserted).toBe('confirmed fixture');
    expect(await t.website.locator(selector).inputValue()).toBe(prefix + inserted + suffix);
    expect(await t.website.evaluate(() => window.submits)).toBe(0); expect(r.errors).toEqual([]);
    await r.detach(); evidence.push({ selector, inserted, exactlyOnce: true, visibleRuntime: false });
  }
  await writeFile(info.outputPath('offscreen-voice-evidence.json'), JSON.stringify({ realModel: real,
    ...(await realEvidence(t)), browser: t.context.browser().version(), microphone: 'native gUM, fake device, CDP permission grant; native bubble buttons not automated',
    evidence, remoteRequests: t.remote, errors: t.pageErrors }, null, 2));
});

test('first grant uses explicit permission-only setup once; subsequent use creates no visible page', async ({ voice: t }) => {
  test.skip(real);
  await enable(t); await permission(t, 'prompt');
  const setupCreated = t.context.waitForEvent('page', { predicate: p => p.url().includes('web-voice-permission.html') });
  await start(t, '#first', null);
  const setup = await setupCreated;
  await expect(setup.getByRole('heading')).toHaveText('Allow microphone for in-page dictation');
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'preparing');
  expect(await setup.evaluate(() => navigator.permissions.query({ name: 'microphone' }).then(p => p.state))).toBe('prompt');
  expect(await setup.evaluate(() => voiceResources.streams.length)).toBe(0);
  expect(await setup.evaluate(() => voiceResources.workers.length)).toBe(0);
  // CDP controls the native permission decision. This does not click Chrome's
  // permission bubble; the setup button still calls real getUserMedia.
  await permission(t, 'granted');
  await setup.getByRole('button', { name: 'Allow microphone', exact: true }).click();
  await expect.poll(() => setup.isClosed()).toBe(true); await recording(t);
  await expect(t.website.locator('#first')).toBeFocused();
  await noVisibleRuntime(t); await t.website.waitForTimeout(600); await stop(t); await idle(t);
  const pages = t.context.pages().length;
  await start(t, '#second', null); await recording(t); await noVisibleRuntime(t, pages);
  await t.website.waitForTimeout(600); await stop(t); await idle(t);
});

for (const action of ['deny', 'cancel in page', 'close setup', 'navigate target']) test(`initial microphone setup: ${action} ends pending capture without inserting`, async ({ voice: t }) => {
  test.skip(real); await enable(t); await permission(t, 'prompt');
  const created = t.context.waitForEvent('page', { predicate: p => p.url().includes('web-voice-permission.html') });
  await start(t, '#first', null); const setup = await created;
  await expect(setup.locator('#allow-microphone')).toBeVisible();
  if (action === 'deny') { await permission(t, 'denied'); await setup.locator('#allow-microphone').click(); }
  if (action === 'cancel in page') { await t.website.bringToFront(); await mic(t.website); }
  if (action === 'close setup') await setup.close();
  if (action === 'navigate target') await t.website.reload();
  await idle(t); await expect.poll(() => setup.isClosed()).toBe(true);
  await expect(t.website.locator('#first')).toHaveValue('before after');
  if (action !== 'navigate target') await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
  // A denied existing grant is actionable and must not repeatedly open setup.
  if (action === 'deny') {
    await start(t, '#first', null); await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
    await idle(t); expect(t.context.pages().some(p => p.url().includes('web-voice-permission.html'))).toBe(false);
  }
});

test('multiple Web sessions share one offscreen document and stop independently with fixed targets', async ({ voice: t }) => {
  test.skip(real); await enable(t); await start(t); await recording(t);
  const r = await runtime(t), other = await t.context.newPage(); await other.goto(t.website.url() + '?other');
  const second = { ...t, website: other };
  await start(second); await recording(second); await noVisibleRuntime(t);
  expect(await r.evaluate(() => voiceResources.workers.filter(w => !w.released).length)).toBe(4);
  expect(await r.evaluate(() => voiceResources.streams.filter(s => s.active).length)).toBe(2);
  await t.website.locator('#second').focus(); await t.website.waitForTimeout(650);
  await stop(t); await recording(second);
  expect(await offscreenCount(t)).toBe(1);
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter');
  await expect(t.website.locator('#second')).toHaveValue('left right');
  expect(await r.evaluate(() => voiceResources.workers.filter(w => !w.released).length)).toBe(2);
  expect(await r.evaluate(() => voiceResources.streams.filter(s => s.active).length)).toBe(1);
  // OFF preserves finals already committed and does not drain provisional text.
  await t.library.locator('#web-voice-enabled').uncheck(); await idle(t);
  await expect(widget(other)).toHaveCount(0);
  const afterOff = await other.locator('#first').inputValue();
  expect(afterOff).not.toContain('pending fixture');
  await other.waitForTimeout(150); await expect(other.locator('#first')).toHaveValue(afterOff);
  await r.detach();
});

test('Live and Web overlap Ready, recording, Stop, restart, OFF and close independently', async ({ voice: t }, info) => {
  if (real) test.setTimeout(180000);
  await enable(t); await assignLiveMicrophone(t); const live = await openLive(t);
  await start(t); await recording(t); const r = await runtime(t);
  await expect(live.locator('#model-status')).toHaveText('Ready');
  await live.locator('#start').click(); await expectLiveRecording(live);
  const second = await openLive(t); await second.locator('#start').click(); await expectLiveRecording(second);
  await t.website.waitForTimeout(real ? 16000 : 650);
  await stop(t); await idle(t); await expectLiveRecording(live); await expectLiveRecording(second);
  const inserted = [...new Map(r.finals.map(event => [event.id, event.text])).values()].filter(Boolean).join('');
  expect(inserted.trim()).toBeTruthy(); await expect(t.website.locator('#first')).toHaveValue('before ' + inserted + 'after');
  await r.detach();
  await start(t, '#second'); await recording(t);
  await live.locator('#stop').click(); await expect(live.locator('#model-status')).toHaveText('Ready');
  const liveFinal = await live.evaluate(() => voiceFinals.at(-1)?.text);
  expect(liveFinal).toBeTruthy();
  await expect(live.locator('[data-display="display"] .display-content')).toHaveText(liveFinal);
  await recording(t); await expectLiveRecording(second);
  await live.locator('#start').click(); await expectLiveRecording(live);
  await second.close(); await recording(t);
  await t.library.locator('#web-voice-enabled').uncheck(); await idle(t); await expectLiveRecording(live);
  await enable(t); await start(t); await recording(t); await live.close(); await recording(t);
  await t.website.waitForTimeout(real ? 16000 : 650); await stop(t); await idle(t);
  await writeFile(info.outputPath('offscreen-overlap.json'), JSON.stringify({ browser: t.context.browser().version(), realModel: real,
    ...(await realEvidence(t)), peakSessions: 3, independentStartStopClose: true, webOffPreservesLive: true, liveFinal, liveOutputMatchesFinal: true, inserted, remoteRequests: t.remote }, null, 2));
});

for (const reason of ['worker failure', 'device end', 'field removal', 'navigation', 'tab close', 'cancel preparing']) test(`${reason} cleans one Web owner and preserves Live and another Web session`, async ({ voice: t }) => {
  test.skip(real); await enable(t); await assignLiveMicrophone(t);
  const live = await openLive(t); await permission(t, 'granted'); await live.locator('#start').click(); await expectLiveRecording(live);
  if (reason === 'cancel preparing') await bootstrap(t, 'window.voiceDelay = 1000;');
  await start(t);
  if (reason !== 'cancel preparing') await recording(t);
  const r = await runtime(t);
  const other = await t.context.newPage(); await other.goto(t.website.url() + '?peer');
  const peer = { ...t, website: other };
  await start(peer); await recording(peer);
  if (reason === 'worker failure') await r.evaluate(() => voiceResources.workers[0].dispatchEvent(new ErrorEvent('error', { message: 'Controlled model failure' })));
  if (reason === 'device end') await r.evaluate(() => voiceResources.streams[0].getTracks()[0].dispatchEvent(new Event('ended')));
  if (reason === 'field removal') await t.website.locator('#first').evaluate(e => e.remove());
  if (reason === 'navigation') await t.website.reload();
  if (reason === 'tab close') await t.website.close();
  if (reason === 'cancel preparing') {
    // Start a fresh owner with delayed load while peer remains in capture.
    await t.website.bringToFront(); await mic(t.website); // stop initial owner
    await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'idle');
    await start(t); await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'preparing'); await mic(t.website);
  }
  if (!['navigation', 'tab close'].includes(reason)) await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
  await expect.poll(() => r.evaluate(() => voiceResources.workers.filter(w => !w.released).length)).toBe(2);
  await expect.poll(() => r.evaluate(() => voiceResources.streams.filter(s => s.active).length)).toBe(1);
  await recording(peer); await expectLiveRecording(live);
  if (!['field removal', 'tab close', 'cancel preparing'].includes(reason)) await expect(t.website.locator('#first')).toHaveValue('before after');
  await stop(peer); await idle(t); await expectLiveRecording(live); await r.detach();
});

for (const reason of ['host permission', 'microphone permission', 'offscreen loss', 'service worker restart', 'extension reload']) test(`${reason} rejects late events and leaves no offscreen capture`, async ({ voice: t }) => {
  test.skip(real); await enable(t); await start(t); await recording(t); const r = await runtime(t);
  if (reason === 'host permission') await t.library.evaluate(() => chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] }));
  if (reason === 'microphone permission') await permission(t, 'denied');
  if (reason === 'offscreen loss') await t.library.evaluate(() => chrome.offscreen.closeDocument());
  if (reason === 'service worker restart') {
    const inspector = await t.context.newCDPSession(t.library);
    let version; const stopped = new Set();
    inspector.on('ServiceWorker.workerVersionUpdated', event => {
      for (const item of event.versions) if (item.runningStatus === 'stopped') stopped.add(item.versionId);
      const found = event.versions.findLast(v => v.scriptURL === t.url + 'background.js' && v.runningStatus === 'running' && v.status === 'activated');
      if (found) version = found;
    });
    await inspector.send('ServiceWorker.enable');
    await expect.poll(() => version?.versionId).toBeTruthy();
    const versionId = version.versionId;
    await inspector.send('ServiceWorker.stopWorker', { versionId });
    await expect.poll(() => stopped.has(versionId)).toBe(true);
    await t.library.evaluate(() => chrome.runtime.sendMessage({ type: 'web-voice-reconcile' }));
    await inspector.detach();
  }
  if (reason === 'extension reload') {
    await t.cdp.send('Extensions.loadUnpacked', { path: t.root });
    t.library = await t.context.newPage(); await t.library.goto(t.url + 'graph-library.html');
  }
  await idle(t); await expect(t.website.locator('#first')).toHaveValue('before after');
  await t.website.waitForTimeout(200); await expect(t.website.locator('#first')).toHaveValue('before after'); await r.detach();
  if (!['host permission', 'extension reload', 'service worker restart'].includes(reason)) await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
  if (reason === 'service worker restart' || reason === 'offscreen loss') {
    await start(t); await recording(t); await t.website.waitForTimeout(650); await stop(t); await idle(t);
  }
});

test('shared ASR processing updates the next Web execution without resaving its parent or hot-swapping active dictation', async ({ voice: t }) => {
  test.skip(real);
  const parentBefore = await t.library.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const { graphNode, edge } = await import('./graph.js');
    const { extractSubgraph } = await import('./subgraphs.js');
    const store = new GraphLibrary(localStorage), entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    const graph = structuredClone(entry.graph), formatter = graphNode('TextFormatter', 'format'); formatter.settings.template = 'Before: {1}';
    graph.nodes.push(formatter); graph.edges[1] = edge('asr', 'final', 'format', 'input1'); graph.edges.push(edge('format', 'text', 'field', 'text'));
    const extracted = extractSubgraph(graph, ['asr', 'format'], 'shared-asr');
    await store.create({ id: 'shared-asr', kind: 'subgraph', name: 'Shared dictation processing', graph: extracted.shared });
    const saved = await store.save(id, entry.revision, extracted.parent);
    return saved.graphs.find(entry => entry.id === id);
  }, t.graphId);
  await enable(t); await start(t); await recording(t);
  await t.library.evaluate(async () => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === 'shared-asr'), graph = structuredClone(entry.graph);
    graph.nodes.find(node => node.type === 'TextFormatter').settings.template = 'After: {1}';
    await new GraphLibrary(localStorage).save(entry.id, entry.revision, graph);
  });
  await t.website.waitForTimeout(650); await stop(t); await idle(t);
  await expect(t.website.locator('#first')).toHaveValue('before Before: confirmed fixtureafter');
  await t.website.locator('#first').fill('before after');
  await start(t); await recording(t); await t.website.waitForTimeout(650); await stop(t); await idle(t);
  await expect(t.website.locator('#first')).toHaveValue('before After: confirmed fixtureafter');
  expect(await t.library.evaluate(async id => {
    const { readLibrary } = await import('./graph-library.js'); return readLibrary(localStorage).graphs.find(entry => entry.id === id);
  }, t.graphId)).toEqual(parentBefore);
});

test('snapshots, authenticated routing, replay rejection and model failures retain target safeguards', async ({ voice: t }) => {
  test.skip(real); await enable(t);
  await bootstrap(t, `const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = options => { const port = connect(options), send = port.postMessage.bind(port);
      if (options.name.startsWith('web-voice-output:')) port.postMessage = m => { send(m); if (m.action === 'append') send(m); }; return port; };`);
  await start(t); await recording(t);
  expect(await t.library.evaluate(async () => {
    const { PageConnection } = await import('./page-target.js');
    const tab = (await chrome.tabs.query({ url: 'http://127.0.0.1/*' }))[0];
    const [document] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => true });
    const connection = new PageConnection({ tabId: tab.id, documentId: document.documentId, portName: 'web-voice-output', capability: crypto.randomUUID() });
    try { await connection.request('append', { sequence: 0, text: 'spoofed' }); return false; } catch { return true; } finally { connection.close(); }
  })).toBe(true);
  await t.library.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { defaultGraph } = await import('./graph.js');
    const entry = readLibrary(localStorage).graphs.find(e => e.id === id);
    await new GraphLibrary(localStorage).save(id, entry.revision, defaultGraph());
  }, t.graphId);
  await t.website.waitForTimeout(650); await mic(t.website); await idle(t);
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter');
  await expect(widget(t.website)).toHaveCount(0);
  await t.library.reload();
  await expect(t.library.locator('#web-voice-status')).toContainText('No compatible graphs');
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter');
});

test('basic editable, continued manual editing and idle target refresh stay bound to the selected field', async ({ voice: t }) => {
  test.skip(real); await enable(t); await start(t, '#basic'); await recording(t);
  await t.website.waitForTimeout(650); await stop(t); await idle(t);
  await expect(t.website.locator('#basic')).toHaveText('hello confirmed fixtureworld');
  await start(t); await recording(t); await t.website.keyboard.type('manual ');
  await t.website.waitForTimeout(650); await stop(t); await idle(t);
  await expect(t.website.locator('#first')).toHaveValue('before manual confirmed fixtureafter');
  await start(t); await recording(t); await t.website.locator('#second').focus();
  await t.website.waitForTimeout(650); await stop(t); await idle(t);
  await t.website.locator('#second').evaluate(e => e.setSelectionRange(5, 5)); await mic(t.website); await recording(t);
  await t.website.waitForTimeout(650); await stop(t); await idle(t);
  await expect(t.website.locator('#second')).toHaveValue('left confirmed fixtureright');
});

test('missing verified translation cache fails before microphone capture and never downloads weights', async ({ voice: t }) => {
  test.skip(real); await enable(t);
  await t.library.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { graphNode, edge } = await import('./graph.js');
    const entry = readLibrary(localStorage).graphs.find(e => e.id === id), graph = entry.graph;
    graph.nodes.push(graphNode('OpusMtJaEn', 'translate')); graph.edges[1] = edge('asr', 'final', 'translate', 'text'); graph.edges.push(edge('translate', 'text', 'field', 'text'));
    await new GraphLibrary(localStorage).save(id, entry.revision, graph);
  }, t.graphId);
  await start(t); await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error'); await idle(t);
  await expect(widget(t.website)).toHaveAttribute('title', /Models|cached|files|fetch/i);
  await expect(t.website.locator('#first')).toHaveValue('before after');
});

test('rapid preparation cancellation never lets an old owner stop or insert into its replacement', async ({ voice: t }) => {
  test.skip(real); await enable(t); await bootstrap(t, 'window.voiceDelay = 600;');
  for (let i = 0; i < 3; i++) {
    await start(t); await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'preparing'); await mic(t.website);
    await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
  }
  await start(t); await recording(t); await noVisibleRuntime(t);
  await t.website.waitForTimeout(650); await stop(t); await idle(t);
  await expect(t.website.locator('#first')).toHaveValue('before confirmed fixtureafter');
});

test('all visual states preserve focus and keep keyboard Stop visible when the target scrolls offscreen', async ({ voice: t }) => {
  test.skip(real); await enable(t); await bootstrap(t, 'window.voiceDelay = 700;');
  await start(t);
  let ui = await controlUI(t); expectIcon(ui, 'progress_activity'); expect(ui.label).toContain('cancel');
  await expect(t.website.locator('#first')).toBeFocused();
  await recording(t); ui = await controlUI(t); expectIcon(ui, 'stop'); expect(ui.status).toBe('Recording');
  await t.website.evaluate(() => { for (const e of document.querySelectorAll('input,textarea,button,[contenteditable]')) e.tabIndex = -1; document.body.style.minHeight = '2000px'; scrollTo(0,1000); });
  await expect(widget(t.website)).toBeVisible(); await controlUI(t, true); await t.website.keyboard.press('Enter');
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'stopping');
  ui = await controlUI(t); expectIcon(ui, 'progress_activity'); expect(ui.disabled).toBe(true);
  await idle(t); await t.website.evaluate(() => scrollTo(0,0));
  await start(t, '#first', 'denied'); await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error'); await idle(t);
  ui = await controlUI(t); expectIcon(ui, 'error'); expect(ui.title).toContain('Chrome');
});

test('back-forward cache restores idle controls without resuming capture or bypassing consent', async ({ voice: t }) => {
  test.skip(real); await enable(t); await start(t); await recording(t);
  await t.website.evaluate(() => {
    window.cachedVoiceDocument = true;
    window.addEventListener('pageshow', event => { window.voiceRestored = event.persisted; });
  });
  const original = t.website.url(); await t.website.goto(original + '?away'); await idle(t);
  await t.website.goBack({ waitUntil: 'commit' });
  await expect.poll(() => t.website.evaluate(() => window.cachedVoiceDocument && window.voiceRestored)).toBe(true);
  await t.website.locator('#second').focus(); await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'idle');
  await expect(t.website.locator('#first')).toHaveValue('before after');
  await start(t, '#second'); await recording(t);
  await t.website.locator('#second').evaluate(e => e.setSelectionRange(5, 5));
  await t.website.waitForTimeout(650); await stop(t); await idle(t);
  await expect(t.website.locator('#second')).toHaveValue('left confirmed fixtureright');
  await t.website.goto(original + '?away-again'); await t.library.locator('#web-voice-enabled').uncheck();
  await t.website.goBack({ waitUntil: 'commit' });
  await expect.poll(() => t.website.evaluate(() => window.voiceRestored)).toBe(true);
  await t.website.locator('#first').focus(); await expect(widget(t.website)).toHaveCount(0); await idle(t);
});

test('cancel while stopping releases only that owner without draining into a removed target', async ({ voice: t }) => {
  test.skip(real); await enable(t); await bootstrap(t, 'window.voiceDelay = 900;');
  await start(t); await recording(t); const r = await runtime(t);
  const other = await t.context.newPage(); await other.goto(t.website.url() + '?peer'); const peer = { ...t, website: other };
  await start(peer); await recording(peer);
  const previous = await t.website.locator('#first').inputValue();
  await t.website.bringToFront(); await mic(t.website); await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'stopping');
  await t.website.locator('#first').evaluate(e => { window.removedVoiceField = e; e.remove(); });
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error');
  await expect.poll(() => r.evaluate(() => voiceResources.workers.filter(w => !w.released).length)).toBe(2);
  await expect.poll(() => r.evaluate(() => voiceResources.streams.filter(s => s.active).length)).toBe(1);
  expect(await t.website.evaluate(() => removedVoiceField.value)).toBe(previous);
  await recording(peer); await stop(peer); await idle(t); await r.detach();
});

test('device startup failure is actionable and preserves another Web owner', async ({ voice: t }) => {
  test.skip(real); await enable(t);
  await bootstrap(t, `const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let requests = 0; navigator.mediaDevices.getUserMedia = options => ++requests === 2
      ? Promise.reject(new DOMException('Controlled missing microphone', 'NotFoundError')) : nativeGetUserMedia(options);`);
  await start(t); await recording(t); const r = await runtime(t);
  const other = await t.context.newPage(); await other.goto(t.website.url() + '?device'); const peer = { ...t, website: other };
  await start(peer); await expect(widget(other)).toHaveAttribute('data-voice-state', 'error');
  await expect(widget(other)).toHaveAttribute('title', /microphone|device/i); await recording(t);
  await expect.poll(() => r.evaluate(() => voiceResources.workers.filter(w => !w.released).length)).toBe(2);
  await expect(other.locator('#first')).toHaveValue('before after');
  await t.website.waitForTimeout(650); await stop(t); await idle(t); await r.detach();
});

async function graphMenu(t) {
  const cdp = await t.context.newCDPSession(t.website);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = node => node.attributes?.includes('data-local-web-voice') ? node :
      [...node.children || [], ...node.shadowRoots || []].map(find).find(Boolean);
    const host = find(root); if (!host) return [];
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: host.shadowRoots[0].backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true,
      functionDeclaration: `function() { return [...this.querySelectorAll('[role="menuitemradio"]')].map(item => {
        const r = item.getBoundingClientRect(); return { name:item.textContent, selected:item.getAttribute('aria-checked') === 'true',
          focused:this.activeElement === item, x:r.x, y:r.y, width:r.width, height:r.height }; }); }` });
    return result.value;
  } finally { await cdp.detach(); }
}
async function rightMic(t) {
  const box = await widget(t.website).boundingBox();
  await t.website.mouse.click(box.x + 18, box.y + 18, { button: 'right' });
}
async function addVoice(t, name, { disconnected = false, prefix = '' } = {}) {
  return t.library.evaluate(async ({ name, disconnected, prefix }) => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { graphNode, edge } = await import('./graph.js');
    const graph = structuredClone(readLibrary(localStorage).graphs.find(e => e.name === 'Dictation').graph);
    if (disconnected) graph.edges.pop();
    if (prefix) {
      const formatter = graphNode('TextFormatter', 'formatter'); formatter.settings.template = prefix + '{1}';
      graph.nodes.push(formatter); graph.edges[1] = edge('asr', 'final', 'formatter', 'input1');
      graph.edges.push(edge('formatter', 'text', 'field', 'text'));
    }
    const next = await new GraphLibrary(localStorage).create({ name, graph }); return next.graphs.at(-1).id;
  }, { name, disconnected, prefix });
}
const savedDefault = t => t.library.evaluate(async () => (await chrome.storage.local.get('web-microphone-default-v1'))['web-microphone-default-v1']);

test('one automatic graph: right-click selection, keyboard and outside dismissal preserve field and caret without capture', async ({ voice: t }) => {
  await enable(t); await t.website.bringToFront();
  await t.website.locator('#first').focus(); await t.website.locator('#first').evaluate(e => e.setSelectionRange(3, 7));
  await expect(widget(t.website)).toBeVisible(); await idle(t);
  await rightMic(t);
  expect((await graphMenu(t)).map(({ name, selected }) => ({ name, selected }))).toEqual([{ name: 'Dictation', selected: true }]);
  await t.website.keyboard.press('Escape'); expect(await graphMenu(t)).toEqual([]);
  expect(await t.website.locator('#first').evaluate(e => [document.activeElement === e, e.selectionStart, e.selectionEnd])).toEqual([true, 3, 7]);
  await controlUI(t, true); await t.website.keyboard.press('Shift+F10'); expect(await graphMenu(t)).toHaveLength(1);
  await t.website.keyboard.press('Enter'); await expect.poll(() => savedDefault(t)).toBe(t.graphId); await idle(t);
  expect(await graphMenu(t)).toEqual([]); await expect(t.website.locator('#first')).toHaveValue('before after');
  expect(await t.website.evaluate(() => [submits, edits.length])).toEqual([0, 0]);
  await rightMic(t); await t.website.locator('#second').click(); expect(await graphMenu(t)).toEqual([]);
  await expect(t.website.locator('#second')).toBeFocused();
  // Menu dismissal with Tab returns to the ordinary tab order.
  await controlUI(t, true); await t.website.keyboard.press('Shift+F10'); await t.website.keyboard.press('Tab');
  expect(await graphMenu(t)).toEqual([]);
  await t.website.locator('#basic').focus();
  await t.website.locator('#basic').evaluate(e => {
    const range = document.createRange(); range.setStart(e.firstChild, 3); range.collapse(true);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await rightMic(t); await t.website.keyboard.press('Escape');
  expect(await t.website.locator('#basic').evaluate(e => [document.activeElement === e, getSelection().anchorOffset])).toEqual([true, 3]);
});

test('multiple graphs require a choice; selection persists across tabs and reloads without capture; running sessions retain snapshots', async ({ voice: t }, info) => {
  test.skip(real);
  const b = await addVoice(t, 'Formatted dictation', { prefix: 'B: ' });
  await addVoice(t, 'Disconnected microphone', { disconnected: true });
  await t.library.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js'); await new GraphLibrary(localStorage).assign('webVoice', null);
    await chrome.storage.local.remove('web-microphone-default-v1');
  });
  await t.library.reload(); await enable(t); await t.website.bringToFront(); await t.website.locator('#first').focus();
  await expect(widget(t.website)).toBeVisible(); await mic(t.website);
  await expect(widget(t.website)).toHaveAttribute('title', /choose a voice graph/); await idle(t);
  await rightMic(t);
  expect((await graphMenu(t)).map(({ name, selected }) => ({ name, selected }))).toEqual([
    { name: 'Dictation', selected: false }, { name: 'Formatted dictation', selected: false }]);
  await t.website.screenshot({ path: info.outputPath('mic-graph-menu.png') });
  await t.website.keyboard.press('End'); await t.website.keyboard.press('Enter');
  await expect.poll(() => savedDefault(t)).toBe(b); await idle(t);
  await expect(t.website.locator('#first')).toHaveValue('before after');
  const second = await t.context.newPage(); await second.goto(t.website.url());
  const peer = { ...t, website: second };
  await second.locator('#first').focus(); await expect(widget(second)).toBeVisible(); await rightMic(peer);
  expect((await graphMenu(peer)).filter(x => x.selected).map(x => x.name)).toEqual(['Formatted dictation']);
  await second.keyboard.press('Escape');
  await t.website.reload(); await start(t); await recording(t);
  await rightMic(t); expect(await graphMenu(t)).toEqual([]);
  await t.library.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { defaultGraph } = await import('./graph.js');
    const entry = readLibrary(localStorage).graphs.find(e => e.id === id);
    await new GraphLibrary(localStorage).save(id, entry.revision, defaultGraph());
  }, b);
  // A sole remaining candidate becomes the next default; the active graph is frozen.
  await expect.poll(() => savedDefault(t)).toBe(t.graphId);
  await t.website.waitForTimeout(650); await stop(t); await idle(t);
  await expect(t.website.locator('#first')).toHaveValue('before B: confirmed fixtureafter');
  await rightMic(t); expect((await graphMenu(t)).map(x => x.name)).toEqual(['Dictation']); await t.website.keyboard.press('Escape');
});

test('preparing and stopping reject right-click and keyboard switching until cleanup', async ({ voice: t }) => {
  test.skip(real); await addVoice(t, 'Another dictation'); await enable(t); await idle(t);
  await bootstrap(t, 'window.voiceDelay = 700;');
  await start(t); await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'preparing');
  await rightMic(t); expect(await graphMenu(t)).toEqual([]);
  await controlUI(t, true); await t.website.keyboard.press('Shift+F10'); expect(await graphMenu(t)).toEqual([]);
  await mic(t.website); await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'error'); await idle(t);
  expect(await savedDefault(t)).toBe(t.graphId);
  await start(t); await recording(t); await t.website.waitForTimeout(650); await mic(t.website);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'stopping'); await rightMic(t); expect(await graphMenu(t)).toEqual([]);
  await expect(widget(t.website)).toHaveAttribute('data-voice-state', 'idle'); await idle(t);
  expect(await savedDefault(t)).toBe(t.graphId);
});

test('deleting defaults requires reselection for multiple candidates; zero graphs hides icons while opt-in stays ON', async ({ voice: t }) => {
  await addVoice(t, 'Second'); const c = await addVoice(t, 'Third');
  await enable(t); await t.website.bringToFront(); await t.website.locator('#first').focus(); await expect(widget(t.website)).toBeVisible();
  await t.library.evaluate(async id => { const { GraphLibrary } = await import('./graph-library.js'); await new GraphLibrary(localStorage).delete(id); }, t.graphId);
  await expect.poll(() => savedDefault(t)).toBe(null);
  await mic(t.website); await expect(widget(t.website)).toHaveAttribute('title', /choose a voice graph/); await idle(t);
  await rightMic(t); expect((await graphMenu(t)).map(x => x.selected)).toEqual([false, false]);
  const item = (await graphMenu(t)).find(x => x.name === 'Third');
  await t.website.mouse.click(item.x + item.width / 2, item.y + item.height / 2); await expect.poll(() => savedDefault(t)).toBe(c);
  await t.library.evaluate(async () => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js'), { defaultGraph } = await import('./graph.js');
    const store = new GraphLibrary(localStorage);
    for (const entry of readLibrary(localStorage).graphs.filter(e => e.name !== 'Live transcription')) await store.save(entry.id, entry.revision, defaultGraph());
  });
  await expect(widget(t.website)).toHaveCount(0); await expect(t.library.locator('#web-voice-enabled')).toBeChecked();
  await t.library.reload();
  await expect(t.library.locator('#web-voice-status')).toContainText('No compatible graphs');
});

test('the selected default and explicit consent survive a full browser restart', async ({ voice: t }) => {
  const b = await addVoice(t, 'Saved default'); await enable(t);
  await t.website.bringToFront(); await t.website.locator('#first').focus(); await expect(widget(t.website)).toBeVisible();
  await rightMic(t); await t.website.keyboard.press('End'); await t.website.keyboard.press('Enter');
  await expect.poll(() => savedDefault(t)).toBe(b); await idle(t);
  await t.restart(); await expect(t.library.locator('#web-voice-enabled')).toBeChecked();
  await t.website.locator('#first').focus(); await expect(widget(t.website)).toBeVisible(); await rightMic(t);
  await expect.poll(async () => (await graphMenu(t)).filter(x => x.selected).map(x => x.name)).toEqual(['Saved default']);
  await t.website.keyboard.press('Escape'); await idle(t);
  await expect(t.website.locator('#first')).toHaveValue('before after');
});

test('zero compatible graphs can stay explicitly enabled; adding a saved path reveals the mic without reauthorizing', async ({ voice: t }) => {
  await t.library.evaluate(async id => { const { GraphLibrary } = await import('./graph-library.js'); await new GraphLibrary(localStorage).delete(id); }, t.graphId);
  await t.library.reload(); await t.library.locator('#web-voice-enabled').click();
  await t.library.getByRole('button', { name: 'Continue to website permission' }).click();
  await expect(t.library.locator('#web-voice-enabled')).toBeChecked();
  await expect(t.library.locator('#web-voice-status')).toContainText('No compatible graphs');
  await t.website.bringToFront(); await t.website.locator('#first').focus(); await expect(widget(t.website)).toHaveCount(0);
  await t.library.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js'), { graphNode, edge } = await import('./graph.js');
    await new GraphLibrary(localStorage).create({ name: 'New dictation', graph: { version: 15,
      nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')],
      edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'field', 'text')] } });
  });
  await expect(widget(t.website)).toBeVisible(); await rightMic(t);
  expect((await graphMenu(t)).map(({ name, selected }) => ({ name, selected }))).toEqual([{ name: 'New dictation', selected: true }]);
  await t.website.keyboard.press('Escape'); await idle(t);
});

test('Web microphone remains revocable while the graph library needs storage recovery', async ({ voice: t }) => {
  test.skip(real, 'Storage recovery does not require real inference.');
  await enable(t); await start(t); await recording(t);
  await t.library.evaluate(() => localStorage.setItem('processing-graph-library-v1', '{broken library'));
  await t.library.reload();
  await expect(t.library.locator('#errors')).not.toBeEmpty();
  await expect(t.library.locator('#web-voice-enabled')).toBeEnabled();
  await expect(t.library.locator('#web-voice-enabled')).toBeChecked();
  await t.library.locator('#web-voice-enabled').uncheck(); await idle(t);
  await expect(widget(t.website)).toHaveCount(0);
  expect(await t.library.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe('{broken library');
});
