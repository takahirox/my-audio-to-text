// Real model differential check, packaged by streaming-tts.spec.js only.
import { CosyVoice3Runtime } from './cosyvoice3-runtime.js';
import { cosyVoice3Assets } from '../extension/cosyvoice3-cache.js';
import { streamingCosyVoice3Flow, streamingCosyVoice3Hift } from './cosyvoice3-onnx.js';

const prefix = (mel, frames) => {
  const out = new Float32Array(frames * 80), total = mel.length / 80;
  for (let c = 0; c < 80; c++) out.set(mel.subarray(c * total, c * total + frames), c * frames);
  return out;
};
self.onmessage = async () => {
  let runtime;
  try {
    const read = await cosyVoice3Assets();
    const changed = await streamingCosyVoice3Flow(await read('onnx/flow_step_q8.onnx'));
    const transformSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', changed)), b => b.toString(16).padStart(2, '0')).join('');
    const hift = await streamingCosyVoice3Hift(await read('onnx/hift_q4c8.onnx'));
    const hiftTransformSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', hift)), b => b.toString(16).padStart(2, '0')).join('');
    runtime = await CosyVoice3Runtime.create(read);
    const tokens = Array.from({ length: 500 }, (_, i) => (i * 37 + 1) % 6561);
    const full = await runtime.mel(tokens, true);
    const noise = Float32Array.from({ length: 500 * 2 * 480 * 9 }, (_, i) => (i * 16807 % 2147483647) / 2147483647);
    const boundaries = [], chunks = [];
    for (const count of [44, 169, 494]) {
      const mel = await runtime.mel(tokens.slice(0, count), false), frames = mel.length / 80;
      const frozen = prefix(full, frames);
      let maxMelDifference = 0;
      for (let i = 0; i < mel.length; i++) maxMelDifference = Math.max(maxMelDifference, Math.abs(mel[i] - frozen[i]));
      // Native CosyVoice3 retains accepted mel instead of updating old frames.
      // Isolate HiFT right-context behavior from flow floating-point drift.
      const partial = await runtime.vocode(frozen, noise), emittedSamples = (frames - 8) * 480;
      chunks.push(partial);
      boundaries.push({ speechTokens: count, melFrames: frames, emittedSamples, maxMelDifference });
    }
    const audio = await runtime.vocode(full, noise);
    for (let b = 0; b < boundaries.length; b++) {
      let maxPcmDifference = 0, untrimmedDifference = 0, firstDifference = -1, maxAt = -1;
      const boundary = boundaries[b], partial = chunks[b];
      for (let i = 0; i < boundary.emittedSamples; i++) {
        const difference = Math.abs(partial[i] - audio[i]);
        if (difference > .0001 && firstDifference < 0) firstDifference = i;
        if (difference > maxPcmDifference) { maxPcmDifference = difference; maxAt = i; }
      }
      for (let i = boundary.emittedSamples; i < partial.length; i++) untrimmedDifference = Math.max(untrimmedDifference, Math.abs(partial[i] - audio[i]));
      Object.assign(boundary, { maxPcmDifference, untrimmedDifference, firstDifference, maxAt });
    }
    postMessage({ transformSha256, hiftTransformSha256, finite: full.every(Number.isFinite) && audio.every(Number.isFinite), maxTokens: tokens.length, boundaries });
  } catch (error) { postMessage({ error: error.message || String(error) }); }
  finally { await runtime?.dispose(); }
};
