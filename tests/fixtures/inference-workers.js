export const textProcessingWorkerFixture = `
  self.onmessage = ({ data: { type, id } }) => {
    if (type === 'load') postMessage({ type: 'ready', id });
    if (type === 'process') postMessage({ type: 'result', id, result: 'Ready summary' });
    if (type === 'drain') postMessage({ type: 'drained', id });
  };`;

export const streamingTtsWorkerFixture = `
  let id, sequence;
  const now = () => performance.timeOrigin + performance.now();
  const emit = () => postMessage({
    type: 'chunk', id, sequence: sequence++, at: now(),
    samples: Float32Array.from({ length: 2400 }, (_, i) => .2 * Math.sin(i / 10)),
  });
  self.onmessage = ({ data }) => {
    if (data.type === 'load') postMessage({ type: 'ready' });
    if (data.type === 'generate') {
      id = data.id;
      sequence = 0;
      postMessage({ type: 'start', id, sampleRate: 24000, channels: 1, at: now() });
      emit();
    }
    if (data.type === 'ack' && data.id === id) {
      if (sequence < 3) setTimeout(emit, 25);
      else setTimeout(() => postMessage({ type: 'end', id, sequence, at: now() }), 200);
    }
  };`;
