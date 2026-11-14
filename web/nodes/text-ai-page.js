import { Pipeline } from '../pipeline.js';
import { TextInputNode, TextOutputNode } from '../translation-nodes.js';
import { TextSummaryNode } from '../text-summary-node.js';
import { IfConditionNode } from '../if-condition-node.js';
import { releaseResources } from './page-resources.js';
import { requireWebGpu, modelErrorMessage } from './browser-setup.js';

export function mountTextAiPage(type) {
  const el = id => document.getElementById(id), condition = type === 'IfCondition';
  let current, generation = 0;
  const busy = value => {
    el('run').disabled = value; el('cancel').disabled = !value;
    document.querySelectorAll('textarea, input, select').forEach(control => { control.disabled = value; });
  };
  el('run').onclick = async () => {
    const text = el('input').value;
    if (!text.trim()) { el('errors').textContent = 'Enter input text.'; return; }
    const ticket = ++generation, started = performance.now(); let ready, graph;
    el('errors').textContent = el('output').textContent = '';
    el('load-time').textContent = el('latency').textContent = '—';
    el('status').textContent = 'Loading model…'; busy(true);
    try {
      if (!condition) await requireWebGpu({ f16: true });
      if (ticket !== generation) return;
      const onEvent = event => {
        if (ticket !== generation) return;
        if (event.type === 'ready') {
          ready = performance.now(); el('load-time').textContent = `${(ready - started).toFixed(0)} ms`;
          el('status').textContent = condition ? 'Evaluating condition…' : 'Summarizing…';
        } else if (event.type === 'progress') el('status').textContent = event.message;
      };
      const processor = condition ? new IfConditionNode({ condition: el('condition').value, onEvent })
        : new TextSummaryNode({ type, language: el('language').value, prompt: el('prompt').value || undefined, onEvent,
          // Large cold downloads are cancellable; do not inherit Live's short startup deadline.
          loadTimeoutMs: 30 * 60 * 1000 });
      const sinks = condition ? {
        yes: new TextOutputNode(() => { if (ticket === generation) el('output').textContent = 'Yes'; }),
        no: new TextOutputNode(() => { if (ticket === generation) el('output').textContent = 'No'; }),
      } : { summary: new TextOutputNode(text => { if (ticket === generation) el('output').textContent = text; }) };
      graph = new Pipeline({ nodes: { source: new TextInputNode(text), processor, ...sinks }, connections: [
        { from: ['source', 'text'], to: ['processor', 'text'] },
        ...Object.keys(sinks).map(port => ({ from: ['processor', port], to: [port, 'text'] })),
      ] });
      current = graph;
      await graph.start(); await graph.stop();
      if (ticket === generation) {
        el('latency').textContent = `${(performance.now() - ready).toFixed(0)} ms`; el('status').textContent = 'Complete';
      }
    } catch (error) {
      if (ticket === generation) { el('status').textContent = 'Error'; el('errors').textContent = modelErrorMessage(error, !condition); el('output').textContent = ''; }
    } finally {
      const error = await releaseResources(graph);
      if (ticket === generation) {
        if (error) { el('status').textContent = 'Error'; el('errors').textContent = error.message; }
        current = null; busy(false);
      }
    }
  };
  const cancel = async () => {
    ++generation; const graph = current; current = null; const error = await releaseResources(graph);
    el('errors').textContent = el('output').textContent = '';
    el('load-time').textContent = el('latency').textContent = '—';
    el('status').textContent = error ? 'Error' : 'Canceled'; busy(false);
    if (error) el('errors').textContent = error.message;
  };
  el('cancel').onclick = cancel; window.addEventListener('pagehide', () => { void cancel(); });
  busy(false);
}
