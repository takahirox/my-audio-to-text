import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

function wav(frequency) {
  const length = 48000 * 2, buffer = Buffer.alloc(44 + length * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(48000, 24);
  buffer.writeUInt32LE(96000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) buffer.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * frequency * i / 48000)), 44 + i * 2);
  return buffer;
}
const fixture = `<title>Controlled input/output fixture</title>
<button id="play">Play both</button><audio id="first" src="/440.wav" loop controls></audio><audio id="second" src="/880.wav" loop controls></audio>
<form id="ordinary"><label>Notes <input id="focused" value="manual"></label><textarea id="chosen">existing</textarea><button type="submit">Submit</button></form>
<div id="editable" contenteditable="true">draft</div><input id="search" type="search" value="query"><button id="activate-comment">Add a comment</button><div id="comment-shell"></div><input id="password" type="password"><input id="card" autocomplete="cc-number"><input id="iban" name="iban"><input id="hidden" hidden><input id="readonly" readonly>
<div id="shadow-host"></div><form><label>Security code<input id="security"></label><input type="password"></form><iframe src="/frame"></iframe>
<script>document.querySelector('#play').onclick=()=>Promise.all([...document.querySelectorAll('audio')].map(a=>a.play()));
document.querySelector('#activate-comment').onclick=()=>{document.querySelector('#comment-shell').innerHTML='<div id="comment" contenteditable="true" role="textbox" aria-label="Comment"><span></span><br></div>'; document.querySelector('#comment').focus()};
document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<input id="shadow-field">';
window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++}; window.edits=[];
document.addEventListener('input',e=>edits.push(e.target.id));</script>`;
const test = base.extend({
  targets: async ({}, use) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'extension-targets-')), root = path.join(temporary, 'bundle');
    const server = createServer((req, res) => {
      if (req.url.endsWith('.wav')) { const body = wav(req.url.includes('880') ? 880 : 440); res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': body.length }); res.end(body); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(req.url === '/frame' ? '<input id="frame-field">' : fixture); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let context;
    try {
      await cp(path.resolve('dist/chrome-extension'), root, { recursive: true, filter: source => !source.includes(`${path.sep}vendor`) });
      for (const role of ['sherpa', 'silero']) await writeFile(path.join(root, `web/${role}-worker.js`), `
        self.onmessage=({data})=>{
          if(data.type==='load')postMessage({type:'ready'});
          if(data.type==='vad-audio')postMessage({type:'vad',session:data.session,frames:[{audio:data.audio,speaking:data.audio.some(x=>Math.abs(x)>.001)}]});
          if(data.type==='vad-stop')postMessage({type:'vad-stopped',session:data.session});
          if(data.type==='decode'){postMessage({type:data.final?'final':'partial',text:data.final?'confirmed fixture':'pending fixture',session:data.session,id:data.id});postMessage({type:'decoded',session:data.session});}
        };`);
      for (const name of ['opus-mt-worker.js', 'opus-mt-en-ja-worker.js']) await writeFile(path.join(root, 'web', name), `self.onmessage=({data})=>{if(data.type==='load')postMessage({type:'ready',id:data.id});if(data.type==='translate')postMessage({type:'result',id:data.id,texts:['translated '+data.text]});if(data.type==='drain')postMessage({type:'drained',id:data.id});};`);
      context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: false,
        ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'], args: ['--enable-unsafe-extension-debugging', '--use-fake-device-for-media-stream'] });
      const cdp = await context.browser().newBrowserCDPSession(), { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
      const page = await context.newPage(); await page.goto(`chrome-extension://${id}/extension/recorder.html`);
      await page.evaluate(async () => {
        const { defaultGraph, saveGraph } = await import('./graph.js'); saveGraph(localStorage, defaultGraph({ enabled: false }));
        const { SpeechToTextNode } = await import('../web/transcription-nodes.js'), original = SpeechToTextNode.prototype.start;
        SpeechToTextNode.prototype.start = function(context) { window.activeSpeech = this; return original.call(this, context); };
        const { ExtensionTabAudioNode } = await import('./tab-audio-node.js'), capture = ExtensionTabAudioNode.prototype.start;
        ExtensionTabAudioNode.prototype.start = function(context) {
          window.captured = []; const emit = context.emit;
          return capture.call(this, { ...context, emit(port, value) { if (window.captured.length < 16000 * 4) window.captured.push(...value); emit(port, value); } });
        };
      });
      const website = await context.newPage(); await website.goto(`http://127.0.0.1:${server.address().port}/`);
      // Live lives in its own actual browser popup, as in toolbar-created UX.
      await page.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.windows.create({ tabId: tab.id, type: 'popup', width: 620, height: 800 }); });
      // Playwright enables focus emulation by default (every page appears focused).
      // Disable it to exercise actual browser focus and trusted blur/focus events.
      for (const target of [page, website]) await (await context.newCDPSession(target)).send('Emulation.setFocusEmulationEnabled', { enabled: false });
      const invoke = async (target = website) => {
        await target.bringToFront(); // Match an actual toolbar click on this tab.
        const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
        await cdp.send('Extensions.triggerAction', { id, targetId: targetInfos.find(info => info.url === target.url()).targetId });
        if (!page.isClosed()) await page.waitForTimeout(100);
      };
      const graph = async ({ source = 'ChromeTabAudio', outputs = [], translation = false, live = true } = {}) => {
        await page.evaluate(async ({ source, outputs, translation, live }) => {
          const { defaultGraph, graphNode, edge, saveGraph, GRAPH_KEY } = await import('./graph.js');
          const graph = defaultGraph({ enabled: translation }); graph.nodes[0].type = source;
          if (!live) {
            const views = graph.nodes.filter(node => ['TranscriptView', 'TranslationView'].includes(node.type)).map(node => node.id);
            graph.nodes = graph.nodes.filter(node => !views.includes(node.id)); graph.edges = graph.edges.filter(edge => !views.includes(edge.to[0]));
          }
          for (const [id, type, translated] of outputs) {
            const textId = id + '-text';
            graph.nodes.push(graphNode(type, id), graphNode(translated ? 'TranslatedFinalText' : 'FinalText', textId));
            graph.edges.push(edge(translated ? 'translation' : 'speech', 'final', textId, 'final'), edge(textId, 'text', id, 'text'));
          }
          saveGraph(localStorage, graph); window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
        }, { source, outputs, translation, live });
      };
      await page.locator('#targets').evaluate(element => { element.open = true; });
      await use({ context, cdp, id, page, website, invoke, graph, origin: `chrome-extension://${id}`, webOrigin: `http://127.0.0.1:${server.address().port}` });
    } finally { await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
  },
});
const row = (page, id) => page.locator(`[data-target-node="${id}"]`);
async function stop(t) {
  if (await t.page.locator('#stop').isEnabled()) { await t.page.locator('#stop').click(); await expect(t.page.locator('#start')).toBeEnabled(); }
}
async function emit(t, id, text, type = 'final') { await t.page.evaluate(({ id, text, type }) => window.activeSpeech.receiveEvent({ type, id, text }), { id, text, type }); }

