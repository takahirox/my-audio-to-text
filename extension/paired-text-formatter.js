import { TRANSLATION_OUTPUTS } from './translation-scheduler.js';
import { TEXT } from '../web/port-contracts.js';
import { translationLabel, provisionalLabel } from './translation-view.js';

export const PAIRED_INPUTS = Object.freeze({
  ...Object.fromEntries(Object.entries(TRANSLATION_OUTPUTS).filter(([port]) => port !== 'provisional')),
  provisionalText: TEXT,
});

// Narrow compatibility adapter for saved paired TranslationView bundles. Row
// identity comes ONLY from one translator's directly grouped primitive outputs.
// Whole-history replacement allows pending rows to update without appending twice.
export class PairedTextFormatterNode {
  inputs = PAIRED_INPUTS;
  outputs = { text: TEXT };
  constructor({ direction = 'ja-en' } = {}) { this.direction = direction; this.rows = []; this.preview = null; }
  start(context) { this.context = context; }
  snapshot() {
    const sourceLabel = this.direction === 'en-ja' ? 'English' : 'Japanese';
    const targetLabel = this.direction === 'en-ja' ? 'Japanese' : 'English';
    const rowText = row => `${sourceLabel}: ${row.source}\n${targetLabel}: ${translationLabel(row)}`;
    return [...this.rows.filter(Boolean).map(rowText), ...(this.preview?.source ? [
      `${sourceLabel}: ${this.preview.source}\n${targetLabel}: ${provisionalLabel(this.preview.source, this.preview, true)}`,
    ] : [])].join('\n\n');
  }
  publish(context = this.context) { context?.emit('text', this.snapshot()); }
  receiveInputs(values, context) {
    if (context.signal.aborted) return;
    const provisional = Object.hasOwn(values, 'provisionalStatus');
    const prefix = provisional ? 'provisional' : 'final';
    const row = { source: values[`${prefix}Source`], status: values[`${prefix}Status`], error: values[`${prefix}Error`], text: values[provisional ? 'provisionalText' : 'text'] ?? '' };
    if (typeof row.source !== 'string' || typeof row.status !== 'string') throw TypeError('Paired formatter requires directly grouped source/status primitives.');
    if (provisional) {
      const previous = this.preview?.status === 'complete' ? this.preview : this.preview?.previous;
      this.preview = row.status === 'pending' && previous ? { ...row, previous } : row;
    } else {
      if (!Number.isInteger(values.finalIndex) || values.finalIndex < 0) throw TypeError('Paired formatter requires a nonnegative finalIndex.');
      const first = !this.rows[values.finalIndex];
      this.rows[values.finalIndex] = row;
      if (first) this.preview = null;
    }
    this.publish(context);
  }
  stop() { this.preview = null; this.publish(); }
  cancel() {
    this.preview = null;
    this.rows = this.rows.map(row => row?.status === 'pending' ? { ...row, status: 'canceled' } : row);
    // Cancellation cannot emit into an aborted Pipeline. The session snapshots
    // this formatter's plain text into its connected replace sink before dispose.
    return this.snapshot();
  }
}
