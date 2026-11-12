import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareModelDefinitions } from '../extension/model-order.js';

test('model titles use Japanese kana and Latin alphabetical order with natural numbers', () => {
  const titles = ['さくら', 'Model 10', 'いちご', 'beta', 'アオイ', 'Model 2', 'あかね', 'Alpha'];
  const definitions = Object.freeze(titles.map((title, index) => Object.freeze({
    id: String(titles.length - index), title, type: 'Unrelated type', size: '999 MB', voices: ['Z', 'A'],
  })));
  const expected = ['Alpha', 'beta', 'Model 2', 'Model 10', 'アオイ', 'あかね', 'いちご', 'さくら'];
  for (const input of [definitions, [...definitions].reverse()]) {
    const sorted = [...input].sort(compareModelDefinitions);
    assert.deepEqual(sorted.map(definition => definition.title), expected);
    assert.ok(sorted.every(definition => definitions.includes(definition)));
  }
  assert.deepEqual(definitions.map(definition => definition.title), titles);
  const added = { id: 'last-added', title: 'Model 3' };
  assert.deepEqual([...definitions, added].sort(compareModelDefinitions).map(definition => definition.title),
    ['Alpha', 'beta', 'Model 2', 'Model 3', 'Model 10', 'アオイ', 'あかね', 'いちご', 'さくら']);
});

test('equivalent titles use exact title then stable ID tie-breaks, independent of insertion order', () => {
  const definitions = [
    { id: 'a', title: 'alpha' }, { id: 'z', title: 'Alpha' },
    { id: 'b', title: 'Alpha' }, { id: 'n2', title: 'Model 2' },
    { id: 'n02', title: 'Model 02' }, { id: 'kana', title: 'アオイ' }, { id: 'hira', title: 'あおい' },
  ];
  const expected = ['b', 'z', 'a', 'n02', 'n2', 'hira', 'kana'];
  for (const input of [definitions, [...definitions].reverse()]) {
    assert.deepEqual([...input].sort(compareModelDefinitions).map(definition => definition.id), expected);
  }
  assert.equal(compareModelDefinitions(definitions[0], definitions[0]), 0);
});
