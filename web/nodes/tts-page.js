import { Pipeline } from '../pipeline.js';
import { TextInputNode } from '../translation-nodes.js';
import { AudioOutputNode, audioToWav } from '../synthesized-audio.js';

// UI/playback only. All model downloads, frontends and inference are owned by Node.
export function mountTtsPage(Node, settings) {
  const el = id => document.getElementById(id);
  let current, generation = 0, audioURL;
  const clearAudio = () => {
    el('player').pause(); el('player').removeAttribute('src'); el('player').load();
    if (audioURL) URL.revokeObjectURL(audioURL);
    audioURL = null; el('download').hidden = true; el('download').removeAttribute('href');
    el('waveform').textContent = '';
  };
  const busy = value => {
    el('run').disabled = value; el('cancel').disabled = !value; el('input').disabled = value;
    document.querySelectorAll('select').forEach(select => { select.disabled = value; });
  };
  el('run').onclick = async () => {
    const text = el('input').value;
    if (!text.trim()) { el('errors').textContent = 'Enter text to synthesize.'; return; }
    const ticket = ++generation, started = performance.now(); let ready, graph;
    clearAudio(); el('errors').textContent = '';
    el('load-time').textContent = el('latency').textContent = '—';
    el('status').textContent = 'Loading model…'; busy(true);
    try {
      const speech = new Node({ ...settings(), onEvent: event => {
        if (ticket !== generation) return;
        if (event.type === 'ready') {
          ready = performance.now(); el('load-time').textContent = `${(ready - started).toFixed(0)} ms`;
          el('status').textContent = 'Generating speech…';
        } else if (event.type === 'progress') el('status').textContent = event.message;
      } });
      const sink = new AudioOutputNode((audio, signal) => {
        if (ticket !== generation || signal.aborted) return;
        audioURL = URL.createObjectURL(audioToWav(audio));
        el('player').src = audioURL;
        el('download').href = audioURL; el('download').hidden = false;
        el('waveform').textContent = `${audio.samples.length} samples · ${audio.sampleRate} Hz · ${audio.channels} channel · ${(audio.samples.length / audio.sampleRate).toFixed(2)} s`;
      });
      graph = new Pipeline({ nodes: { source: new TextInputNode(text), speech, sink }, connections: [
        { from: ['source', 'text'], to: ['speech', 'text'] },
        { from: ['speech', 'audio'], to: ['sink', 'audio'] },
      ], onError: error => { if (ticket === generation) el('errors').textContent = error.message; } });
      current = graph;
      await graph.start(); await graph.stop();
      if (ticket === generation) {
        el('latency').textContent = `${(performance.now() - ready).toFixed(0)} ms`;
        el('status').textContent = 'Complete';
      }
    } catch (error) {
      if (ticket === generation) {
        el('status').textContent = 'Error'; el('errors').textContent ||= error.message; clearAudio();
      }
    } finally {
      try { await graph?.dispose(); }
      catch (error) { if (ticket === generation) { el('status').textContent = 'Error'; el('errors').textContent = error.message; } }
      if (ticket === generation) { current = null; busy(false); }
    }
  };
  const cancel = async () => {
    ++generation; const graph = current; current = null;
    clearAudio(); el('errors').textContent = '';
    el('load-time').textContent = el('latency').textContent = '—';
    try { await graph?.dispose(); el('status').textContent = 'Canceled'; }
    catch (error) { el('status').textContent = 'Error'; el('errors').textContent = error.message; }
    busy(false);
  };
  el('cancel').onclick = cancel;
  window.addEventListener('pagehide', () => { void cancel(); });
  busy(false);
}
