import { Pipeline } from '../pipeline.js';
import { TextInputNode, TextOutputNode } from '../translation-nodes.js';

// UI plumbing only. Inference and model policy live in the production nodes.
export function mountTranslationPage(Node, { sourceLanguage = 'Japanese', persistent = false, translationOptions = () => ({}) } = {}) {
  const element = id => document.getElementById(id);
  let current, generation = 0;
  const busy = value => {
    element('run').disabled = value;
    element('cancel').disabled = !value && !current;
    element('input').disabled = value;
    document.querySelectorAll('textarea').forEach(control => { control.disabled = value; });
    document.querySelectorAll('select, input').forEach(control => { control.disabled = value; });
  };
  element('run').onclick = async () => {
    const text = element('input').value;
    if (!text.trim()) {
      element('errors').textContent = `Enter ${sourceLanguage} text to translate.`; return;
    }
    const ticket = ++generation, started = performance.now();
    let ready;
    element('output').textContent = ''; element('errors').textContent = '';
    element('latency').textContent = '—'; element('load-time').textContent = '—';
    element('status').textContent = 'Loading model…'; busy(true);
    const node = current ? null : new Node({ ...translationOptions(), onEvent: event => {
      if (ticket !== generation) return;
      if (event.type === 'ready') {
        ready = performance.now();
        element('load-time').textContent = `${(ready - started).toFixed(0)} ms`;
        element('status').textContent = 'Translating…';
      } else if (event.status === 'progress') {
        const percent = Number.isFinite(event.progress) ? ` ${event.progress.toFixed(0)}%` : '';
        element('status').textContent = `Loading ${event.file || 'model'}${percent}`;
      }
    } });
    const source = new TextInputNode(text);
    const sink = new TextOutputNode((translated, signal) => {
      if (current !== graph || signal.aborted) return;
      element('output').textContent += `${element('output').textContent ? '\n' : ''}${translated}`;
    });
    const graph = current || new Pipeline({ nodes: { source, translation: node, sink }, connections: [
      { from: ['source', 'text'], to: ['translation', 'text'] },
      { from: ['translation', 'text'], to: ['sink', 'text'] },
    ], onError: error => {
      if (current === graph) element('errors').textContent = error.message;
    } });
    current = graph;
    try {
      if (graph.state === 'running') {
        ready = started;
        element('load-time').textContent = 'Already loaded';
        element('status').textContent = 'Translating…';
        graph.entries.get('source').context.emit('text', text);
      } else await graph.start();
      if (persistent) {
        await graph.entries.get('translation').queue;
        await graph.entries.get('sink').queue;
        if (graph.errors.length) throw graph.errors.at(-1);
      } else await graph.stop();
      if (ticket === generation) {
        element('latency').textContent = `${(performance.now() - ready).toFixed(0)} ms`;
        element('status').textContent = 'Complete';
      }
    } catch (error) {
      if (ticket === generation) {
        element('status').textContent = 'Error';
        element('errors').textContent = element('errors').textContent || error.message;
        element('output').textContent = '';
      }
      await graph.dispose();
      if (current === graph) current = null;
    } finally {
      if (!persistent) await graph.dispose();
      if (ticket === generation) { if (!persistent) current = null; busy(false); }
    }
  };
  const cancel = async () => {
    ++generation;
    const graph = current; current = null;
    await graph?.dispose();
    element('output').textContent = ''; element('errors').textContent = '';
    element('latency').textContent = '—'; element('load-time').textContent = '—';
    element('status').textContent = 'Canceled'; busy(false);
  };
  element('cancel').onclick = cancel;
  window.addEventListener('pagehide', () => { void cancel(); });
  busy(false);
}