test('toolbar automatically readies one TEXT sink; Live popup focus, input/search/textarea, order, once, Stop and Cancel', async ({ targets: t }) => {
  await t.graph({ outputs: [['out', 'FocusedInputTextOutputNode']] });
  await t.website.locator('#focused').click(); await t.invoke();
  await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await expect(t.page.locator('#target-status')).toContainText('connected and authorized');
  await expect(t.page.getByRole('button', { name: /Authorize capture|Pick field|Use next toolbar/ })).toHaveCount(0);
  await t.page.bringToFront();
  await expect.poll(() => t.website.evaluate(() => document.hasFocus())).toBe(false);
  await emit(t, 1, 'one'); await emit(t, 1, 'duplicate'); await emit(t, 0, 'stale'); await emit(t, 2, 'two');
  await expect(t.website.locator('#focused')).toHaveValue('manual one two');
  await expect(t.page.locator('#final')).toContainText('two');
  await t.website.bringToFront(); await t.website.locator('#search').click();
  await t.website.locator('#search').evaluate(e => e.setSelectionRange(0, 5));
  await t.page.bringToFront(); await emit(t, 3, 'search'); await expect(t.website.locator('#search')).toHaveValue('query search');
  await t.website.bringToFront(); await t.website.locator('#chosen').click(); await t.page.bringToFront();
  await emit(t, 4, 'notes'); await expect(t.website.locator('#chosen')).toHaveValue('existing notes');
  await stop(t); await expect(t.website.locator('#chosen')).toHaveValue('existing notes');
  expect(await t.website.evaluate(() => window.submits)).toBe(0);
  await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await emit(t, 1, 'fresh'); await expect(t.website.locator('#chosen')).toHaveValue('existing notes fresh');
  await t.page.locator('#cancel-session').click(); await emit(t, 2, 'late');
  await expect(t.website.locator('#chosen')).toHaveValue('existing notes fresh');
  expect(await t.page.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter(tab => tab.status === 'active').length)).toBe(0);
});

