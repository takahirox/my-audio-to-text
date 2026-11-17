import { MONO_16KHZ_PCM, asrOutputs } from './transcription-nodes.js';
import { OptionalAsrNode } from './optional-asr-node.js';
import { OptionalAsrCore } from './optional-asr-core.js';

export class SpeechToTextMoonshineSmallJaNode extends OptionalAsrNode {
  inputs = { audio: MONO_16KHZ_PCM };
  outputs = asrOutputs();
  constructor({ workerFactory, ...options } = {}) {
    super(options);
    this.core = new OptionalAsrCore(event => this.receiveEvent(event), { workerFactory, workerPath: './moonshine-small-ja-worker.js', label: 'Moonshine Small Streaming Japanese' });
  }
  receive(port, value) {
    if (port !== 'audio') throw Error(`Unknown Moonshine Small input: ${port}`);
    this.core.push(value);
  }
}
