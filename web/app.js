import { Microphone, joinAudio } from './audio.js';
import { moonshineModels } from './moonshine-config.js';
import { ReazonSimulation, BUFFER_LIMIT } from './reazon-simulation.js';
const $ = (id) => document.getElementById(id);
const descriptions = {
  sherpa: 'sherpa-onnx 1.13.2, Japanese ReazonSpeech Zipformer (quantized). Non-streaming: finals after a pause, every 20 seconds, or Stop. No partials. About 183 MB of runtime/model files.',
  'sherpa-simulated': 'sherpa-onnx 1.13.2, Japanese ReazonSpeech Zipformer (quantized), same offline model/runtime. Simulated streaming, not native streaming: Silero VAD utterances with 0.8 seconds of pre-roll, provisional (unstable) previews about every 0.5 seconds of active speech, finals after about 0.35 seconds of silence or 12 seconds of speech. Stop finalizes active speech. One decode at a time; slow devices skip superseded previews. Capture stops visibly at 30 seconds of pending audio. About 183 MB of runtime/model files.',
  whisper: 'Transformers.js 3.8.1, multilingual Whisper tiny q8 on WASM CPU. Non-streaming: finals after a pause, every 20 seconds, or Stop. No partials.',
};
let worker, secondWorker, vadWorker, mic, state = 'booting', startedAt, stopAt, captured = 0, queued = 0, loadAt, generation = 0;
let retainedAudio = [], firstReady = false, secondReady = false, vadReady = false;
let simulation, vadQueued = 0, simulationStopping = false;
const twoPass = () => $('backend').value === 'two-pass';
const simulated = () => $('backend').value === 'sherpa-simulated';
const streaming = () => ['moonshine', 'two-pass'].includes($('backend').value);
let firstText = false, firstPartial = false, peakRms = 0, speechStarted = 0, speechCompleted = 0, partialCount = 0, finalCount = 0;
function describe() {
  const moonshine = streaming();
  if (twoPass()) $('language').value = 'ja';
  $('moonshine-options').hidden = !moonshine;
  $('language-help').textContent = twoPass()
    ? 'Two-pass mode uses Japanese only because ReazonSpeech is Japanese-specific.'
    : 'Language selects a monolingual model; Auto is unavailable. Try Japanese speech with English terms in both models.';
  const model = moonshineModels[$('language').value];
  $('description').textContent = moonshine
    ? `@moonshine-ai/moonshine-wasm 0.1.5 API, official v0.1.5 release runtime, WASM SIMD + threads, ${model.name} (ModelArch.SmallStreaming / 4), ${model.release}. Named model-file loader; no fallback. max_tokens_per_second=${model.options?.max_tokens_per_second ?? 'upstream default'}. VAD threshold ${$('vad-threshold').value}. Native partial/final events. No automatic language detection.`
    : descriptions[$('backend').value];
  if (twoPass()) $('description').textContent += ' Japanese-only two-pass experiment: retain the same 16 kHz microphone audio; after Stop, sherpa-onnx 1.13.2 / ReazonSpeech decodes the whole utterance. Both models are loaded; no second-pass inference while recording.';
  $('partial-heading').textContent = twoPass() ? 'Moonshine streaming transcript (first pass)' : simulated() ? 'Provisional transcript (unstable, simulated streaming)' : 'Partial transcript';
  $('first-pass-lines').hidden = !twoPass();
  $('final-heading').textContent = twoPass() ? 'ReazonSpeech final transcript (second pass)' : 'Final transcript';
  for (const id of ['partial', 'final']) $(id).lang = moonshine ? $('language').value : 'ja';
}
function diagnostics() {
  $('speech').textContent = streaming()
    ? `${speechStarted} native VAD segment(s) accepted; ${speechCompleted} completed. ${speechStarted ? 'Speech detected.' : 'No speech segment reported.'}`
    : simulated() ? `${speechStarted} Silero VAD utterance(s) accepted; ${speechCompleted} completed. ${speechStarted ? 'Speech detected.' : 'Waiting for speech.'}` : 'Native VAD state unavailable for this backend; all captured audio is retained for segmentation.';
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
  if (twoPass()) $('language').disabled = true;
}
function resetOutput() {
  for (const id of ['init', 'first-partial', 'first-text', 'latency', 'audio']) $(id).textContent = '—';
  $('partial').textContent = streaming() || simulated() ? 'Waiting for speech…' : 'Unsupported by this non-streaming model.';
  $('first-pass-lines').textContent = ''; retainedAudio = [];
  $('final').textContent = ''; $('progress').textContent = ''; $('errors').textContent = '';
  captured = queued = peakRms = speechStarted = speechCompleted = partialCount = finalCount = 0;
  firstText = firstPartial = false; $('signal').textContent = 'No capture yet.'; diagnostics();
}
async function release() {
  generation++;
  // Terminate first, so in-flight results cannot repopulate a canceled session.
  worker?.terminate(); worker = null;
  secondWorker?.terminate(); secondWorker = null;
  vadWorker?.terminate(); vadWorker = null;
  simulation = null; vadQueued = 0; simulationStopping = false;
  retainedAudio = []; firstReady = secondReady = vadReady = false;
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
  captured += audio.length;
  if (!simulated()) queued += audio.length;
  const rms = Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);
  peakRms = Math.max(peakRms, rms); $('level').value = rms;
  const db = (value) => value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : '−∞ dBFS';
  $('signal').textContent = `RMS ${db(rms)}; session peak RMS ${db(peakRms)}. ${peakRms > 0 ? 'Nonzero microphone signal reached the app (may be noise).' : 'Audio frames received, but signal is zero.'}`;
  if (simulated()) {
    try {
      if (vadQueued + simulation.waiting + audio.length > BUFFER_LIMIT) {
        throw new Error('Backend is over 30 seconds behind. Capture stopped; retry with shorter utterances.');
      }
      vadQueued += audio.length; queued = vadQueued + simulation.waiting;
      vadWorker.postMessage({ type: 'vad-audio', audio, session: generation }, [audio.buffer]);
    }
    catch (error) { void fail(error); return; }
    $('audio').textContent = `${(captured / 16000).toFixed(1)} s / ${(queued / 16000).toFixed(1)} s`;
    return;
  }
  $('audio').textContent = `${(captured / 16000).toFixed(1)} s / ${(queued / 16000).toFixed(1)} s`;
  // Fail visibly rather than letting a slow phone queue unbounded microphone audio.
  if (queued > 30 * 16000) { void fail(new Error('Backend is over 30 seconds behind. Capture stopped; retry with shorter utterances.')); return; }
  // Copy before transferring ownership to Moonshine; keep every captured sample.
  if (twoPass()) retainedAudio.push(audio.slice());
  worker.postMessage({ type: 'audio', audio, session: generation }, [audio.buffer]);
}
function receive({ data }, second = false, vad = false) {
  if (data.session !== undefined && data.session !== generation) return;
  if (data.type === 'error') { void fail(new Error(data.message)); return; }
  if (data.type === 'progress') $('progress').textContent = data.message;
  else if (data.type === 'ready') {
    if (vad) vadReady = true; else if (second) secondReady = true; else firstReady = true;
    if (!firstReady || (twoPass() && !secondReady) || (simulated() && !vadReady)) return;
    $('init').textContent = time(performance.now() - loadAt);
    $('progress').textContent = twoPass() ? 'Both models loaded.' : 'Model loaded.'; setState('ready', 'Ready. Tap Start microphone.');
  } else if (data.type === 'ack') {
    queued -= data.samples;
    $('audio').textContent = `${(captured / 16000).toFixed(1)} s / ${(queued / 16000).toFixed(1)} s`;
  } else if (data.type === 'vad' && simulated()) {
    try {
      for (const frame of data.frames) {
        vadQueued -= frame.audio.length;
        simulation.push(frame.audio, frame.speaking);
        if (vadQueued + simulation.waiting > BUFFER_LIMIT) {
          throw new Error('Backend is over 30 seconds behind. Capture stopped; retry with shorter utterances.');
        }
      }
      queued = vadQueued + simulation.waiting;
    } catch (error) { void fail(error); return; }
    $('audio').textContent = `${(captured / 16000).toFixed(1)} s / ${(queued / 16000).toFixed(1)} s`;
  } else if (data.type === 'vad-stopped' && simulated()) {
    simulation.stop();
  } else if (data.type === 'decoded' && simulated()) {
    simulation.decoded(); queued = vadQueued + simulation.waiting;
    $('audio').textContent = `${(captured / 16000).toFixed(1)} s / ${(queued / 16000).toFixed(1)} s`;
  } else if (data.type === 'speech') {
    if (data.event === 'started') speechStarted++;
    else if (data.event === 'completed') speechCompleted++;
    diagnostics();
  } else if (['partial', 'final'].includes(data.type)) {
    if (simulated() && data.type === 'partial' &&
        (simulationStopping || !simulation.acceptsPartial(data.id))) return;
    if (data.text.trim()) {
      if (data.type === 'partial') partialCount++; else finalCount++;
      diagnostics();
    }
    if (data.text.trim() && !firstText) { firstText = true; $('first-text').textContent = time(performance.now() - startedAt); }
    if (data.type === 'partial') {
      if (data.text.trim() && !firstPartial) { firstPartial = true; $('first-partial').textContent = time(performance.now() - startedAt); }
      $('partial').textContent = data.text;
    } else {
      if (twoPass() && !second) {
        $('first-pass-lines').textContent += `${data.text}\n`;
        $('partial').textContent = 'Waiting for speech…';
        return;
      }
      if (!simulated() || data.text.trim()) $('final').textContent += `${data.text}\n`;
      if (simulated()) $('partial').textContent = '';
      if ($('backend').value === 'moonshine') $('partial').textContent = 'Waiting for speech…';
    }
  } else if (data.type === 'stopped') {
    if (state !== 'stopping') return;
    if (twoPass() && !second) {
      setState('stopping', 'Decoding ReazonSpeech final transcript…');
      const audio = joinAudio(retainedAudio); retainedAudio = [];
      secondWorker.postMessage({ type: 'utterance', audio, session: generation }, [audio.buffer]);
      return;
    }
    $('latency').textContent = time(performance.now() - stopAt);
    setState('ready', 'Stopped. Results are final; tap Start to repeat or switch backends.');
  }
}
$('load').onclick = async () => {
  setState('loading', 'Loading model…');
  await release(); resetOutput(); loadAt = performance.now();
  try {
    const backend = $('backend').value;
    const sherpa = backend === 'sherpa' || simulated();
    worker = new Worker(sherpa ? './sherpa-worker.js' : './model-worker.js', { type: sherpa ? 'classic' : 'module' });
    const activeWorker = worker;
    worker.onmessage = (event) => { if (worker === activeWorker) receive(event); };
    worker.onerror = (event) => { event.preventDefault(); if (worker === activeWorker) void fail(new Error(event.message)); };
    if (twoPass()) {
      secondWorker = new Worker('./sherpa-worker.js');
      const activeSecondWorker = secondWorker;
      secondWorker.onmessage = (event) => { if (secondWorker === activeSecondWorker) receive(event, true); };
      secondWorker.onerror = (event) => { event.preventDefault(); if (secondWorker === activeSecondWorker) void fail(new Error(event.message)); };
      secondWorker.postMessage({ type: 'load' });
    }
    if (simulated()) {
      vadWorker = new Worker('./silero-worker.js');
      const activeVadWorker = vadWorker;
      vadWorker.onmessage = (event) => { if (vadWorker === activeVadWorker) receive(event, false, true); };
      vadWorker.onerror = (event) => { event.preventDefault(); if (vadWorker === activeVadWorker) void fail(new Error(event.message)); };
      vadWorker.postMessage({ type: 'load' });
    }
    worker.postMessage({ type: 'load', backend: twoPass() ? 'moonshine' : backend, language: twoPass() ? 'ja' : $('language').value, vadThreshold: $('vad-threshold').value }); setState('loading', 'Loading model…');
  } catch (error) { await fail(error); }
};
$('start').onclick = async () => {
  setState('starting', 'Requesting microphone…');
  const init = $('init').textContent; resetOutput(); $('init').textContent = init;
  const activeWorker = worker, session = ++generation;
  const isCurrent = () => worker === activeWorker && generation === session;
  if (simulated()) {
    vadQueued = 0; simulationStopping = false;
    vadWorker.postMessage({ type: 'vad-start', session });
    simulation = new ReazonSimulation(
      (message) => activeWorker.postMessage({ ...message, session }, [message.audio.buffer]),
      () => { if (isCurrent()) receive({ data: { type: 'stopped', session } }); },
      (event) => { if (isCurrent()) receive({ data: { type: 'speech', event, session } }); },
    );
  } else activeWorker.postMessage({ type: 'start', session });
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
  if (simulated()) simulationStopping = true;
  stopAt = performance.now(); setState('stopping', 'Finalizing…');
  const previousMic = mic, activeWorker = worker, session = generation; mic = null;
  await previousMic?.stop();
  // Cancel/reload can finish while the old worklet is still flushing.
  if (worker !== activeWorker || generation !== session) return;
  $('level').value = 0;
  if (simulated()) vadWorker.postMessage({ type: 'vad-stop', session });
  else activeWorker.postMessage({ type: 'stop', session });
}
$('stop').onclick = () => void stop();
$('cancel').onclick = async () => { setState('booting', 'Releasing…'); await release(); if (twoPass() || simulated()) resetOutput(); setState('idle', 'Canceled. Load a model to continue.'); };
async function changeConfiguration() {
  setState('booting', 'Switching…'); await release(); resetOutput();
  describe(); setState('idle', 'Load this model to begin.');
}
for (const id of ['backend', 'language', 'vad-threshold']) $(id).onchange = changeConfiguration;
document.addEventListener('visibilitychange', () => { if (document.hidden) void stop(); });
window.addEventListener('pagehide', () => {
  const media = mic?.media;
  void release();
  media?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
});
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
