import { portContract } from './pipeline.js';

// Read-only mono Float32 PCM: { samples, sampleRate, channels: 1 }.
// The single array is the mono channel, at the model's own sample rate.
// This deliberately has a different identity from captured 16 kHz ASR PCM.
export const SYNTHESIZED_AUDIO = portContract('synthesized-audio');

export function validateSynthesizedAudio(audio) {
  if (!(audio?.samples instanceof Float32Array) || !audio.samples.length
      || audio.channels !== 1 || !Number.isSafeInteger(audio.sampleRate) || audio.sampleRate <= 0
      || !audio.samples.every(Number.isFinite)) {
    throw new TypeError('Expected nonempty finite mono Float32 PCM with an explicit positive sample rate and channels: 1.');
  }
  return audio;
}

export class AudioOutputNode {
  inputs = { audio: SYNTHESIZED_AUDIO };
  outputs = {};
  constructor(onAudio) { this.onAudio = onAudio; }
  receive(port, audio, context) {
    if (port !== 'audio') throw new TypeError('Unknown audio input port.');
    return this.onAudio(validateSynthesizedAudio(audio), context.signal);
  }
}

// Small playback/download adapter, independent of every model and runtime.
export function audioToWav(audio) {
  const { samples, sampleRate } = validateSynthesizedAudio(audio);
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const word = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); word(8, 'WAVE');
  word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)), true));
  return new Blob([buffer], { type: 'audio/wav' });
}
