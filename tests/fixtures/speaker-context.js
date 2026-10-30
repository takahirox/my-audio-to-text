export function speakerContext({ state = 'running', resumeError, holdResume = false, outputError } = {}) {
  const sources = [], played = [];
  return {
    state, destination: {}, sources, played, closes: 0, resumes: 0,
    resume() {
      this.resumes++;
      if (resumeError) return Promise.reject(Error(resumeError));
      if (holdResume) return new Promise(resolve => { this.finishResume = resolve; });
      this.state = 'running'; this.onstatechange?.(); return Promise.resolve();
    },
    createBuffer(channels, length, sampleRate) {
      if (outputError) throw Error(outputError);
      return { channels, length, sampleRate, copyToChannel(samples) { this.samples = samples.slice(); } };
    },
    createBufferSource() {
      const source = { stops: 0, disconnects: 0,
        connect: target => { source.target = target; },
        start: () => {
          if (sources.some(item => item !== source && item.playing)) throw Error('Overlapping clips');
          source.playing = true; played.push(source.buffer.samples[0]);
        },
        stop() { this.stops++; this.playing = false; },
        disconnect() { this.disconnects++; },
        end() { this.playing = false; this.onended?.(); },
      };
      sources.push(source); return source;
    },
    close() { this.closes++; this.state = 'closed'; return Promise.resolve(); },
  };
}
