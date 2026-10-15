import { ZIPFORMER as C } from './zipformer-config.js';

// Owns a single online stream. Real audio is accepted once; only finalization
// appends synthetic right context. Never replay a prefix into another decoder.
export class ZipformerSegments {
  constructor(recognizer, emit) { this.recognizer = recognizer; this.emit = emit; this.id = 0; this.samples = 0; this.previous = ''; }
  decode() { while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream); }
  text() { return this.recognizer.getResult(this.stream).text.trim(); }
  push(audio) {
    for (let offset = 0; offset < audio.length;) {
      this.stream ??= this.recognizer.createStream();
      const end = Math.min(audio.length, offset + C.chunkSamples, offset + C.segmentSamples - this.samples);
      this.stream.acceptWaveform(C.sampleRate, audio.subarray(offset, end));
      this.samples += end - offset; offset = end;
      this.decode();
      const text = this.text();
      if (text !== this.previous) { this.previous = text; this.emit({ type: 'partial', id: this.id, text }); }
      if (this.samples === C.segmentSamples) this.finish();
    }
  }
  finish() {
    if (!this.stream) return;
    try {
      this.stream.acceptWaveform(C.sampleRate, new Float32Array(C.tailSamples));
      this.stream.inputFinished(); this.decode();
      const text = this.text();
      if (text) this.emit({ type: 'final', id: this.id, text });
      else if (this.previous) this.emit({ type: 'partial', id: this.id, text: '' });
    } finally {
      this.stream.free(); this.stream = null; this.samples = 0; this.previous = ''; this.id++;
    }
  }
  dispose() { this.stream?.free(); this.stream = null; }
}
