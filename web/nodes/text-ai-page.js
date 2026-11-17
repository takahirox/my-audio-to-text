import { Pipeline } from '../pipeline.js';
import { TextInputNode, TextOutputNode } from '../translation-nodes.js';
import { processingInputs, DEFAULT_PROCESSING_PROMPT } from '../text-summary-policy.js';
import { TextProcessingNode } from '../text-summary-node.js';
import { IfConditionNode } from '../if-condition-node.js';
import { releaseResources } from './page-resources.js';
import { requireWebGpu, modelErrorMessage } from './browser-setup.js';

export function mountTextAiPage(type) {
  const el = id => document.getElementById(id), condition = type === 'IfCondition';
  let current, generation = 0;
  const values = [];
  const renderInputs = () => {
    values[0] = el('input').value;
    el('additional-inputs').querySelectorAll('textarea').forEach(control => { values[Number(control.dataset.index)] = control.value; });
    const count = el('input-count').valueAsNumber;
    try { processingInputs(count); } catch { return; }
    el('additional-inputs').replaceChildren();
    for (let i = 1; i < count; i++) {
      const label = document.createElement('label'), control = document.createElement('textarea');
      label.textContent = `Input ${i + 1}`; control.id = `input-${i + 1}`; label.htmlFor = control.id;
      control.dataset.index = i; control.rows = 4; control.maxLength = 32768; control.value = values[i] || '';
      el('additional-inputs').append(label, control);
    }
  };
  if (!condition) {
    el('prompt').value = DEFAULT_PROCESSING_PROMPT;
    el('input-count').onchange = renderInputs;
    el('example').onchange = () => {
      if (!el('example').value) return;
      const examples = {
        summary: ['Summarize Input 1 in two English bullet points.', 'The park opened in April. Visitors enjoy its trails.'],
        proofreading: ['Proofread Input 1. Return only corrected English text.', 'She go to school yesterday.'],
        extraction: ['Extract the names and deadlines from Input 1 as JSON.', 'Ana will send the draft on Friday. Bo will review it on Monday.'],
        comparison: ['Compare Input 1 and Input 2 in English. Identify differences.', 'Plan A costs $10 and takes two days.', 'Plan B costs $15 and takes one day.'],
      };
      const [prompt, ...inputs] = examples[el('example').value];
      el('prompt').value = prompt; el('input').value = inputs[0]; values.splice(0, values.length, ...inputs);
      el('additional-inputs').replaceChildren(); el('input-count').value = inputs.length; renderInputs();
    };
  }
  const busy = value => {
    el('run').disabled = value; el('cancel').disabled = !value;
    document.querySelectorAll('textarea, input, select').forEach(control => { control.disabled = value; });
  };
  el('run').onclick = async () => {
    const text = el('input').value;
    if (condition && !text.trim()) { el('errors').textContent = 'Enter input text.'; return; }
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
          el('status').textContent = condition ? 'Evaluating condition…' : 'Processing text…';
        } else if (event.type === 'progress') el('status').textContent = event.message;
      };
      const processor = condition ? new IfConditionNode({ condition: el('condition').value, onEvent })
        : new TextProcessingNode({ type, inputCount: el('input-count').valueAsNumber, prompt: el('prompt').value, onEvent,
          // Large cold downloads are cancellable; do not inherit Live's short startup deadline.
          loadTimeoutMs: 30 * 60 * 1000 });
      const sinks = condition ? {
        yes: new TextOutputNode(() => { if (ticket === generation) el('output').textContent = 'Yes'; }),
        no: new TextOutputNode(() => { if (ticket === generation) el('output').textContent = 'No'; }),
      } : { result: new TextOutputNode(text => { if (ticket === generation) el('output').textContent = text; }) };
      const source = condition ? new TextInputNode(text) : {
        inputs: {}, outputs: processingInputs(el('input-count').valueAsNumber),
        start(context) { context.emitOutputs(Object.fromEntries(Object.keys(this.outputs).map((port, i) => [port, i === 0 ? text : el(`input-${i + 1}`).value]))); },
      };
      graph = new Pipeline({ nodes: { source, processor, ...sinks }, connections: [
        ...Object.keys(source.outputs).map(port => ({ from: ['source', port], to: ['processor', condition ? 'text' : port] })),
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
