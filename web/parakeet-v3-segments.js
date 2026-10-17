// Non-overlapping offline utterances, never provisional recognition. 20ms RMS
// frames end on 800ms quiet or a hard 12s cap, including silence. The cap can
// split words; each real sample is consumed once. Stop keeps incomplete frames.
export class ParakeetV3Segments {
  constructor(transcribe, emit) {
    this.transcribe = transcribe; this.emit = emit; this.id = 0;
    this.buffer = new Float32Array(16000 * 12); this.used = 0; this.quiet = 0; this.voiced = false;
    this.frame = new Float32Array(320); this.frameUsed = 0;
  }
  async push(audio) {
    for (let offset = 0; offset < audio.length;) {
      const count = Math.min(320 - this.frameUsed, audio.length - offset);
      this.frame.set(audio.subarray(offset, offset + count), this.frameUsed); this.frameUsed += count; offset += count;
      if (this.frameUsed === 320) { await this.accept(this.frame); this.frameUsed = 0; }
    }
  }
  async accept(frame) {
    this.buffer.set(frame, this.used); this.used += frame.length;
    const rms = Math.sqrt(frame.reduce((sum, x) => sum + x * x, 0) / frame.length);
    if (rms >= 0.003) { this.voiced = true; this.quiet = 0; } else this.quiet += frame.length;
    if (this.used === this.buffer.length || (this.voiced && this.quiet >= 12800)) await this.commit();
  }
  async commit() {
    if (this.used && this.voiced) {
      const result = await this.transcribe(this.buffer.slice(0, this.used));
      const text = result.utterance_text.trim();
      if (text) this.emit({ type: 'final', id: this.id, text });
    }
    this.id++; this.used = 0; this.quiet = 0; this.voiced = false;
  }
  async finish() {
    if (this.frameUsed) { await this.accept(this.frame.subarray(0, this.frameUsed)); this.frameUsed = 0; }
    await this.commit();
  }
}
