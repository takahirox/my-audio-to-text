// Model-native incremental lines; no prefix replay or manufactured interim text.
// Renewal after 30 seconds bounds native transcript/diff history and PCM retained
// in transcript snapshots, independently of the transport's 30-second backlog.
export class MoonshineMediumStream {
  constructor(transcriber, emit) { this.transcriber = transcriber; this.emit = emit; this.nextId = 0; this.open(); }
  open() {
    this.stream = this.transcriber.createStream({ updateInterval: 0.5 });
    const ids = new Map(), completed = new Set();
    const id = line => { if (!ids.has(line.id)) ids.set(line.id, this.nextId++); return ids.get(line.id); };
    const partial = ({ line }) => {
      if (!line.isComplete && !completed.has(line.id)) this.emit({ type: 'partial', id: id(line), text: line.text });
    };
    this.stream.addListener({ onLineStarted: partial, onLineTextChanged: partial,
      onLineCompleted: ({ line }) => {
        if (completed.has(line.id)) return;
        completed.add(line.id);
        if (line.text.trim()) this.emit({ type: 'final', id: id(line), text: line.text.trim() });
        else this.emit({ type: 'partial', id: id(line), text: '' });
      }, onError: ({ error }) => { this.failure = error; } });
    this.stream.start(); this.samples = 0;
  }
  push(audio) {
    for (let offset = 0; offset < audio.length;) {
      const end = Math.min(audio.length, offset + 480000 - this.samples);
      this.stream.addAudio(audio.subarray(offset, end), 16000); this.samples += end - offset; offset = end;
      this.stream.transcribe();
      if (this.failure) throw this.failure;
      if (this.samples === 480000) { this.finish(); this.open(); }
    }
  }
  finish() {
    if (!this.stream) return;
    try { this.stream.stop(); if (this.failure) throw this.failure; }
    finally { this.dispose(); }
  }
  dispose() { this.stream?.close(); this.stream = null; }
}
