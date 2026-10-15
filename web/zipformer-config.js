// One concrete English online model; these are audio-time bounds, not latency guarantees.
export const ZIPFORMER = Object.freeze({ sampleRate: 16000, chunkSamples: 1600,
  segmentSamples: 12 * 16000, backlogSamples: 30 * 16000, tailSamples: 12800 });
