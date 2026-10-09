import { test, expect, chromium } from '@playwright/test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('real pinned ASR: native toolbar/tab audio fans out to Live and the same-tab focused TEXT sink', async ({}, testInfo) => {
  test.skip(process.env.EXTENSION_TARGET_SMOKE !== '1', 'Opt-in real ASR speech smoke: EXTENSION_TARGET_SMOKE=1. No model downloads during Run.');
  test.setTimeout(240000);
  const speech = await readFile('tests/fixtures/ordinary-english.wav');
  expect(createHash('sha256').update(speech).digest('hex')).toBe('21212faed6ae5f5958603d4d7cf60a423f1090fb6542d00e3a826ebe6235a768');
  const server = createServer((request, response) => {
    if (request.url === '/speech.wav') { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(speech); }
    else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<title>Real ASR field smoke</title><button id="play">Play</button><audio src="/speech.wav"></audio><textarea id="field">manual</textarea><input id="other"><script>document.querySelector("button").onclick=()=>document.querySelector("audio").play()</script>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = await mkdtemp(path.join(tmpdir(), 'extension-real-fields-')); let context;
  const requests = [], pageErrors = [], started = Date.now();
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'], args: ['--enable-unsafe-extension-debugging'] });
    const cdp = await context.browser().newBrowserCDPSession(), { id } = await cdp.send('Extensions.loadUnpacked', { path: path.resolve('dist/chrome-extension') });
    context.on('request', request => { requests.push({ protocol: new URL(request.url()).protocol, hostname: new URL(request.url()).hostname, method: request.method(), hasBody: request.postData() !== null }); });
    const live = await context.newPage(); await live.goto(`chrome-extension://${id}/extension/recorder.html`); live.on('pageerror', error => pageErrors.push(error.message));
    await live.evaluate(async () => {
      const { defaultGraph, graphNode, edge, saveGraph, GRAPH_KEY } = await import('./graph.js');
      const graph = defaultGraph({ enabled: false });
      graph.nodes.push(graphNode('FinalText', 'text'), graphNode('FocusedInputTextOutputNode', 'field'));
      graph.edges.push(edge('speech', 'final', 'text', 'final'), edge('text', 'text', 'field', 'text'));
      saveGraph(localStorage, graph); window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
    });
    const website = await context.newPage(); await website.goto(`http://127.0.0.1:${server.address().port}/`);
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    await cdp.send('Extensions.triggerAction', { id, targetId: targetInfos.find(target => target.url === website.url()).targetId });
    await expect(live.locator('#status')).toHaveText('Transcription active', { timeout: 120000 });
    await expect(live.locator('#errors')).toBeEmpty();
    await expect(live.locator('#target-status')).toContainText('connected and authorized');
    await expect(live.getByRole('button', { name: /Authorize capture|Pick field|Use next toolbar/ })).toHaveCount(0);
    await website.locator('#play').click(); await website.locator('#field').click();
    await expect(live.locator('#signal')).toHaveText('Tab audio signal detected.');
    await expect.poll(() => website.locator('audio').evaluate(audio => audio.ended), { timeout: 30000 }).toBe(true);
    await live.locator('#stop').click(); await expect(live.locator('#status')).toContainText('Stopped', { timeout: 120000 });
    const finals = (await live.locator('#final').textContent()).split('\n').map(text => text.trim()).filter(Boolean);
    expect(finals.length).toBeGreaterThan(0);
    await expect(website.locator('#field')).toHaveValue('manual' + finals.join('')); await expect(website.locator('#other')).toHaveValue('');
    await expect(live.locator('#errors')).toBeEmpty(); expect(pageErrors).toEqual([]);
    expect(requests.every(request => request.method === 'GET' && !request.hasBody && (request.protocol === 'chrome-extension:' || request.hostname === '127.0.0.1'))).toBe(true);
    expect(await live.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter(tab => tab.status === 'active').length)).toBe(0);
    const evidence = { browser: context.browser().version(), realAsr: true, realTabCapture: true, realFieldInsertion: true, toolbarDocumentPrepared: true, plainTextSink: true, concurrentLiveOutput: true, fixtureSha256: createHash('sha256').update(speech).digest('hex'), finalUtterances: finals.length, insertedOnceInOrder: true, milliseconds: Date.now() - started, remoteRequests: 0, pageErrors };
    await writeFile(testInfo.outputPath('real-field-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); await new Promise(resolve => server.close(resolve)); }
});