test('first toolbar-created Live popup prepares a pre-focused editor before window blur', async ({ targets: t }) => {
  await t.graph({ outputs: [['out', 'FocusedInputTextOutputNode']] });
  await t.page.close(); await t.website.bringToFront();
  await t.website.locator('#play').click(); await t.website.locator('#chosen').click();
  await t.website.evaluate(() => window.addEventListener('blur', () => document.activeElement.blur()));
  const opening = t.context.waitForEvent('page'); await t.invoke(); const live = await opening;
  await live.waitForURL(/extension\/recorder.html/);
  await (await t.context.newCDPSession(live)).send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await expect(live.locator('#status')).toHaveText('Transcription active');
  await expect(live.locator('#target-status')).toContainText('connected and authorized');
  await expect.poll(() => t.website.evaluate(() => document.hasFocus())).toBe(false);
  await expect(live.locator('#partial')).toHaveText('pending fixture');
  await live.locator('#stop').click(); await expect(live.locator('#status')).toContainText('Stopped');
  await expect(t.website.locator('#chosen')).toHaveValue('existing confirmed fixture');
  await expect(live.locator('#final')).toHaveText('confirmed fixture\n');
});

test('no focus skips without guessing; dynamic YouTube-style comment activation and focus changes route later values', async ({ targets: t }) => {
  await t.graph({ outputs: [['out', 'FocusedInputTextOutputNode']] }); await t.invoke();
  await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await emit(t, 1, 'no target'); await expect(t.page.locator('#target-status')).toContainText('Insertion skipped: Focus');
  await expect(t.website.locator('#focused')).toHaveValue('manual'); await expect(t.page.locator('#final')).toContainText('no target');
  await t.website.bringToFront(); await t.website.locator('#activate-comment').click();
  await t.page.bringToFront(); await emit(t, 2, '<b>plain</b>');
  await expect(t.website.locator('#comment')).toHaveText('<b>plain</b>'); expect(await t.website.locator('#comment b').count()).toBe(0);
  await t.website.bringToFront(); await t.website.locator('#editable').click(); await t.page.bringToFront();
  await emit(t, 3, 'next'); await expect(t.website.locator('#editable')).toHaveText('draft next');
  // Explicit blur in the page invalidates the previous focus; Live cannot revive it.
  await t.website.bringToFront(); await t.website.locator('#editable').evaluate(e => e.blur()); await t.page.bringToFront();
  await emit(t, 4, 'never'); await expect(t.page.locator('#target-status')).toContainText('Insertion skipped');
  await expect(t.website.locator('#editable')).toHaveText('draft next'); await stop(t);
});

test('window-blur editor retains valid prior focus; clicks elsewhere and disconnected/replaced fields supersede it', async ({ targets: t }) => {
  await t.graph({ outputs: [['out', 'FocusedInputTextOutputNode']] }); await t.invoke();
  await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await t.website.bringToFront(); await t.website.locator('#chosen').click();
  await t.website.evaluate(() => window.addEventListener('blur', () => document.activeElement.blur()));
  await t.page.bringToFront(); await emit(t, 1, 'retained'); await expect(t.website.locator('#chosen')).toHaveValue('existing retained');
  await t.website.bringToFront(); await t.website.locator('#play').click();
  await t.website.evaluate(() => [...document.querySelectorAll('audio')].forEach(a => a.pause()));
  await t.page.bringToFront(); await emit(t, 2, 'not focused'); await expect(t.page.locator('#target-status')).toContainText('Insertion skipped');
  await t.website.bringToFront(); await t.website.locator('#chosen').click(); await t.page.bringToFront();
  await t.website.locator('#chosen').evaluate(e => { const replacement = e.cloneNode(true); replacement.value = 'replacement'; e.replaceWith(replacement); });
  await emit(t, 3, 'stale'); await expect(t.website.locator('#chosen')).toHaveValue('replacement');
  await expect(t.page.locator('#final')).toContainText('stale'); await stop(t);
});

