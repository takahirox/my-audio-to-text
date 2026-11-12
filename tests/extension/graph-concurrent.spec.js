import { settleAutoSave } from './ui-controls.js';
import { startReadyLive, expectPreparedIdle } from './live-lifecycle.js';
import { test, expect, openGraph } from './graph-fixture.js';
import { clickGraphAction } from './ui-controls.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

async function saveConcurrent(page) {
  return page.evaluate(async () => {
    const { defaultGraph, graphNode, edge } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');
    const graph = defaultGraph();
    graph.nodes.push(graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextWhisper', 'local'), graphNode('Display', 'local-display'),
      graphNode('MicrophoneAudio', 'parked-mic'), graphNode('Kokoro', 'parked-tts'), graphNode('SpeechToTextWhisper', 'unfinished-model'));
    graph.edges.push(edge('mic', 'audio', 'local', 'audio'), edge('local', 'final', 'local-display', 'input1'));
    await saveLiveGraphData(localStorage, (graph)); return graph;
  });
}

test('MV3 toolbar invocation leaves parked and incomplete focused outputs unauthorized', async ({ graphExtension: f }) => {
  const page = await openGraph(f);
  const graph = await page.evaluate(async () => {
    const { defaultGraph, graphNode, edge } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');
    const graph = defaultGraph();
    graph.nodes.push(graphNode('FocusedInputTextOutputNode', 'parked-output'),
      graphNode('SpeechToTextWhisper', 'unfinished'), graphNode('FocusedInputTextOutputNode', 'unfinished-output'));
    graph.edges.push(edge('unfinished', 'final', 'unfinished-output', 'text'));
    await saveLiveGraphData(localStorage, (graph));
    window.pageAllocations = [];
    chrome.scripting.executeScript = async () => { window.pageAllocations.push('script'); throw Error('Inactive output requested authorization'); };
    chrome.tabs.connect = () => { window.pageAllocations.push('connection'); throw Error('Inactive output opened a connection'); };
    return graph;
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await startReadyLive(page);
  await expect(page.locator('#status')).toHaveText('Transcription active');
  expect(await page.evaluate(() => window.pageAllocations)).toEqual([]);
  await expect(page.locator('#output-status')).toBeEmpty();
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(graph);
  await expectPreparedIdle(page);
});

test('MV3 concurrent tab/mic capture, separate models/displays, branch end, Stop, Cancel and repeat', async ({ graphExtension: f }) => {
  for (const [file, label] of [['sherpa-worker.js', 'remote'], ['whisper-worker.js', 'local']]) {
    await writeFile(path.join(f.root, 'web', file), `self.onmessage=({data})=>{
      if(data.type==='load')postMessage({type:'ready'});
      if(data.type==='decode') { postMessage({type:data.final?'final':'partial',session:data.session,id:data.id,text:'${label}'});postMessage({type:'decoded',session:data.session}); }
    };`);
  }
  await writeFile(path.join(f.root, 'web/silero-worker.js'), `self.onmessage=({data})=>{
    if(data.type==='load')postMessage({type:'ready'});
    if(data.type==='vad-audio')postMessage({type:'vad',session:data.session,frames:[{audio:data.audio,speaking:true}]});
    if(data.type==='vad-stop')postMessage({type:'vad-stopped',session:data.session});
  };`);
  await f.context.addInitScript(() => {
    window.captureStreams = []; window.mediaRequests = [];
    const NativeContext = AudioContext;
    navigator.mediaDevices.getUserMedia = async options => {
      const kind = options.audio?.mandatory ? 'tab' : 'mic'; window.mediaRequests.push(kind);
      const context = new NativeContext(), source = context.createConstantSource(), destination = context.createMediaStreamDestination();
      source.offset.value = kind === 'tab' ? .06 : .02; source.connect(destination); source.start(); await context.resume();
      const stream = destination.stream, track = stream.getAudioTracks()[0], stop = track.stop.bind(track);
      const record = { kind, stream, context, stopped: false }; window.captureStreams.push(record);
      track.stop = () => { if(record.stopped)return; record.stopped=true;stop();source.stop();void context.close(); };
      return stream;
    };
    chrome.tabCapture.getMediaStreamId = async () => 'fixture-tab';
  });
  const page = await openGraph(f), graph = await saveConcurrent(page); await page.editor.reload();
  // Restore the production capture lifecycle overridden by the generic graph fixture.
  await page.evaluate(async () => {
    const { BrowserTabAudioNode } = await import('../web/transcription-nodes.js');
    const { ExtensionTabAudioNode } = await import('./tab-audio-node.js');
    ExtensionTabAudioNode.prototype.start = function(context) {
      if(this.endRequested)return this.stop();
      return BrowserTabAudioNode.prototype.start.call(this,context);
    };
    delete ExtensionTabAudioNode.prototype.stop;
  });
  await expect(page.editor.locator('#graph-errors')).toBeEmpty();
  for (const mode of ['branch-end', 'stop', 'cancel']) {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#model-status')).toHaveText('Ready');
    // No auto-permission request and no active resources from the toolbar invocation.
    const before = await page.evaluate(() => window.mediaRequests.length);
    await page.locator('#start').click(); await expect(page.locator('#status')).toHaveText('Transcription active');
    expect(await page.evaluate(() => window.mediaRequests.slice(-2).sort())).toEqual(['mic', 'tab']);
    expect(await page.evaluate(() => window.mediaRequests.length)).toBe(before + 2);
    expect(await page.evaluate(() => window.graphWorkers.filter(w => !w.released).length)).toBe(4);
    await expect(page.locator('#saved-state')).toBeEmpty();
    await expect(page.locator('.live-text-region')).toHaveCount(2);
    await expect(page.locator('#signal')).toContainText('audio: Audio signal detected.');
    await expect(page.locator('#signal')).toContainText('mic: Audio signal detected.');
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('remote');
    await expect(page.locator('[data-display="parked-mic"]')).toHaveCount(0);
    if (mode === 'branch-end') {
      await page.evaluate(() => window.captureStreams.find(record => record.kind==='tab'&&!record.stopped).stream.getAudioTracks()[0].dispatchEvent(new Event('ended')));
      await expect(page.locator('[data-display="transcript"] .display-content')).toContainText('remote');
      await expect(page.locator('#status')).toHaveText('Transcription active');
      await expect.poll(() => page.evaluate(() => window.graphWorkers.filter(w => !w.released).length)).toBe(2);
      expect(await page.evaluate(() => window.captureStreams.some(record => record.kind==='mic'&&!record.stopped))).toBe(true);
    }
    if (mode === 'cancel') await page.evaluate(() => window.graphSession.cancel());
    else await page.locator('#stop').click();
    await expect(page.locator('#start')).toBeEnabled(); await expect(page.locator('#errors')).toBeEmpty();
    if(mode!=='cancel') {
      await expect(page.locator('[data-display="transcript"] .display-content')).toContainText('remote');
      await expect(page.locator('[data-display="local-display"] .display-content')).toContainText('local');
    }
    await expectPreparedIdle(page);
    expect(await page.evaluate(() => window.captureStreams.every(record => record.stopped && record.context.state==='closed'))).toBe(true);
    expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(graph);
  }
  expect(f.requests).toEqual([]);
});

test('MV3 drafts ignore the legacy warnings preference; Validate draft shows warnings and empty execution starts no resources', async ({ graphExtension: f }) => {
  const page = await openGraph(f), editor = page.editor;
  const alternateId = await page.evaluate(async () => {
    const { GRAPH_VERSION, graphNode } = await import('./graph.js'); const { GraphLibrary, saveLiveGraphData } = await import('./graph-library.js');
    const graph = { version: GRAPH_VERSION, nodes: [graphNode('MicrophoneAudio', 'parked'), graphNode('SpeechToTextWhisper', 'unfinished'), graphNode('Number', 'duration')], edges: [] };
    localStorage.setItem('graph-show-optional-warnings', 'true');
    await saveLiveGraphData(localStorage, graph);
    const library = await new GraphLibrary(localStorage).create({ name: 'Another incomplete draft', graph });
    return library.graphs.at(-1).id;
  });
  await editor.addInitScript(() => {
    window.legacyWarningAccess = [];
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function(key, ...args) {
        if (key === 'graph-show-optional-warnings') window.legacyWarningAccess.push(method);
        return original.call(this, key, ...args);
      };
    }
  });
  await editor.reload(); await expect(editor.locator('#graph-errors')).toBeEmpty();
  await editor.locator('.graph-actions > summary').click();
  await expect(editor.locator('#graph-optional-warnings')).toHaveCount(0);
  await expect(editor.getByLabel('Show optional warnings')).toHaveCount(0);
  await editor.keyboard.press('Escape');
  await clickGraphAction(editor, 'graph-validate');
  for (const message of ['Required connection missing: unfinished.audio', 'Unconnected output Node: parked', 'At least one output destination is required to run.', 'No executable path']) {
    await expect(editor.locator('#graph-errors')).toContainText(`Warning: ${message}`);
  }
  // The explicit result remains readable across frames and when selecting settings.
  await editor.getByRole('button', { name: 'Select duration', exact: true }).click();
  await editor.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(editor.locator('#graph-errors')).toContainText('No executable path');
  await editor.getByLabel('duration value', { exact: true }).fill('');
  await expect(editor.locator('#graph-errors')).toContainText('Error:');
  await expect(editor.locator('#graph-errors')).not.toContainText('Warning:');
  await clickGraphAction(editor, 'graph-validate');
  await expect(editor.locator('#graph-errors')).toContainText('Error:');
  await editor.getByLabel('duration value', { exact: true }).fill('2');
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  await editor.getByRole('button', { name: 'Select duration', exact: true }).press('ArrowRight');
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  expect(await editor.evaluate(() => window.legacyWarningAccess)).toEqual([]);
  await settleAutoSave(editor);
  await expect(editor.locator('#graph-state')).toHaveText('Saved');
  await editor.reload();
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  const originalURL = editor.url(), alternateURL = new URL(originalURL);
  alternateURL.searchParams.set('id', alternateId);
  await editor.goto(alternateURL.href);
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  await clickGraphAction(editor, 'graph-validate');
  await expect(editor.locator('#graph-errors')).toContainText('No executable path');
  expect(await editor.evaluate(() => window.legacyWarningAccess)).toEqual([]);
  await editor.goto(originalURL);
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  await clickGraphAction(editor,'graph-validate'); await expect(editor.locator('#graph-errors')).toContainText('Warning:');
  await settleAutoSave(editor);
  await expect(editor.locator('#graph-state')).toHaveText('Saved');
  await expect(editor.locator('#graph-save-error')).toBeEmpty();
  // Validation is inspection only; a no-op Auto Save keeps its result visible.
  await expect(editor.locator('#graph-errors')).toContainText('Warning:');
  expect(await editor.evaluate(() => window.legacyWarningAccess)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('graph-show-optional-warnings'))).toBe('true');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#errors')).toContainText('No executable path');
  expect(await page.evaluate(() => window.graphWorkers.filter(w => !w.released).length)).toBe(0);
});


test('MV3 TEXT-only path starts without a toolbar tab or microphone permission', async ({ graphExtension: f }) => {
  const page = await openGraph(f);
  await page.evaluate(async () => {
    const { graphNode, edge, GRAPH_KEY } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');
    const text = graphNode('Text', 'text'); text.settings.value = 'Independent text path';
    await saveLiveGraphData(localStorage, ({ version: 15, nodes: [text, graphNode('Display', 'display')], edges: [edge('text', 'value', 'display', 'input1')] }));
    window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
    navigator.mediaDevices.getUserMedia = () => { throw Error('No microphone permission should be requested'); };
  });
  await expect(page.locator('#start')).toBeEnabled(); await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Processing active');
  await expect(page.locator('.display-content')).toHaveText(['Independent text path'].join('\n'));
  expect(await page.evaluate(() => window.graphWorkers.filter(w => !w.released).length)).toBe(0);
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#errors')).toBeEmpty();
});
