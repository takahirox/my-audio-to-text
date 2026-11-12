import { chromium } from '@playwright/test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { graphNode, edge, GRAPH_VERSION } from '../../extension/graph.js';

export function summaryGraph() {
  const source = graphNode('Text', 'source'); source.settings.value = 'Evidence';
  return { version: GRAPH_VERSION,
    nodes: [source, graphNode('TextSummaryLfm2', 'summary'), graphNode('Display', 'display'), graphNode('TextSummaryQwen35', 'parked')],
    edges: [edge('source', 'value', 'summary', 'text'), edge('summary', 'summary', 'display', 'input1')] };
}

// Production UI, manifest resolver, verified streaming cache and Web Locks.
// Only the large pinned asset data and GPU Worker are replaced in this copy.
export async function liveModelFixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'live-download-'));
  const root = path.join(temporary, 'extension'), requests = [], responses = new Set();
  const assets = new Map([['config.json', Buffer.from('{"fixture":true}')], ['weights.bin', Buffer.alloc(32768, 23)]]);
  let mode = 'normal', context;
  const server = createServer((request, response) => {
    requests.push(request.url);
    responses.add(response); response.on('close', () => responses.delete(response));
    response.setHeader('Access-Control-Allow-Origin', '*');
    const name = request.url.split('/').at(-1), body = assets.get(name);
    if (!body) { response.writeHead(404); response.end(); return; }
    if (name === 'weights.bin' && mode === 'network') { response.writeHead(503); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    if (name === 'weights.bin' && mode === 'corrupt') { response.end(Buffer.alloc(body.length)); return; }
    if (name === 'weights.bin' && mode === 'hold') {
      response.write(body.subarray(0, 1024));
      response.finishFixture = () => response.end(body.subarray(1024));
    } else response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cleanup = async () => {
    await context?.close();
    for (const response of responses) response.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  };
  try {
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: file => !file.includes('/vendor') && !file.includes('/tts-assets') });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    const files = [...assets].map(([name, body]) => ({ path: name, bytes: body.length,
      sha256Chunks: [createHash('sha256').update(body).digest('hex')],
      sourceURL: `http://127.0.0.1:${server.address().port}/${name}` }));
    await writeFile(path.join(root, 'extension/meeting-summary-lfm2-assets.json'), JSON.stringify(files));
    await writeFile(path.join(root, 'web/text-summary-worker.js'), `self.onmessage=({data})=>{
      if(data.type==='load')postMessage({type:'ready',id:data.id});
      if(data.type==='summarize')postMessage({type:'result',id:data.id,summary:'Ready summary'});
      if(data.type==='drain')postMessage({type:'drained',id:data.id});
    };`);
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    await context.route('https://huggingface.co/**', route => route.abort('blockedbyclient'));
    const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
    const base = `chrome-extension://${id}/extension/`;
    await context.addInitScript(() => {
      window.modelWorkers = []; window.pendingLoads = []; window.holdModelLoads = false;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); this.messages = []; this.released = false; modelWorkers.push(this); }
        postMessage(data, ...rest) {
          this.messages.push(data.type);
          if (holdModelLoads && data.type === 'load') { pendingLoads.push(() => super.postMessage(data, ...rest)); return; }
          super.postMessage(data, ...rest);
        }
        terminate() { this.released = true; super.terminate(); }
      };
      window.releaseModels = () => { holdModelLoads = false; pendingLoads.splice(0).forEach(send => send()); };
    });
    const editor = await context.newPage(); await editor.goto(base + 'graph-editor.html');
    return { context, base, editor, requests, assets, cleanup,
      mode(value) { mode = value; },
      release() { mode = 'normal'; for (const response of responses) response.finishFixture?.(); },
      async save(graph = summaryGraph()) {
        return editor.evaluate(async graph => (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph), graph);
      },
      async open({ holdModels = false, graphId } = {}) {
        const page = await context.newPage();
        if (holdModels) await page.addInitScript(() => { window.holdModelLoads = true; });
        await page.goto(base + 'recorder.html' + (graphId ? `?graph=${encodeURIComponent(graphId)}` : ''));
        return page;
      },
    };
  } catch (error) { await cleanup(); throw error; }
}
