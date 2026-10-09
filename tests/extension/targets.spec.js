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
<div id="editable" contenteditable="true">draft</div><input id="password" type="password"><input id="card" autocomplete="cc-number"><input id="hidden" hidden><input id="readonly" readonly>
<form><label>Security code<input id="security"></label><input type="password"></form><iframe src="/frame"></iframe>
<script>document.querySelector('#play').onclick=()=>Promise.all([...document.querySelectorAll('audio')].map(a=>a.play()));
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
      context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
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
      const invoke = async (target = website) => {
        const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
        await cdp.send('Extensions.triggerAction', { id, targetId: targetInfos.find(info => info.url === target.url()).targetId });
        await page.waitForTimeout(100);
      };
      const graph = async ({ source = 'ChromeTabAudio', outputs = [], translation = false } = {}) => {
        await page.evaluate(async ({ source, outputs, translation }) => {
          const { defaultGraph, graphNode, edge, saveGraph, GRAPH_KEY } = await import('./graph.js');
          const graph = defaultGraph({ enabled: translation }); graph.nodes[0].type = source;
          for (const [id, type, translated] of outputs) { graph.nodes.push(graphNode(type, id)); graph.edges.push(edge(translated ? 'translation' : 'speech', 'final', id, translated ? 'translatedFinal' : 'final')); }
          saveGraph(localStorage, graph); window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
        }, { source, outputs, translation });
      };
      await page.locator('#targets').evaluate(element => { element.open = true; });
      await use({ context, cdp, id, page, website, invoke, graph, origin: `chrome-extension://${id}`, webOrigin: `http://127.0.0.1:${server.address().port}` });
    } finally { await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
  },
});
const row = (page, id) => page.locator(`[data-target-node="${id}"]`);
async function authorize(t, id) { await row(t.page, id).getByRole('button', { name: 'Authorize capture tab for output' }).click(); await expect(row(t.page, id)).toContainText('Controlled input/output fixture'); }
async function pick(t, id, selector) {
  await row(t.page, id).getByRole('button', { name: 'Pick field', exact: true }).click();
  await expect(t.website.getByText('Local transcription: click an editable field')).toBeVisible();
  await t.website.locator(selector).click(); await expect(row(t.page, id)).toContainText(selector);
}
async function emit(t, id, text, type = 'final') { await t.page.evaluate(({ id, text, type }) => window.activeSpeech.receiveEvent({ type, id, text }), { id, text, type }); }

test('native tab audio → production SpeechToText → Live and picked/focused fields; final-only, ordered, once, drain and teardown', async ({ targets: t }) => {
  await t.graph({ outputs: [['focusedSink', 'FocusedInputTextOutputNode'], ['pickedSink', 'SelectedFormFieldTextOutputNode']] });
  await t.invoke(); await expect(t.page.locator('#errors')).toContainText('Select and authorize');
  expect(await t.website.evaluate(() => window.edits)).toEqual([]);
  await authorize(t, 'focusedSink'); await authorize(t, 'pickedSink'); await pick(t, 'pickedSink', '#chosen');
  await t.website.locator('#play').click(); await t.website.locator('#focused').focus();
  await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await expect(t.page.locator('#partial')).toHaveText('pending fixture');
  await expect(t.website.locator('#focused')).toHaveValue('manual'); await expect(t.website.locator('#chosen')).toHaveValue('existing');
  await expect(row(t.page, 'pickedSink').getByRole('button', { name: 'Clear target' })).toBeDisabled();
  await t.page.locator('#stop').click(); await expect(t.page.locator('#status')).toContainText('Stopped');
  await expect(t.website.locator('#focused')).toHaveValue('manual confirmed fixture'); await expect(t.website.locator('#chosen')).toHaveValue('existing confirmed fixture');
  await expect(t.page.locator('#final')).toHaveText('confirmed fixture\n');
  expect(await t.website.evaluate(() => window.submits)).toBe(0);
  // A new run's IDs are scoped to fresh sink/port instances.
  await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await emit(t, 100, 'one'); await emit(t, 100, 'duplicate'); await emit(t, 99, 'stale'); await emit(t, 101, 'two');
  await expect(t.website.locator('#chosen')).toHaveValue('existing confirmed fixture one two');
  await t.website.locator('#editable').focus(); await emit(t, 102, '<b>plain</b>');
  await expect(t.website.locator('#editable')).toHaveText('draft <b>plain</b>'); expect(await t.website.locator('#editable b').count()).toBe(0);
  await t.page.locator('#cancel-session').click(); await emit(t, 103, 'after cancel');
  await expect(t.website.locator('#chosen')).toHaveValue('existing confirmed fixture one two <b>plain</b>');
  expect(await t.page.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter(tab => tab.status === 'active').length)).toBe(0);
});

