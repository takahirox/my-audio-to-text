import { Pipeline } from '../../pipeline.js';
import { TextInputNode, TextOutputNode } from '../../translation-nodes.js';
import { SpeechTranscriptCorrectionNode } from '../../correction-nodes.js';

const element = id => document.getElementById(id);
let current, generation = 0;
const busy = value => {
  element('run').disabled = value; element('cancel').disabled = !value;
  for (const id of ['input', 'language', 'bypass']) element(id).disabled = value;
};
element('run').onclick = async () => {
  const text = element('input').value;
  if (!text.trim()) { element('errors').textContent = 'Enter a final transcript.'; return; }
  if (text.length > 500) { element('errors').textContent = 'Use at most 500 characters.'; return; }
  const ticket = ++generation, started = performance.now(), bypass = element('bypass').checked;
  let ready;
  // Retain the consumer's snapshot even if model startup fails before emission.
  element('original').textContent = text;
  for (const id of ['output', 'errors', 'change', 'cache-status']) element(id).textContent = '';
  for (const id of ['load-time', 'latency']) element(id).textContent = '—';
  element('status').textContent = bypass ? 'Bypassing…' : 'Loading model…'; busy(true);
  const correction = new SpeechTranscriptCorrectionNode({ enabled: !bypass, language: element('language').value, onEvent: event => {
    if (ticket !== generation) return;
    if (event.type === 'ready' || event.type === 'bypass') {
      ready = performance.now();
      element('load-time').textContent = bypass ? '0 ms (bypassed)' : `${(ready - started).toFixed(0)} ms`;
      element('status').textContent = bypass ? 'Bypassing…' : 'Generating candidate…';
    } else if (event.status === 'progress') {
      element('status').textContent = `Loading ${event.file || 'model'} ${Number.isFinite(event.progress) ? event.progress.toFixed(0) + '%' : ''}`;
    } else if (event.status === 'cache-warning') element('cache-status').textContent = event.message;
  } });
  const graph = new Pipeline({ nodes: {
    source: new TextInputNode(text), correction,
    original: new TextOutputNode(value => { if (ticket === generation) element('original').textContent = value; }),
    candidate: new TextOutputNode((value, signal) => {
      if (ticket !== generation || signal.aborted) return;
      element('output').textContent = value;
      if (value === text) element('change').textContent = 'Exact copy of the original.';
      else {
        // Show one contiguous changed span without injecting model HTML.
        const a = Array.from(text), b = Array.from(value);
        let prefix = 0, suffix = 0;
        while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
        while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
        const before = a.slice(prefix, a.length - suffix).join('');
        const after = b.slice(prefix, b.length - suffix).join('');
        element('change').textContent = `Changed span: “${before}” → “${after}”. Compare both texts before using the candidate.`;
      }
    }),
  }, connections: [
    { from: ['source', 'text'], to: ['original', 'text'] },
    { from: ['source', 'text'], to: ['correction', 'text'] },
    { from: ['correction', 'text'], to: ['candidate', 'text'] },
  ], onError: error => { if (ticket === generation) element('errors').textContent = error.message; } });
  current = graph;
  try {
    await graph.start(); await graph.stop();
    if (ticket === generation) {
      element('latency').textContent = `${(performance.now() - ready).toFixed(0)} ms`;
      element('status').textContent = bypass ? 'Bypassed' : 'Complete';
    }
  } catch (error) {
    if (ticket === generation) {
      element('status').textContent = 'Error';
      element('errors').textContent ||= error.message;
      element('output').textContent = ''; element('change').textContent = '';
    }
  } finally {
    await graph.dispose();
    if (ticket === generation) { current = null; busy(false); }
  }
};
async function cancel() {
  ++generation;
  const graph = current; current = null;
  await graph?.dispose();
  for (const id of ['output', 'errors', 'change']) element(id).textContent = '';
  element('status').textContent = 'Canceled'; busy(false);
}
element('cancel').onclick = cancel;
window.addEventListener('pagehide', () => { void cancel(); });
busy(false);