for (const selector of ['#password', '#card', '#iban', '#readonly', '#security', 'iframe', '#shadow-field']) {
  test(`unsupported ${selector} supersedes old focus and skips safely`, async ({ targets: t }) => {
    await t.graph({ outputs: [['out', 'FocusedInputTextOutputNode']] }); await t.website.locator('#focused').click(); await t.invoke();
    await expect(t.page.locator('#status')).toHaveText('Transcription active');
    await t.website.bringToFront();
    if (selector === 'iframe') await t.website.locator('iframe').contentFrame().locator('#frame-field').click();
    else await t.website.locator(selector).click();
    if (selector === '#shadow-field') await t.website.evaluate(() => window.addEventListener('blur', () => document.activeElement.blur()));
    await t.page.bringToFront(); await emit(t, 1, 'blocked');
    await expect(t.page.locator('#target-status')).toContainText('Insertion skipped'); await expect(t.website.locator('#focused')).toHaveValue('manual');
    expect(await t.website.evaluate(() => window.edits)).toEqual([]); await expect(t.page.locator('#final')).toContainText('blocked'); await stop(t);
  });
}

for (const selector of ['#focused', '#chosen']) test(`disabled fieldset, hidden and canceled beforeinput skip; controlled ${selector} still appends`, async ({ targets: t }) => {
  await t.graph({ outputs: [['out', 'FocusedInputTextOutputNode']] }); await t.invoke(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await t.website.bringToFront(); await t.website.locator(selector).click(); await t.page.bringToFront();
  const original = await t.website.locator(selector).inputValue();
  await t.website.locator(selector).evaluate(e => { const f = document.createElement('fieldset'); e.before(f); f.append(e); f.disabled = true; });
  await emit(t, 1, 'disabled'); await expect(t.page.locator('#target-status')).toContainText('Insertion skipped'); await expect(t.website.locator(selector)).toHaveValue(original);
  await t.website.locator(selector).evaluate(e => { e.closest('fieldset').disabled = false; e.hidden = true; });
  await emit(t, 2, 'hidden'); await expect(t.website.locator(selector)).toHaveValue(original);
  await t.website.locator(selector).evaluate(e => {
    e.hidden = false;
    const native = Object.getOwnPropertyDescriptor(e instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value');
    let tracked = e.value; window.controlled = tracked;
    Object.defineProperty(e, 'value', { get() { return native.get.call(this); }, set(v) { tracked = v; native.set.call(this, v); } });
    e.addEventListener('input', () => { if (native.get.call(e) !== tracked) { window.controlled = native.get.call(e); tracked = window.controlled; } });
  });
  await t.website.bringToFront(); await t.website.locator(selector).click(); await t.page.bringToFront();
  await emit(t, 3, 'controlled'); await expect(t.website.locator(selector)).toHaveValue(original + ' controlled');
  expect(await t.website.evaluate(() => window.controlled)).toBe(original + ' controlled');
  await t.website.locator(selector).evaluate(e => e.addEventListener('beforeinput', event => event.preventDefault(), { once: true }));
  await emit(t, 4, 'rejected'); await expect(t.page.locator('#target-status')).toContainText('editor rejected');
  await expect(t.website.locator(selector)).toHaveValue(original + ' controlled');
  await emit(t, 5, 'recovered'); await expect(t.website.locator(selector)).toHaveValue(original + ' controlled recovered'); await stop(t);
});

test('no cross-tab grants or output; toolbar retargets only after Stop; navigation expires the authorized document', async ({ targets: t }) => {
  await t.graph({ source: 'MicrophoneAudio', outputs: [['out', 'FocusedInputTextOutputNode']] }); await t.invoke();
  await t.cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', origin: t.origin });
  const other = await t.context.newPage(); await other.goto(`${t.webOrigin.replace('127.0.0.1', 'localhost')}/other`); await other.bringToFront();
  expect(await t.page.evaluate(async () => {
    const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]; const { authorizePage } = await import('./page-target.js');
    try { await authorizePage(tab.id); return false; } catch { return true; }
  })).toBe(true);
  await t.website.bringToFront(); await t.website.locator('#focused').click(); await t.page.locator('#start').click();
  await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await t.invoke(other); await other.locator('#focused').click(); await emit(t, 1, 'same tab');
  await expect(t.website.locator('#focused')).toHaveValue('manual same tab'); await expect(other.locator('#focused')).toHaveValue('manual');
  await t.website.goto(`${t.webOrigin}/replacement`); await expect(t.page.locator('#target-status')).toContainText(/detached|disconnected|unavailable/);
  await emit(t, 2, 'Live survives'); await expect(t.page.locator('#final')).toContainText('Live survives'); await expect(t.website.locator('#focused')).toHaveValue('manual');
  await stop(t); await t.invoke(other); await other.locator('#focused').click(); await t.page.locator('#start').click();
  await expect(t.page.locator('#status')).toHaveText('Transcription active'); await emit(t, 1, 'new toolbar tab');
  await expect(other.locator('#focused')).toHaveValue('manual new toolbar tab'); await expect(t.website.locator('#focused')).toHaveValue('manual'); await stop(t);
});

test('lost connection during start and running detaches focused output; Live continues and toolbar retry recovers', async ({ targets: t }) => {
  await t.graph({ outputs: [['out', 'FocusedInputTextOutputNode']] }); await t.invoke(); await expect(t.page.locator('#status')).toHaveText('Transcription active'); await stop(t);
  await t.page.evaluate(() => { window.originalConnect = chrome.tabs.connect.bind(chrome.tabs); chrome.tabs.connect = () => { throw Error('Controlled output permission loss'); }; });
  await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await expect(t.page.locator('#target-status')).toContainText('output skipped: target unavailable');
  await emit(t, 1, 'Live only'); await expect(t.page.locator('#final')).toContainText('Live only');
  await t.page.evaluate(() => { chrome.tabs.connect = window.originalConnect; }); await stop(t); await t.invoke();
  await expect(t.page.locator('#status')).toHaveText('Transcription active'); await t.website.locator('#focused').click();
  await emit(t, 1, 'retry'); await expect(t.website.locator('#focused')).toHaveValue('manual retry');
  // Close the native tab: connection loss must not send a later edit elsewhere.
  await t.website.close(); await expect(t.page.locator('#target-status')).toContainText(/detached|disconnected/); await stop(t);
});

test('completed translations flow through adapter to TEXT fan-out and paired Live; provisional/pending and duplicate finals never insert', async ({ targets: t }) => {
  await t.page.evaluate(async () => {
    const { TranslationSchedulerNode } = await import('./translation-scheduler.js'), start = TranslationSchedulerNode.prototype.start;
    TranslationSchedulerNode.prototype.start = function(context) { this.prepare = async () => {}; return start.call(this, context); };
  });
  await t.graph({ translation: true, outputs: [['out', 'FocusedInputTextOutputNode', true]] }); await t.website.locator('#focused').click(); await t.invoke();
  await expect(t.page.locator('#status')).toHaveText('Transcription active'); await expect(t.page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
  await emit(t, 1, 'pending text', 'partial'); await expect(t.page.locator('#partial-english')).toContainText('translated pending text'); await expect(t.website.locator('#focused')).toHaveValue('manual');
  await emit(t, 1, 'first'); await emit(t, 1, 'duplicate'); await emit(t, 2, 'second'); await stop(t);
  await expect(t.website.locator('#focused')).toHaveValue('manual translated first translated second'); await expect(t.page.locator('#paired-finals')).toContainText('translated second');
  await expect(t.page.locator('#errors')).toBeEmpty();
});

test('selected media discovers two real elements and captures only the selected tone with normalized PCM', async ({ targets: t }) => {
  await t.graph({ source: 'SelectedPageMediaAudio' }); await t.website.locator('#play').click(); await t.invoke();
  await row(t.page, 'audio').getByRole('button', { name: 'Discover media in capture tab' }).click();
  const select = row(t.page, 'audio').getByRole('combobox'); await expect(select.locator('option')).toHaveCount(3);
  await select.selectOption({ index: 1 }); await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await expect.poll(() => t.page.evaluate(() => window.captured.length)).toBeGreaterThan(16000);
  const result = await t.page.evaluate(() => {
    const samples = window.captured.slice(-16000), amplitude = hz => {
      let a = 0, b = 0; for (let i = 0; i < samples.length; i++) { a += samples[i] * Math.cos(2 * Math.PI * hz * i / 16000); b += samples[i] * Math.sin(2 * Math.PI * hz * i / 16000); } return Math.hypot(a, b) / samples.length;
    }; return { selected: amplitude(440), other: amplitude(880), finite: samples.every(Number.isFinite) };
  });
  expect(result.finite).toBe(true); expect(result.selected).toBeGreaterThan(.03); expect(result.other).toBeLessThan(result.selected / 20);
  expect(await t.page.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).length)).toBe(0);
  await t.website.locator('#first').evaluate(element => element.remove()); await expect(t.page.locator('#status')).toContainText('Stopped'); await expect(t.page.locator('#target-status')).toContainText('removed');
  // Cross-origin source is visibly unsupported, never replaced with tabCapture.
  await t.website.evaluate(origin => { const audio = document.createElement('audio'); audio.id = 'cross-origin'; audio.src = origin.replace('127.0.0.1', 'localhost') + '/440.wav'; document.body.append(audio); }, t.webOrigin);
  await row(t.page, 'audio').getByRole('button', { name: 'Discover media in capture tab' }).click();
  await expect(row(t.page, 'audio').getByRole('combobox').locator('option').filter({ hasText: 'Cross-origin' })).toBeDisabled();
});

