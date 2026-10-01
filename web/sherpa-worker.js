/* global OfflineRecognizer */
let recognizer, segmenter;
const send = (type, values = {}) => postMessage({ type, ...values });
const fail = (error) => send('error', { message: error.message || String(error) });
let sequence = Promise.resolve();
self.onmessage = ({ data }) => { sequence = sequence.then(() => handle(data)).catch(fail); };

async function load() {
  const base = new URL('./vendor/sherpa/', self.location.href);
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
  recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: './transducer-encoder.onnx', decoder: './transducer-decoder.onnx', joiner: './transducer-joiner.onnx' },
      tokens: './tokens.txt', modelType: 'transducer', numThreads: 1, provider: 'cpu', debug: 0,
    },
    decodingMethod: 'greedy_search',
  }, self.Module);
  if (!recognizer.handle) throw new Error('ReazonSpeech recognizer initialization failed');
}
function recognize(audio) {
  const stream = recognizer.createStream();
  try {
    stream.acceptWaveform(16000, audio); recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    if (result.text.trim()) send('final', { text: result.text.trim() });
  } finally { stream.free(); }
}
async function handle(data) {
  if (data.type === 'load') { await load(); send('ready'); }
  else if (data.type === 'start') {
    const { Segmenter } = await import('./audio.js');
    segmenter = new Segmenter(); send('started');
  } else if (data.type === 'audio') {
    const audio = segmenter.push(data.audio); if (audio) recognize(audio);
    send('ack', { samples: data.audio.length });
  } else if (data.type === 'stop') {
    const audio = segmenter.flush(); if (audio) recognize(audio);
    send('stopped');
  }
}