test('picked field survives focus changes; replacement/navigation detach; hostile/sensitive fields and frames fail closed', async ({ targets: t }) => {
  await t.graph({ outputs: [['picked', 'SelectedFormFieldTextOutputNode']] }); await t.invoke(); await authorize(t, 'picked');
  await pick(t, 'picked', '#chosen'); await t.website.locator('#focused').focus();
  await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await emit(t, 1, 'first'); await expect(t.website.locator('#chosen')).toHaveValue('existing first');
  await t.website.evaluate(() => { const old = document.querySelector('#chosen'); const next = old.cloneNode(true); next.value = 'replacement'; old.replaceWith(next); });
  await emit(t, 2, 'never'); await expect(t.page.locator('#target-status')).toContainText('detached'); await expect(t.website.locator('#chosen')).toHaveValue('replacement');
  await emit(t, 3, 'live survives'); await expect(t.page.locator('#final')).toContainText('live survives');
  await t.page.locator('#stop').click(); await expect(t.page.locator('#status')).toContainText('Stopped');
  await row(t.page, 'picked').getByRole('button', { name: 'Pick field', exact: true }).click(); await expect(t.website.getByText('Local transcription: click')).toBeVisible();
  for (const selector of ['#password', '#card', '#readonly', '#security']) {
    await t.website.locator(selector).click(); await expect(t.website.getByText('Unsupported or sensitive field.')).toBeVisible();
  }
  await t.website.locator('iframe').contentFrame().locator('#frame-field').click();
  await expect(t.website.getByText('Unsupported or sensitive field.')).toBeVisible();
  await t.page.getByRole('button', { name: 'Cancel field picker' }).click(); await expect(t.website.getByText('Unsupported or sensitive field.')).toHaveCount(0);
  await pick(t, 'picked', '#editable');
  await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await t.website.goto(`${t.webOrigin}/next`); await expect(t.page.locator('#status')).toContainText('Stopped');
  await expect(row(t.page, 'picked')).toContainText('No target selected');
});

for (const selector of ['#focused', '#chosen']) {
  test(`selected ${selector} becoming disabled through its fieldset preserves content and detaches output`, async ({ targets: t }) => {
    await t.website.locator(selector).evaluate(element => {
      const fieldset = document.createElement('fieldset'); element.before(fieldset); fieldset.append(element);
    });
    const original = await t.website.locator(selector).inputValue();
    await t.graph({ outputs: [['picked', 'SelectedFormFieldTextOutputNode']] }); await t.invoke(); await authorize(t, 'picked');
    await pick(t, 'picked', selector);
    await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
    const disabled = await t.website.locator(selector).evaluate(element => {
      element.closest('fieldset').disabled = true;
      return { own: element.disabled, effective: element.matches(':disabled') };
    });
    expect(disabled).toEqual({ own: false, effective: true });
    await emit(t, 1, 'blocked');
    await expect(t.page.locator('#target-status')).toContainText('Insertion detached');
    await expect(t.page.locator('#target-status')).toContainText('not editable');
    await expect(t.website.locator(selector)).toHaveValue(original);
    expect(await t.website.evaluate(() => window.edits)).toEqual([]);
    // Re-enabling the field cannot reactivate an output that has detached.
    await t.website.locator(selector).evaluate(element => { element.closest('fieldset').disabled = false; });
    await emit(t, 2, 'Live continues'); await expect(t.page.locator('#final')).toContainText('Live continues');
    await t.page.locator('#stop').click(); await expect(t.page.locator('#status')).toContainText('Stopped');
    await expect(t.website.locator(selector)).toHaveValue(original);
    expect(await t.website.evaluate(() => window.edits)).toEqual([]);
  });
}

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

