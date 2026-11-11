// Extension-owned source adapter. Audio goes through the existing MicrophoneAudio
// port and ordinary VAD/ASR graph. Never acquires a microphone in offscreen.
export class WebVoicePCM {
  constructor() { this.expected = 0; this.listeners = new Set(); }
  source(audio) {
    return { start: () => { this.listeners.add(audio); },
      stop: () => { this.listeners.delete(audio); } };
  }
  receive(message) {
    if (!this.listeners.size || message.sequence !== this.expected ||
        typeof message.pcm !== 'string' || !message.pcm.length || message.pcm.length > 6828 ||
        message.pcm.length % 4) throw Error('Stale, out-of-order or invalid microphone audio. Click the mic to retry.');
    const binary = atob(message.pcm);
    if (!binary.length || binary.length > 5120 || binary.length % 4) throw Error('Invalid microphone PCM length.');
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const audio = new Float32Array(bytes.buffer);
    if (!audio.every(Number.isFinite)) throw Error('Invalid microphone PCM samples.');
    this.expected++; for (const listener of this.listeners) listener(audio);
  }
}
