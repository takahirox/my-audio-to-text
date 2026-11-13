import { SpeechToTextWhisperNode } from '../../whisper-node.js';
import { mountAsrFilePage } from '../asr-file-page.js';
mountAsrFilePage(SpeechToTextWhisperNode, () => ({ language: document.getElementById('language').value }));
