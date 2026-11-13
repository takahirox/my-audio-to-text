import { Pipeline } from '../pipeline.js';
import { MONO_16KHZ_PCM, TranscriptOutputNode } from '../transcription-nodes.js';
import { prepareAudioBrowser, requireWebGpu, modelErrorMessage } from './browser-setup.js';
import { releaseResources } from './page-resources.js';

// Replay browser-decoded files through the real node, in bounded 100 ms blocks.
// Pacing exposes genuine streaming updates without flooding the worker inbox.
export function mountAsrFilePage(Node, settings = () => ({}), { requireGpu = false } = {}) {
  const el = id => document.getElementById(id);
  let current, generation = 0;
  const busy = value => {
    el('run').disabled = value; el('cancel').disabled = !value;
    el('file').disabled = value;
    document.querySelectorAll('select').forEach(select => { select.disabled = value; });
    if (!value) el('stop').disabled = true;
  };
  const clear = () => {
    for (const id of ['output', 'partial', 'errors']) el(id).textContent = '';
    el('load-time').textContent = el('latency').textContent = '—';
  };
  el('run').onclick = async () => {
    const file = el('file').files[0];
    if (!file) { el('errors').textContent = 'Choose an audio file.'; return; }
    if (file.size > 32 * 1024 * 1024) { el('errors').textContent = 'Use an audio file smaller than 32 MiB and shorter than two minutes.'; return; }
    const ticket = ++generation, session = { stop: false };
    current = session; clear(); busy(true); el('status').textContent = 'Decoding audio…';
    const active = () => ticket === generation;
    let inferenceAt;
    try {
      if (requireGpu) await requireWebGpu({ f16: true, minBufferBytes: 128 * 1024 * 1024 });
      if (!active()) return;
      let decoded;
      try { decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await file.arrayBuffer()); }
      catch { throw Error('Cannot decode this audio format. Try a PCM WAV file supported by this browser.'); }
      if (!active()) return;
      if (!decoded.length || decoded.duration > 120) throw Error('Use a nonempty audio file shorter than two minutes.');
      const renderer = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const input = renderer.createBufferSource(); input.buffer = decoded; input.connect(renderer.destination); input.start();
      const rendered = await renderer.startRendering(); input.disconnect(); input.buffer = null; decoded = null;
      if (!active()) return;
      const audio = rendered.getChannelData(0);
      const loadAt = performance.now(); el('status').textContent = 'Loading model…';
      const speech = new Node({ ...settings(), onEvent: event => {
        if (!active()) return;
        if (event.type === 'progress') el('status').textContent = event.message;
        if (event.type === 'error') {
          session.error = Error(event.message); session.stop = true;
          clearTimeout(session.timer); session.wake?.();
        }
      } });
      // Own the node before loading, so Cancel releases even a pending download.
      session.speech = speech;
      await speech.load();
      if (!active()) return;
      if (session.error || speech.unavailable) throw session.error || Error('Recognizer unavailable. Retry on a supported device.');
      el('load-time').textContent = `${(performance.now() - loadAt).toFixed(0)} ms`;
      let sourceContext;
      const source = { inputs: {}, outputs: { audio: MONO_16KHZ_PCM }, start(context) { sourceContext = context; } };
      const transcript = new TranscriptOutputNode((port, text) => {
        if (!active()) return;
        if (port === 'provisional') el('partial').textContent = text;
        else if (port === 'final' && text.trim()) el('output').textContent += `${text}\n`;
      });
      const connections = [
        { from: ['source', 'audio'], to: ['speech', 'audio'] },
        { from: ['speech', 'final'], to: ['transcript', 'final'] },
      ];
      if (speech.outputs.provisional) connections.push({ from: ['speech', 'provisional'], to: ['transcript', 'provisional'] });
      else el('partial').textContent = 'This model publishes final results only.';
      const graph = session.graph = new Pipeline({ nodes: { source, speech, transcript }, connections,
        onError: error => { session.error = error; session.stop = true; } });
      await graph.start();
      inferenceAt = performance.now(); el('stop').disabled = false;
      for (let offset = 0; offset < audio.length && active() && !session.stop; offset += 1600) {
        sourceContext.emit('audio', audio.slice(offset, offset + 1600));
        el('status').textContent = `Transcribing ${(offset / 16000).toFixed(1)} / ${(audio.length / 16000).toFixed(1)} s…`;
        await new Promise(resolve => { session.wake = resolve; session.timer = setTimeout(resolve, 100); });
      }
      if (!active()) return;
      el('stop').disabled = true; el('status').textContent = 'Finalizing…';
      if (session.error) throw session.error;
      await graph.stop();
      if (session.error) throw session.error;
      if (active()) {
        el('latency').textContent = `${(performance.now() - inferenceAt).toFixed(0)} ms`;
        el('status').textContent = 'Complete';
      }
    } catch (error) {
      if (active()) { el('status').textContent = 'Error'; el('errors').textContent = modelErrorMessage(error, requireGpu); }
    } finally {
      clearTimeout(session.timer);
      const error = await releaseResources(session.graph, session.speech);
      if (active()) {
        if (error) { el('status').textContent = 'Error'; el('errors').textContent = error.message; }
        current = null; busy(false);
      }
    }
  };
  el('stop').onclick = () => {
    if (!current) return;
    current.stop = true; clearTimeout(current.timer); current.wake?.(); el('stop').disabled = true;
  };
  const cancel = async () => {
    ++generation; const session = current; current = null;
    clearTimeout(session?.timer); session?.wake?.();
    const error = await releaseResources(session?.graph, session?.speech);
    clear(); busy(false); el('status').textContent = error ? 'Error' : 'Canceled';
    if (error) el('errors').textContent = error.message;
  };
  el('cancel').onclick = cancel;
  window.addEventListener('pagehide', () => { void cancel(); });
  prepareAudioBrowser().then(ready => { if (ready) { busy(false); el('status').textContent = 'Ready'; } }).catch(error => {
    el('status').textContent = 'Browser setup failed'; el('errors').textContent = error.message;
  });
}
