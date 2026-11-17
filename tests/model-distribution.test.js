import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { validateGraph } from '../extension/graph.js';

// Historical evidence may describe removed models. Active source and published
// artifacts must never restore their nodes, download paths or dedicated assets.
const retired = /OpusMt|OPUS_MT|opus-(?:mt|ja-en|en-ja|tatoeba)|MarianTokenizer|05470cd69b62aa32e3ee64ccfd41279789ee4b1e|225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e/i;
const textTypes = new Set(['.js', '.json', '.py', '.md', '.html', '.txt', '.yml', '.yaml']);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (path === 'docs/evidence' || ['vendor', 'tts-assets', 'correction-assets', '__pycache__'].includes(entry.name)) return [];
    return entry.isDirectory() ? files(path) : [path];
  });
}

test('active source, documentation and CI contain only current translation models', () => {
  const paths = ['README.md', 'package.json', ...['extension', 'web', 'scripts', 'docs', 'tests', '.github'].flatMap(files)];
  for (const path of paths) {
    if (path === 'tests/model-distribution.test.js' || !textTypes.has(extname(path))) continue;
    assert.doesNotMatch(path, retired);
    assert.doesNotMatch(readFileSync(path, 'utf8'), retired, path);
  }
});

test('Pages staging and packaged extension inventory exclude retired assets and weights', () => {
  for (const directory of ['web', 'dist/chrome-extension']) {
    if (!existsSync(directory)) continue; // CI runs this again after staging/build.
    const paths = readdirSync(directory, { recursive: true });
    for (const path of paths) {
      assert.doesNotMatch(path, retired);
      assert.doesNotMatch(path, /\.(?:onnx(?:_data(?:_\d+)?)?|ort|bin|data|safetensors|gguf|ckpt|model)$/i);
    }
    if (directory.startsWith('dist/')) {
      const inventory = JSON.parse(readFileSync(join(directory, 'asset-inventory.json')));
      assert.equal(inventory.modelWeights, 0);
      for (const { path } of inventory.files) assert.doesNotMatch(path, retired);
      for (const path of ['web/translategemma-worker.js', 'web/plamo-worker.js', 'web/translation-worker.js',
        'web/vendor/translation/transformers.js', 'extension/model-asset-cache.js']) {
        assert.ok(inventory.files.some(file => file.path === path), path);
      }
    }
  }
});

test('published bilingual history example uses executable current graph contracts', () => {
  const graph = JSON.parse(readFileSync('docs/examples/bilingual-history.json'));
  assert.deepEqual(validateGraph(graph), []);
  const gemma = graph.nodes.find(node => node.type === 'TranslateGemma4B');
  assert.ok(gemma);
  for (const [port, code] of [['source_lang','en'], ['target_lang','ja']]) {
    const route = graph.edges.find(route => route.to[0] === gemma.id && route.to[1] === port);
    assert.equal(graph.nodes.find(node => node.id === route.from[0]).settings.value, code);
  }
});
