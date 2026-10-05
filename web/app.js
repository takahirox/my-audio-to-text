import { Microphone } from './audio.js';
import { moonshineModels } from './moonshine-config.js';
const $ = (id) => document.getElementById(id);
const descriptions = {
  sherpa: 'sherpa-onnx 1.13.2, Japanese ReazonSpeech Zipformer (quantized). Non-streaming: finals after a pause, every 20 seconds, or Stop. No partials. About 183 MB of runtime/model files.',
  whisper: 'Transformers.js 3.8.1, multilingual Whisper tiny q8 on WASM CPU. Non-streaming: finals after a pause, every 20 seconds, or Stop. No partials.',
};
let worker, mic, state = 'booting', startedAt, stopAt, captured = 0, queued = 0, loadAt, generation = 0;
let firstText = false, firstPartial = false, peakRms = 0, speechStarted = 0, speechCompleted = 0, partialCount = 0, finalCount = 0;
function describe() {
  const moonshine = $('backend').value === 'moonshine';
  $('moonshine-options').hidden = !moonshine;
  const model = moonshineModels[$('language').value];
  $('description').textContent = moonshine
    ? `@moonshine-ai/moonshine-wasm 0.1.5 API, official v0.1.5 release runtime, WASM SIMD + threads, ${model.name} (ModelArch.SmallStreaming / 4), ${model.release}. Named model-file loader; no fallback. max_tokens_per_second=${model.options?.max_tokens_per_second ?? 'upstream default'}. VAD threshold ${$('vad-threshold').value}. Native partial/final events. No automatic language detection.`
    : descriptions[$('backend').value];
  for (const id of ['partial', 'final']) $(id).lang = moonshine ? $('language').value : 'ja';
}
function diagnostics() {
  $('speech').textContent = $('backend').value === 'moonshine'
    ? `${speechStarted} native VAD segment(s) accepted; ${speechCompleted} completed. ${speechStarted ? 'Speech detected.' : 'No speech segment reported.'}`
    : 'Native VAD state unavailable for this backend; all captured audio is retained for segmentation.';
  $('asr-events').textContent = `${partialCount} nonempty partial(s); ${finalCount} nonempty final(s).`;
}
const time = (ms) => `${(ms / 1000).toFixed(2)} s`;
function setState(next, message) {
  state = next; $('status').textContent = message;
  $('load').disabled = !['idle', 'error'].includes(state);
  $('start').disabled = state !== 'ready';
  $('stop').disabled = state !== 'recording';
  $('cancel').disabled = !worker;
  for (const id of ['backend', 'language', 'vad-threshold']) $(id).disabled = ['booting', 'starting', 'recording', 'stopping'].includes(state);
}
function resetOutput() {
  for (const id of ['init', 'first-partial', 'first-text', 'latency', 'audio']) $(id).textContent = '—';
  $('partial').textContent = $('backend').value === 'moonshine' ? 'Waiting for speech…' : 'Unsupported by this non-streaming model.';
  $('final').textContent = ''; $('progress').textContent = ''; $('errors').textContent = '';
  captured = queued = peakRms = speechStarted = speechCompleted = partialCount = finalCount = 0;
  firstText = firstPartial = false; $('signal').textContent = 'No capture yet.'; diagnostics();
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
  const rms = Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);
  peakRms = Math.max(peakRms, rms); $('level').value = rms;
  const db = (value) => value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : '−∞ dBFS';
  $('signal').textContent = `RMS ${db(rms)}; session peak RMS ${db(peakRms)}. ${peakRms > 0 ? 'Nonzero microphone signal reached the app (may be noise).' : 'Audio frames received, but signal is zero.'}`;
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
  } else if (data.type === 'speech') {
    if (data.event === 'started') speechStarted++;
    else if (data.event === 'completed') speechCompleted++;
    diagnostics();
  } else if (['partial', 'final'].includes(data.type)) {
    if (data.text.trim()) {
      if (data.type === 'partial') partialCount++; else finalCount++;
      diagnostics();
    }
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
    worker.postMessage({ type: 'load', backend, language: $('language').value, vadThreshold: $('vad-threshold').value }); setState('loading', 'Loading model…');
  } catch (error) { await fail(error); }
};
$('start').onclick = async () => {
  setState('starting', 'Requesting microphone…');
  const init = $('init').textContent; resetOutput(); $('init').textContent = init;
  const activeWorker = worker, session = ++generation;
  const isCurrent = () => worker === activeWorker && generation === session;
  activeWorker.postMessage({ type: 'start' });
  mic = new Microphone(
    (chunk) => { if (isCurrent()) audio(chunk); },
    () => { if (isCurrent()) void stop(); },
  );
  try {
    startedAt = performance.now();
    await mic.start();
    if (isCurrent() && state === 'starting') setState('recording', 'Listening. Speak the test utterance, pause, then Stop.');
  } catch (error) { if (isCurrent()) await fail(error); }
};
async function stop() {
  if (state !== 'recording') return;
  stopAt = performance.now(); setState('stopping', 'Finalizing…');
  const previousMic = mic, activeWorker = worker, session = generation; mic = null;
  await previousMic?.stop();
  // Cancel/reload can finish while the old worklet is still flushing.
  if (worker !== activeWorker || generation !== session) return;
  $('level').value = 0;
  activeWorker.postMessage({ type: 'stop' });
}
$('stop').onclick = () => void stop();
$('cancel').onclick = async () => { setState('booting', 'Releasing…'); await release(); setState('idle', 'Canceled. Load a model to continue.'); };
async function changeConfiguration() {
  setState('booting', 'Switching…'); await release(); resetOutput();
  describe(); setState('idle', 'Load this model to begin.');
}
for (const id of ['backend', 'language', 'vad-threshold']) $(id).onchange = changeConfiguration;
document.addEventListener('visibilitychange', () => { if (document.hidden) void stop(); });
window.addEventListener('pagehide', () => { worker?.terminate(); mic?.media?.getTracks().forEach((track) => track.stop()); });
window.addEventListener('unhandledrejection', (event) => void fail(event.reason));

async function boot() {
  describe(); resetOutput();
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
