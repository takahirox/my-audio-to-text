import { Microphone } from './audio.js';
import { LocalAsrCore } from './local-asr-core.js';
const $ = (id) => document.getElementById(id);
let core, mic, state = 'booting', startedAt, stopAt, captured = 0, queued = 0, loadAt, generation = 0;
let firstText = false, firstPartial = false, peakRms = 0, speechStarted = 0, speechCompleted = 0, partialCount = 0, finalCount = 0;
function diagnostics() {
  $('speech').textContent = `${speechStarted} Silero VAD utterance(s) accepted; ${speechCompleted} completed. ${speechStarted ? 'Speech detected.' : 'Waiting for speech.'}`;
  $('asr-events').textContent = `${partialCount} nonempty partial(s); ${finalCount} nonempty final(s).`;
}
const time = (ms) => `${(ms / 1000).toFixed(2)} s`;
function setState(next, message) {
  state = next; $('status').textContent = message;
  $('load').disabled = !['idle', 'error'].includes(state);
  $('start').disabled = state !== 'ready';
  $('stop').disabled = state !== 'recording';
  $('cancel').disabled = !core;
}
function resetOutput() {
  for (const id of ['init', 'first-partial', 'first-text', 'latency', 'audio']) $(id).textContent = '—';
  $('partial').textContent = 'Waiting for speech…';
  $('final').textContent = ''; $('progress').textContent = ''; $('errors').textContent = '';
  captured = queued = peakRms = speechStarted = speechCompleted = partialCount = finalCount = 0;
  firstText = firstPartial = false; $('signal').textContent = 'No capture yet.'; diagnostics();
}
async function release() {
  generation++;
  core?.release(); core = null;
  $('reazon-model').textContent = '—';
  const previousMic = mic; mic = null;
  await previousMic?.stop(); $('level').value = 0;
}
async function fail(error) {
  setState('booting', 'Releasing after error…');
  $('errors').textContent += `${new Date().toISOString()} ${error.message || error}\n`;
  await release(); setState('error', 'Error. See runtime errors below; load again to retry.');
}
function audio(audio) {
  if (!core || !['starting', 'recording', 'stopping'].includes(state)) return;
  if (!captured) startedAt = performance.now();
  captured += audio.length;
  const rms = Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);
  peakRms = Math.max(peakRms, rms); $('level').value = rms;
  const db = (value) => value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : '−∞ dBFS';
  $('signal').textContent = `RMS ${db(rms)}; session peak RMS ${db(peakRms)}. ${peakRms > 0 ? 'Nonzero microphone signal reached the app (may be noise).' : 'Audio frames received, but signal is zero.'}`;
  core.push(audio);
  audioDiagnostics();
}
function audioDiagnostics() {
  $('audio').textContent = `${(captured / 16000).toFixed(1)} s / ${(queued / 16000).toFixed(1)} s`;
}
function receive(data) {
  if (data.type === 'error') { void fail(new Error(data.message)); return; }
  if (data.type === 'configuration') $('reazon-model').textContent = `${data.modelName} (${data.model}); ${data.numThreads} thread(s)`;
  else if (data.type === 'progress') $('progress').textContent = data.message;
  else if (data.type === 'ready') {
    $('init').textContent = time(performance.now() - loadAt);
    $('progress').textContent = 'Model loaded.'; setState('ready', 'Ready. Tap Start microphone.');
  } else if (data.type === 'diagnostics') {
    queued = data.pendingSamples; audioDiagnostics();
  } else if (data.type === 'speech') {
    if (data.event === 'started') speechStarted++;
    else if (data.event === 'completed') speechCompleted++;
    diagnostics();
  } else if (['partial', 'final'].includes(data.type)) {
    if (data.type === 'partial' && state === 'stopping') return;
    if (data.text.trim()) {
      if (data.type === 'partial') partialCount++; else finalCount++;
      diagnostics();
    }
    if (data.text.trim() && !firstText) { firstText = true; $('first-text').textContent = time(performance.now() - startedAt); }
    if (data.type === 'partial') {
      if (data.text.trim() && !firstPartial) { firstPartial = true; $('first-partial').textContent = time(performance.now() - startedAt); }
      $('partial').textContent = data.text;
    } else {
      if (data.text.trim()) $('final').textContent += `${data.text}\n`;
      $('partial').textContent = '';
    }
  } else if (data.type === 'stopped') {
    if (state !== 'stopping') return;
    $('latency').textContent = time(performance.now() - stopAt);
    setState('ready', 'Stopped. Results are final; tap Start to repeat.');
  }
}
$('load').onclick = async () => {
  setState('loading', 'Loading model…');
  await release(); resetOutput(); loadAt = performance.now();
  try {
    core = new LocalAsrCore(receive);
    setState('loading', 'Loading model…');
    core.load();
  } catch (error) { await fail(error); }
};
$('start').onclick = async () => {
  setState('starting', 'Requesting microphone…');
  const init = $('init').textContent; resetOutput(); $('init').textContent = init;
  const activeCore = core, session = ++generation;
  const isCurrent = () => core === activeCore && generation === session;
  core.start();
  if (!isCurrent()) return;
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
  const previousMic = mic, activeCore = core, session = generation; mic = null;
  await previousMic?.stop();
  // Cancel/reload can finish while the old worklet is still flushing.
  if (core !== activeCore || generation !== session) return;
  $('level').value = 0;
  core.stop();
}
$('stop').onclick = () => void stop();
$('cancel').onclick = async () => { setState('booting', 'Releasing…'); await release(); resetOutput(); setState('idle', 'Canceled. Load a model to continue.'); };
document.addEventListener('visibilitychange', () => { if (document.hidden) void stop(); });
window.addEventListener('pagehide', () => {
  const media = mic?.media;
  void release();
  media?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
});
window.addEventListener('unhandledrejection', (event) => void fail(event.reason));

async function boot() {
  resetOutput();
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
