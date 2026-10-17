import { MONO_16KHZ_PCM, TEXT } from './transcription-nodes.js';
import { OptionalAsrNode } from './optional-asr-node.js';
import { OptionalAsrCore } from './optional-asr-core.js';

export class SpeechToTextMoonshineMediumEnNode extends OptionalAsrNode {
  inputs = { audio: MONO_16KHZ_PCM };
  outputs = { provisional: TEXT, final: TEXT };
  constructor({ workerFactory, ...options } = {}) {
    super(options);
    this.core = new OptionalAsrCore(event => this.receiveEvent(event), { workerFactory, workerPath: './moonshine-medium-worker.js', label: 'Moonshine Medium English Streaming' });
  }
  receive(port, value) {
    if (port !== 'audio') throw Error(`Unknown Moonshine Medium input: ${port}`);
    this.core.push(value);
  }
}