test('microphone has an explicit Start gesture, native permission denial, fake-device normalized capture and cleanup', async ({ targets: t }) => {
  await t.graph({ source: 'MicrophoneAudio' }); await t.invoke(); await expect(t.page.locator('#status')).toContainText('Press Start');
  await t.cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'denied', origin: t.origin });
  await t.page.locator('#start').click(); await expect(t.page.locator('#errors')).toContainText(/denied|Permission/i); await expect(t.page.locator('#status')).toContainText('failed');
  await t.cdp.send('Browser.setPermission', { permission: { name: 'microphone' }, setting: 'granted', origin: t.origin }); await t.page.locator('#start').click();
  await expect(t.page.locator('#status')).toHaveText('Transcription active'); await expect.poll(() => t.page.evaluate(() => window.captured.length)).toBeGreaterThan(1600);
  expect(await t.page.evaluate(() => window.captured.every(Number.isFinite))).toBe(true);
  await t.page.locator('#cancel-session').click(); await expect(t.page.locator('#status')).toContainText('Canceled');
  const count = await t.page.evaluate(() => window.captured.length); await t.page.waitForTimeout(150); expect(await t.page.evaluate(() => window.captured.length)).toBe(count);
  await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active'); await t.page.locator('#stop').click(); await expect(t.page.locator('#status')).toContainText('Stopped');
});

