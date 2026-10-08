import { Supertonic3TextToSpeechNode } from '../../tts-nodes.js';
import { mountTtsPage } from '../tts-page.js';
mountTtsPage(Supertonic3TextToSpeechNode, () => ({
  language: document.getElementById('language').value, voice: document.getElementById('voice').value,
}));
