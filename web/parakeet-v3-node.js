import { MONO_16KHZ_PCM, TEXT } from './transcription-nodes.js';
import { OptionalAsrNode } from './optional-asr-node.js';
import { OptionalAsrCore } from './optional-asr-core.js';

export class SpeechToTextParakeetV3Node extends OptionalAsrNode {
  inputs = { audio: MONO_16KHZ_PCM };
  outputs = { final: TEXT };
  constructor({ workerFactory, ...options } = {}) {
    super(options);
    this.core = new OptionalAsrCore(event => this.receiveEvent(event), { workerFactory, workerPath: './parakeet-v3-worker.js', label: 'Parakeet v3' });
  }
  receive(port, value) {
    if (port !== 'audio') throw Error(`Unknown Parakeet v3 input: ${port}`);
    this.core.push(value);
  }
}
