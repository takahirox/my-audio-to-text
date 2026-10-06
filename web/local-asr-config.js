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
  pendingAudioSeconds: 30,
});

export const SILERO_CONFIG = Object.freeze({
  sileroVad: Object.freeze({ model: './silero_vad.onnx', threshold: 0.5, windowSize: 512,
    minSpeechDuration: 1 / ASR_CONFIG.sampleRate, minSilenceDuration: 1 / ASR_CONFIG.sampleRate,
    maxSpeechDuration: ASR_CONFIG.maxUtteranceSeconds }),
  sampleRate: ASR_CONFIG.sampleRate, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 2,
});
