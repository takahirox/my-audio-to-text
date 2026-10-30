import { portContract } from './pipeline.js';

// Ordered mono PCM events, independent of the synthesizer. IDs increase for the
// lifetime of a producer; sequence counts chunks, starting at zero per utterance.
export const AUDIO_STREAM = portContract('audio-stream');
export const AUDIO_STREAM_LIMITS = Object.freeze({ chunkSeconds: 2, sampleRate: 192000 });

export function validateAudioStream(event) {
  if (!event || !Number.isSafeInteger(event.id) || event.id <= 0) throw new TypeError('Audio stream requires a positive integer utterance id.');
  if (event.type === 'start') {
    if (event.channels !== 1 || !Number.isSafeInteger(event.sampleRate) || event.sampleRate < 8000
        || event.sampleRate > AUDIO_STREAM_LIMITS.sampleRate) throw new TypeError('Audio stream requires mono PCM at 8–192 kHz.');
  } else {
    if (!['chunk', 'end', 'abort'].includes(event.type) || !Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new TypeError('Unknown audio stream event or invalid sequence.');
    }
    if (event.type === 'chunk' && (!(event.samples instanceof Float32Array) || !event.samples.length
        || event.samples.length > AUDIO_STREAM_LIMITS.sampleRate * AUDIO_STREAM_LIMITS.chunkSeconds
        || !event.samples.every(Number.isFinite))) throw new TypeError('Audio stream chunks require bounded, nonempty finite Float32 PCM.');
    if (event.type === 'abort' && typeof event.message !== 'string') throw new TypeError('Audio stream abort requires a message.');
  }
  return event;
}