test('different output tab requires its own toolbar grant and never changes capture; unauthorized tabs reject injection', async ({ targets: t }) => {
  await t.graph({ outputs: [['out', 'FocusedInputTextOutputNode']] }); await t.invoke();
  const captureTab = await t.page.locator('#tab-status').textContent();
  const other = await t.context.newPage(); await other.goto(`${t.webOrigin}/output`);
  await other.bringToFront();
  const unauthorized = await t.page.evaluate(async () => {
    const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const { authorizePage } = await import('./page-target.js');
    try { await authorizePage(tab.id); return false; } catch { return true; }
  });
  expect(unauthorized).toBe(true);
  await row(t.page, 'out').getByRole('button', { name: 'Use next toolbar tab for output' }).click(); await t.invoke(other);
  await expect(row(t.page, 'out')).toContainText('Controlled input/output fixture');
  expect(await t.page.locator('#tab-status').textContent()).toBe(captureTab);
  await other.locator('#focused').focus(); await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await emit(t, 1, 'separate output'); await expect(other.locator('#focused')).toHaveValue('manual separate output'); await expect(t.website.locator('#focused')).toHaveValue('manual');
  await other.goto(`${t.webOrigin}/replacement`); await expect(t.page.locator('#target-status')).toContainText(/detached|disconnected|navigated/);
  await emit(t, 2, 'Live still active'); await expect(t.page.locator('#final')).toContainText('Live still active'); await expect(other.locator('#focused')).toHaveValue('manual');
  await t.page.locator('#stop').click(); await expect(t.page.locator('#status')).toContainText('Stopped');
  await expect(row(t.page, 'out')).toContainText('No target selected');
});

test('production translation scheduler fans out completed finals independently to paired Live and another chosen field', async ({ targets: t }) => {
  await t.page.evaluate(async () => {
    const { TranslationSchedulerNode } = await import('./translation-scheduler.js'), start = TranslationSchedulerNode.prototype.start;
    TranslationSchedulerNode.prototype.start = function(context) { this.prepare = async () => {}; return start.call(this, context); };
  });
  await t.graph({ translation: true, outputs: [['original', 'FocusedInputTextOutputNode'], ['translatedField', 'SelectedFormFieldTextOutputNode', true]] });
  await t.invoke(); await authorize(t, 'original'); await authorize(t, 'translatedField'); await pick(t, 'translatedField', '#chosen');
  await t.website.locator('#focused').focus(); await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await expect(t.page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
  await emit(t, 1, 'pending text', 'partial'); await expect(t.page.locator('#partial-english')).toContainText('translated pending text');
  await expect(t.website.locator('#focused')).toHaveValue('manual'); await expect(t.website.locator('#chosen')).toHaveValue('existing');
  await emit(t, 1, 'first'); await emit(t, 1, 'duplicate'); await emit(t, 2, 'second');
  await t.page.locator('#stop').click(); await expect(t.page.locator('#status')).toContainText('Stopped');
  await expect(t.website.locator('#focused')).toHaveValue('manual first second'); await expect(t.website.locator('#chosen')).toHaveValue('existing translated first translated second');
  await expect(t.page.locator('#paired-finals')).toContainText('translated second');
  await expect(t.page.locator('#errors')).toBeEmpty();
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

test('clearing one selected destination leaves another chosen handle independent; controlled input events and rejected edits preserve content', async ({ targets: t }) => {
  await t.graph({ outputs: [['first', 'SelectedFormFieldTextOutputNode'], ['second', 'SelectedFormFieldTextOutputNode']] }); await t.invoke();
  for (const id of ['first', 'second']) { await authorize(t, id); await pick(t, id, '#chosen'); }
  await row(t.page, 'first').getByRole('button', { name: 'Clear target' }).click(); await expect(row(t.page, 'first')).toContainText('No target selected');
  await t.page.evaluate(async () => {
    const { readGraph, saveGraph, GRAPH_KEY } = await import('./graph.js'); const graph = readGraph(localStorage);
    graph.nodes = graph.nodes.filter(node => node.id !== 'first'); graph.edges = graph.edges.filter(edge => edge.to[0] !== 'first'); saveGraph(localStorage, graph); window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
  });
  await t.website.evaluate(() => {
    const input = document.querySelector('#chosen'), native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    let tracked = input.value; window.controlled = tracked;
    Object.defineProperty(input, 'value', { get() { return native.get.call(this); }, set(value) { tracked = value; native.set.call(this, value); } });
    input.addEventListener('input', () => { if (native.get.call(input) !== tracked) { window.controlled = native.get.call(input); tracked = window.controlled; } });
  });
  await t.website.locator('#focused').focus(); await t.page.locator('#start').click(); await expect(t.page.locator('#status')).toHaveText('Transcription active');
  await emit(t, 1, 'controlled'); await expect(t.website.locator('#chosen')).toHaveValue('existing controlled'); expect(await t.website.evaluate(() => window.controlled)).toBe('existing controlled');
  await t.website.locator('#chosen').evaluate(element => element.addEventListener('beforeinput', event => event.preventDefault()));
  await emit(t, 2, 'rejected'); await expect(t.page.locator('#target-status')).toContainText('rejected'); await expect(t.website.locator('#chosen')).toHaveValue('existing controlled');
  await t.page.locator('#stop').click(); await expect(t.page.locator('#status')).toContainText('Stopped');
});
