// Observe real browser audio; no replacement renderer or playback clock.
export function observeSpeaker() {
  const NativeAudioContext = window.AudioContext;
  window.speakerEvents = [];
  window.speakerContexts = [];
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) { super(...args); window.speakerContexts.push(this); }
    createBufferSource() {
      const source = super.createBufferSource(), start = source.start.bind(source), stop = source.stop.bind(source);
      const id = window.speakerEvents.filter(event => event.type === 'start').length;
      source.start = (...args) => {
        window.speakerEvents.push({ type: 'start', id, time: this.currentTime, duration: source.buffer.duration,
          firstSample: source.buffer.getChannelData(0)[0] });
        return start(...args);
      };
      source.stop = (...args) => { window.speakerEvents.push({ type: 'stop', id, time: this.currentTime }); return stop(...args); };
      source.addEventListener('ended', () => window.speakerEvents.push({ type: 'end', id, time: this.currentTime }));
      return source;
    }
  };
}
