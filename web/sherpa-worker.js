/* global OfflineRecognizer */
let recognizer, session, sampleRate;
const send = (type, values = {}) => postMessage({ type, session, ...values });
const fail = (error) => send('error', { message: error.message || String(error) });
let sequence = Promise.resolve();
self.onmessage = ({ data }) => { sequence = sequence.then(() => handle(data)).catch(fail); };

async function load(requestedThreads) {
  const { ASR_CONFIG } = await import('./local-asr-config.js');
  sampleRate = ASR_CONFIG.sampleRate;
  const { selectReazonThreads } = await import('./reazon-config.js');
  const base = new URL('./vendor/sherpa-ja-en/', self.location.href);
  const script = new URL('sherpa-onnx-wasm-main-vad-asr.js', base).href;
  await new Promise((resolve, reject) => {
    self.Module = {
      noInitialRun: true,
      locateFile: (file) => new URL(file, base).href,
      mainScriptUrlOrBlob: script,
      setStatus: (message) => send('progress', { message }),
      printErr: (message) => send('progress', { message }),
      onAbort: (message) => reject(new Error(String(message))),
      onRuntimeInitialized: resolve,
    };
    importScripts(new URL('sherpa-onnx-asr.js', base).href, script);
  });
  const numThreads = selectReazonThreads({
    hardwareConcurrency: self.navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedMemory: typeof SharedArrayBuffer !== 'undefined' && self.Module.HEAPU8?.buffer instanceof SharedArrayBuffer,
  }, requestedThreads);
  recognizer = new OfflineRecognizer({
    featConfig: { sampleRate, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: './transducer-encoder.onnx', decoder: './transducer-decoder.onnx', joiner: './transducer-joiner.onnx' },
      tokens: './tokens.txt', modelType: 'transducer', numThreads, provider: 'cpu', debug: 0,
    },
    decodingMethod: 'greedy_search',
  }, self.Module);
  if (!recognizer.handle) throw new Error('ReazonSpeech recognizer initialization failed');
  send('configuration', { numThreads, model: ASR_CONFIG.model, modelName: ASR_CONFIG.modelName });
}
function recognize(audio, type, id) {
  const stream = recognizer.createStream();
  try {
    stream.acceptWaveform(sampleRate, audio); recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    send(type, { text: result.text.trim(), id });
  } finally { stream.free(); }
}
async function handle(data) {
  if (data.type === 'load') {
    await load(data.numThreads); send('ready');
  } else if (data.type === 'decode') {
    // The core sends one bounded snapshot at a time and owns coalescing.
    session = data.session;
    recognize(data.audio, data.final ? 'final' : 'partial', data.id);
    send('decoded');
  }
}
