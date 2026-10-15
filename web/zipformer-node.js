import { SpeechToTextNode, MONO_16KHZ_PCM, TEXT } from './transcription-nodes.js';
import { ZipformerCore } from './zipformer-core.js';

export class SpeechToTextZipformerEnNode extends SpeechToTextNode {
  inputs = { audio: MONO_16KHZ_PCM };
  outputs = { provisional: TEXT, final: TEXT };
  constructor({ workerFactory, ...options } = {}) {
    super(options);
    this.core = new ZipformerCore(event => this.receiveEvent(event), { workerFactory });
  }
  receive(port, value) {
    if (port !== 'audio') throw Error(`Unknown English Zipformer input: ${port}`);
    this.core.push(value);
  }
}
