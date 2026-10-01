import { Microphone } from './audio.js';
const $ = (id) => document.getElementById(id);
const descriptions = {
  moonshine: 'Moonshine Voice 0.1.5, Japanese tiny through the live Stream API with built-in speech detection. Displays runtime partials and finals. The published WASM catalog has a non-streaming Japanese model; Japanese streaming architectures are unavailable in this package.',
  sherpa: 'sherpa-onnx 1.13.2, Japanese ReazonSpeech Zipformer (quantized). Non-streaming: finals after a pause, every 20 seconds, or Stop. No partials. About 183 MB of runtime/model files.',
  whisper: 'Transformers.js 3.8.1, multilingual Whisper tiny q8 on WASM CPU. Non-streaming: finals after a pause, every 20 seconds, or Stop. No partials.',
};
let worker, mic, state = 'booting', startedAt, stopAt, captured = 0, queued = 0, loadAt, generation = 0;
let firstText = false, firstPartial = false;
const time = (ms) => `${(ms / 1000).toFixed(2)} s`;
function setState(next, message) {
  state = next; $('status').textContent = message;
  $('load').disabled = !['idle', 'error'].includes(state);
  $('start').disabled = state !== 'ready';
  $('stop').disabled = state !== 'recording';
  $('cancel').disabled = !worker;
  $('backend').disabled = ['starting', 'recording', 'stopping'].includes(state);
}
function resetOutput() {
  for (const id of ['init', 'first-partial', 'first-text', 'latency', 'audio']) $(id).textContent = '—';
  $('partial').textContent = $('backend').value === 'moonshine' ? 'Waiting for speech…' : 'Unsupported by this non-streaming model.';
  $('final').textContent = ''; $('progress').textContent = ''; $('errors').textContent = '';
  captured = queued = 0; firstText = firstPartial = false;
}
async function release() {
  generation++;
  // Terminate first, so in-flight results cannot repopulate a canceled session.
  worker?.terminate(); worker = null;
  const previousMic = mic; mic = null;
  await previousMic?.stop(); $('level').value = 0;
}
async function fail(error) {
  setState('booting', 'Releasing after error…');
  $('errors').textContent += `${new Date().toISOString()} ${error.message || error}\n`;
  await release(); setState('error', 'Error. See runtime errors below; load again to retry.');
}
function audio(audio) {
  if (!worker || !['starting', 'recording', 'stopping'].includes(state)) return;
  if (!captured) startedAt = performance.now();
  captured += audio.length; queued += audio.length;
  $('level').value = Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);
  $('audio').textContent = `${(captured / 16000).toFixed(1)} s / ${(queued / 16000).toFixed(1)} s`;
  // Fail visibly rather than letting a slow phone queue unbounded microphone audio.
  if (queued > 30 * 16000) { void fail(new Error('Backend is over 30 seconds behind. Capture stopped; retry with shorter utterances.')); return; }
  worker.postMessage({ type: 'audio', audio }, [audio.buffer]);
}
function receive({ data }) {
  if (data.type === 'error') { void fail(new Error(data.message)); return; }
  if (data.type === 'progress') $('progress').textContent = data.message;
  else if (data.type === 'ready') {
    $('init').textContent = time(performance.now() - loadAt);
    $('progress').textContent = 'Model loaded.'; setState('ready', 'Ready. Tap Start microphone.');
  } else if (data.type === 'ack') {
    queued -= data.samples;
    $('audio').textContent = `${(captured / 16000).toFixed(1)} s / ${(queued / 16000).toFixed(1)} s`;
  } else if (['partial', 'final'].includes(data.type)) {
    if (data.text.trim() && !firstText) { firstText = true; $('first-text').textContent = time(performance.now() - startedAt); }
    if (data.type === 'partial') {
      if (data.text.trim() && !firstPartial) { firstPartial = true; $('first-partial').textContent = time(performance.now() - startedAt); }
      $('partial').textContent = data.text;
    } else {
      $('final').textContent += `${data.text}\n`;
      if ($('backend').value === 'moonshine') $('partial').textContent = 'Waiting for speech…';
    }
  } else if (data.type === 'stopped') {
    $('latency').textContent = time(performance.now() - stopAt);
    setState('ready', 'Stopped. Results are final; tap Start to repeat or switch backends.');
  }
}
$('load').onclick = async () => {
  setState('loading', 'Loading model…');
  await release(); resetOutput(); loadAt = performance.now();
  try {
    const backend = $('backend').value;
    worker = new Worker(backend === 'sherpa' ? './sherpa-worker.js' : './model-worker.js', { type: backend === 'sherpa' ? 'classic' : 'module' });
    const activeWorker = worker;
    worker.onmessage = (event) => { if (worker === activeWorker) receive(event); };
    worker.onerror = (event) => { event.preventDefault(); if (worker === activeWorker) void fail(new Error(event.message)); };
    worker.postMessage({ type: 'load', backend }); setState('loading', 'Loading model…');
  } catch (error) { await fail(error); }
};
$('start').onclick = async () => {
  setState('starting', 'Requesting microphone…');
  const init = $('init').textContent; resetOutput(); $('init').textContent = init;
  worker.postMessage({ type: 'start' });
  mic = new Microphone(audio, () => void stop());
  const session = generation;
  try {
    startedAt = performance.now();
    await mic.start();
    if (generation === session && state === 'starting') setState('recording', 'Listening. Speak Japanese, pause, then Stop.');
  } catch (error) { if (generation === session) await fail(error); }
};
async function stop() {
  if (state !== 'recording') return;
  stopAt = performance.now(); setState('stopping', 'Finalizing…');
  const previousMic = mic; mic = null;
  await previousMic?.stop(); $('level').value = 0;
  worker?.postMessage({ type: 'stop' });
}
$('stop').onclick = () => void stop();
$('cancel').onclick = async () => { setState('booting', 'Releasing…'); await release(); setState('idle', 'Canceled. Load a model to continue.'); };
$('backend').onchange = async () => {
  setState('booting', 'Switching…'); await release(); resetOutput();
  $('description').textContent = descriptions[$('backend').value]; setState('idle', 'Load this model to begin.');
};
document.addEventListener('visibilitychange', () => { if (document.hidden) void stop(); });
window.addEventListener('pagehide', () => { worker?.terminate(); mic?.media?.getTracks().forEach((track) => track.stop()); });
window.addEventListener('unhandledrejection', (event) => void fail(event.reason));

async function boot() {
  $('description').textContent = descriptions[$('backend').value]; resetOutput();
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone requires HTTPS or localhost and browser audio capture support.');
  if (!crossOriginIsolated) {
    if (!navigator.serviceWorker) throw new Error('This browser cannot enable the isolation required by the WASM runtimes. Use a server with COOP/COEP headers.');
    await navigator.serviceWorker.register('./isolation-worker.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    const key = `asr-isolation:${location.pathname}`;
    if (sessionStorage.getItem(key)) throw new Error('Browser isolation did not activate. Close other playground tabs, reload, or use a server with COOP/COEP headers.');
    sessionStorage.setItem(key, '1'); location.reload(); return;
  }
  sessionStorage.removeItem(`asr-isolation:${location.pathname}`);
  setState('idle', 'Load a model to begin.');
}
boot().catch(async (error) => {
  await fail(error);
  setState('unavailable', 'Browser setup failed. See runtime errors below.');
});
