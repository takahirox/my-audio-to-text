import { TEXT } from './port-contracts.js';

// Grouped results with delivery-local causal identity. Closed source windows travel on an
// independent forward edge, before their asynchronous translation can finish.
// Only committed results enter here; preview routing uses the producer's ports.
export class TranslationCommitNode {
  inputs = { boundary: TEXT, source: TEXT, text: TEXT, error: TEXT };
  outputs = { provisional: TEXT, final: TEXT, error: TEXT };
  constructor() { this.boundaries = []; this.chars = 0; }
  start(context) {
    this.context = context; this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
  }
  receiveInputs(values, context) {
    if (this.stopped || context.signal.aborted) return;
    try {
      for (const [port, value] of Object.entries(values)) {
        if (!Object.hasOwn(this.inputs, port) || typeof value !== 'string') throw TypeError('TranslationCommit expects TEXT inputs.');
      }
      if (Object.hasOwn(values, 'boundary')) {
        if (Object.keys(values).length !== 1) throw Error('Boundary must be a separate source event.');
        if (values.boundary.length > 1000 || this.boundaries.length >= 32 || this.chars + values.boundary.length > 32768) throw Error('TranslationCommit backlog limit exceeded (32 windows / 32,768 characters). Stop and start again with a slower source.');
        if (!context.delivery) throw Error('Boundary requires a Pipeline delivery identity.');
        this.boundaries.push({ text: values.boundary, delivery: context.delivery }); this.chars += values.boundary.length;
        context.emit('provisional', '');
        return;
      }
      if (!context.cause) throw Error('Translation result requires a causal source delivery.');
      if (!['source', 'text', 'error'].every(port => context.groupInputs?.includes(port)) ||
          typeof values.source !== 'string' || typeof values.error !== 'string' || (!values.error && typeof values.text !== 'string')) {
        throw Error('Supply grouped source/text/error from one atomic result.');
      }
      if (this.boundaries.length) {
        if (values.source !== this.boundaries[0].text || !context.cause || context.cause !== this.boundaries[0].delivery) throw Error('Translation result does not match the next closed source window.');
        this.chars -= this.boundaries.shift().text.length;
        // A failed final retains its source visibly; never fabricate a translation
        // or delete previously committed items. Previews use a separate route.
        context.emitOutputs({ provisional: '', final: values.error ? `[Translation failed: ${values.error}]\n${values.source}` : values.text, error: values.error });
      } else {
        throw Error('Translation result has no closed source window. Route previews separately.');
      }
    } catch (error) {
      // Pipeline skips failed Nodes during Stop/Cancel, so clear the tail
      // while this producer can still emit, before the error fails the Node.
      context.emit('provisional', '');
      throw error;
    }
  }
  stop(context) {
    this.stopped = true;
    (context || this.context)?.emit('provisional', '');
    if (this.boundaries.length) throw Error(`TranslationCommit stopped with ${this.boundaries.length} untranslated source windows.`);
  }
  cancel(context) { context.emit('provisional', ''); }
  dispose() { this.context?.signal.removeEventListener('abort', this.abort); this.stopped = true; this.boundaries = []; this.chars = 0; }
}
