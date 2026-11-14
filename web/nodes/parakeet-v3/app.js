import { SpeechToTextParakeetV3Node } from '../../parakeet-v3-node.js';
import { mountAsrFilePage } from '../asr-file-page.js';
mountAsrFilePage(SpeechToTextParakeetV3Node, () => ({}), { requireGpu: true });
