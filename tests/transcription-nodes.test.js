import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicrophoneAudioNode, TranscriptOutputNode, MONO_16KHZ_PCM } from '../web/transcription-nodes.js';
test('capture and transcript adapters preserve their public contracts', () => {
  assert.deepEqual(new MicrophoneAudioNode().outputs, { audio: MONO_16KHZ_PCM });
  const values = [], sink = new TranscriptOutputNode((...args) => values.push(args));
  const signal = new AbortController().signal;
  sink.receive('provisional', 'こんにちは', { signal }); sink.receive('final', '今日は晴れです。', { signal });
  assert.deepEqual(values, [['provisional', 'こんにちは', signal], ['final', '今日は晴れです。', signal]]);
});