test('unsupported/protection markers and audio-less media expose fallback without pretending to capture tab audio', async ({ targets: t }) => {
  await t.graph({ source: 'SelectedPageMediaAudio' }); await t.website.locator('#play').click(); await t.invoke();
  // Deterministic protection marker in the isolated world; no actual DRM service
  // or external protected playback is claimed by this boundary check.
  await t.page.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.startsWith('http://127.0.0.1'));
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => { Object.defineProperty(document.querySelector('#second'), 'mediaKeys', { value: {}, configurable: true }); } });
  });
  await row(t.page, 'audio').getByRole('button', { name: 'Discover media in capture tab' }).click();
  await expect(row(t.page, 'audio').getByRole('combobox').locator('option').filter({ hasText: 'Protected media' })).toBeDisabled();
  await t.website.evaluate(async () => {
    const canvas = document.createElement('canvas'), video = document.createElement('video'); video.id = 'silent-video'; video.muted = true; canvas.getContext('2d').fillRect(0, 0, 50, 50); video.srcObject = canvas.captureStream(10); document.body.append(video); await video.play();
  });
  await row(t.page, 'audio').getByRole('button', { name: 'Discover media in capture tab' }).click();
  const select = row(t.page, 'audio').getByRole('combobox'), options = await select.locator('option').evaluateAll(elements => elements.map(element => ({ value: element.value, text: element.textContent })));
  await select.selectOption(options.find(option => option.text.includes('#silent-video')).value);
  await t.page.locator('#start').click(); await expect(t.page.locator('#errors')).toContainText('No capturable audio track'); await expect(t.page.locator('#errors')).toContainText('Chrome tab audio');
  expect(await t.page.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).length)).toBe(0);
});
