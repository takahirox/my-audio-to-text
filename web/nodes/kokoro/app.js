import { KokoroTextToSpeechNode } from '../../tts-nodes.js';
import { mountTtsPage } from '../tts-page.js';
mountTtsPage(KokoroTextToSpeechNode, () => ({ voice: document.getElementById('voice').value }));
