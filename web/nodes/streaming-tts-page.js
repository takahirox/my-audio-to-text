import { Pipeline } from '../pipeline.js';
import { TextInputNode } from '../translation-nodes.js';
import { AUDIO_STREAM, validateAudioStream } from '../audio-stream.js';
import { SpeakerOutputNode } from '../speaker-output.js';
import { audioToWav } from '../synthesized-audio.js';
import { releaseResources } from './page-resources.js';
import { requireWebGpu, modelErrorMessage } from './browser-setup.js';

// Use production incremental playback; the WAV collector is a separate sink.
export function mountStreamingTtsPage(Node, settings) {
  const el = id => document.getElementById(id);
  let current, generation = 0, audioURL;
  const clearAudio = () => {
    el('player').pause(); el('player').removeAttribute('src'); el('player').load();
    if (audioURL) URL.revokeObjectURL(audioURL);
    audioURL = null; el('download').hidden = true; el('download').removeAttribute('href');
    el('waveform').textContent = el('playback').textContent = '';
    el('enable-speaker').hidden = true;
  };
  const busy = value => {
    el('run').disabled = value; el('cancel').disabled = !value; el('input').disabled = value;
    document.querySelectorAll('select').forEach(control => { control.disabled = value; });
  };
  el('run').onclick = async () => {
    const text = el('input').value;
    if (!text.trim()) { el('errors').textContent = 'Enter text to synthesize.'; return; }
    const ticket = ++generation, started = performance.now(); let ready, graph, speaker;
    const active = () => ticket === generation;
    clearAudio(); el('errors').textContent = '';
    el('load-time').textContent = el('latency').textContent = '—'; busy(true);
    el('status').textContent = 'Loading model…';
    try {
      speaker = new SpeakerOutputNode({ onState: state => {
        if (!active()) return;
        el('playback').textContent = state.message;
        el('enable-speaker').hidden = !state.needsActivation;
        if (state.overflow) { el('errors').textContent = state.message; void cancel(); }
      } });
      current = { speaker };
      // Preserve the Generate gesture for autoplay before model/network awaits.
      speaker.enable();
      await requireWebGpu();
      if (!active()) return;
      const speech = new Node({ ...settings(), onEvent: event => {
        if (!active()) return;
        if (event.type === 'ready') {
          ready = performance.now(); el('load-time').textContent = `${(ready - started).toFixed(0)} ms`;
          el('status').textContent = 'Generating speech…';
        } else if (event.type === 'progress') el('status').textContent = event.message;
        else if (event.type === 'error') el('errors').textContent = event.message;
      } });
      let chunks = [], length = 0, sampleRate;
      const collector = { inputs: { stream: AUDIO_STREAM }, outputs: {}, receive(port, value) {
        if (!active()) return;
        const event = validateAudioStream(value);
        if (event.type === 'start') sampleRate = event.sampleRate;
        if (event.type === 'chunk') {
          length += event.samples.length;
          if (length > sampleRate * 120) throw Error('WAV capture exceeds two minutes. Cancel and use shorter text.');
          chunks.push(event.samples.slice());
          el('waveform').textContent = `${chunks.length} PCM chunks · ${(length / sampleRate).toFixed(2)} s · ${sampleRate} Hz`;
        } else if (event.type === 'end') {
          if (!length) throw Error('The model returned no speech audio.');
          const samples = new Float32Array(length); let offset = 0;
          for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
          chunks = [];
          audioURL = URL.createObjectURL(audioToWav({ samples, sampleRate, channels: 1 }));
          el('player').src = audioURL; el('download').href = audioURL; el('download').hidden = false;
          el('latency').textContent = `${(performance.now() - ready).toFixed(0)} ms`;
          el('status').textContent = 'Generation complete; finishing playback…';
        } else if (event.type === 'abort') { chunks = []; throw Error(event.message); }
      }, dispose() { chunks = []; } };
      graph = new Pipeline({ nodes: { source: new TextInputNode(text), speech, speaker, collector }, connections: [
        { from: ['source', 'text'], to: ['speech', 'text'] },
        { from: ['speech', 'stream'], to: ['speaker', 'audio'] },
        { from: ['speech', 'stream'], to: ['collector', 'stream'] },
      ] });
      current.graph = graph;
      await graph.start(); await graph.stop();
      if (active()) el('status').textContent = 'Complete';
    } catch (error) {
      if (active()) { el('status').textContent = 'Error'; el('errors').textContent = modelErrorMessage(error, true); clearAudio(); }
    } finally {
      const error = await releaseResources(graph, speaker);
      if (active()) {
        if (error) { el('status').textContent = 'Error'; el('errors').textContent = error.message; }
        current = null; busy(false);
      }
    }
  };
  const cancel = async () => {
    ++generation; const session = current; current = null;
    clearAudio(); const error = await releaseResources(session?.graph, session?.speaker);
    el('status').textContent = error ? 'Error' : 'Canceled'; busy(false);
    if (error) el('errors').textContent = error.message;
  };
  el('cancel').onclick = cancel;
  el('enable-speaker').onclick = () => current?.speaker.enable();
  window.addEventListener('pagehide', () => { void cancel(); }); busy(false);
}
