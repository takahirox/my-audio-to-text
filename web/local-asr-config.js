// Behavioral baseline shared by the browser core, policy and worker adapters.
// Capture/resampling belongs to the source; these values describe normalized PCM.
export const ASR_CONFIG = Object.freeze({
  sampleRate: 16000,
  model: 'ja-en',
  modelName: 'ReazonSpeech ja-en',
  preRollSeconds: 0.8,
  provisionalIntervalSeconds: 0.5,
  trailingSilenceSeconds: 0.35,
  maxUtteranceSeconds: 12,
  defaultMaxDurationSeconds: 6,
  pendingAudioSeconds: 30,
});

// Keep a full pre-roll (0.8 s) within every supported segment, and stay below
// the existing 12 s model policy / 30 s pending-audio protection.
export function maxDurationSamples(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1 || seconds > ASR_CONFIG.maxUtteranceSeconds) {
    throw new RangeError('SpeechToText.maxDuration must be a finite number from 1 to 12 seconds.');
  }
  return Math.floor(seconds * ASR_CONFIG.sampleRate);
}

export const SILERO_CONFIG = Object.freeze({
  sileroVad: Object.freeze({ model: './silero_vad.onnx', threshold: 0.5, windowSize: 512,
    minSpeechDuration: 1 / ASR_CONFIG.sampleRate, minSilenceDuration: 1 / ASR_CONFIG.sampleRate,
    maxSpeechDuration: ASR_CONFIG.maxUtteranceSeconds }),
  sampleRate: ASR_CONFIG.sampleRate, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 2,
});
