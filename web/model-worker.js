import { Segmenter } from './audio.js';
import { moonshineFiles, moonshineModels } from './moonshine-config.js';

let backend, model, stream, segmenter;
const send = (type, values = {}) => postMessage({ type, ...values });
const fail = (error) => send('error', { message: error.message || String(error) });
let sequence = Promise.resolve();
// Serializing async Whisper inference preserves audio order and Stop semantics.
self.onmessage = ({ data }) => {
  sequence = sequence.then(() => handle(data)).catch(fail);
};
async function recognize(audio) {
  const result = await model(audio, { language: 'japanese', task: 'transcribe', return_timestamps: false });
  if (result.text.trim()) send('final', { text: result.text.trim() });
}
async function handle(data) {
  if (data.type === 'load') {
    backend = data.backend;
    if (backend === 'moonshine') {
      const language = data.language ?? 'ja', vadThreshold = data.vadThreshold ?? '0.5';
      if (!['0.5', '0.2'].includes(vadThreshold)) throw new Error('Unsupported VAD threshold');
      try {
        const { Transcriber, ModelArch } = await import('./vendor/moonshine/index.js');
        model = await Transcriber.loadFromUrls(moonshineFiles(language), { modelArch: ModelArch.SmallStreaming,
          options: { ...moonshineModels[language].options, vad_threshold: vadThreshold },
          onProgress: (loaded, total, file) => send('progress', { message: `${file}: ${(loaded / 1e6).toFixed(1)} / ${total ? (total / 1e6).toFixed(1) : '?'} MB` }),
        });
      } catch (error) {
        throw new Error(`Moonshine ${moonshineModels[language]?.name || language} could not load in the v0.1.5 release WASM runtime. No fallback is used. ${error.message}`);
      }
    } else {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
      env.allowLocalModels = false;
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      model = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
        device: 'wasm', dtype: 'q8', revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
        progress_callback: (p) => send('progress', { message: `${p.file || 'Whisper'}: ${p.progress === undefined ? p.status : p.progress.toFixed(1) + '%'}` }),
      });
    }
    send('ready');
  } else if (data.type === 'start') {
    if (backend === 'moonshine') {
      stream = model.createStream();
      stream.addListener({
        // Lines are created from native VAD segments, even when ASR text is empty.
        onLineStarted: ({ line }) => send('speech', { event: 'started', id: line.id }),
        onLineTextChanged: ({ line }) => send('partial', { text: line.text }),
        onLineCompleted: ({ line }) => {
          send('speech', { event: 'completed', id: line.id });
          send('final', { text: line.text });
        },
        onError: ({ error }) => fail(error),
      });
      stream.start();
    } else segmenter = new Segmenter();
    send('started');
  } else if (data.type === 'audio') {
    if (backend === 'moonshine') { stream.addAudio(data.audio, 16000); stream.transcribe(); }
    else { const audio = segmenter.push(data.audio); if (audio) await recognize(audio); }
    send('ack', { samples: data.audio.length });
  } else if (data.type === 'stop') {
    if (backend === 'moonshine') { stream.stop(); stream.close(); stream = null; }
    else { const audio = segmenter.flush(); if (audio) await recognize(audio); }
    send('stopped');
  }
}
