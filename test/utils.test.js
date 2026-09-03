const test = require('node:test');
const assert = require('node:assert');

const { isGibberish } = require('../src/utils');

test('isGibberish: rejects empty and single-character input', () => {
  assert.strictEqual(isGibberish(''), true);
  assert.strictEqual(isGibberish('a'), true);
  assert.strictEqual(isGibberish('   '), true);
});

test('isGibberish: rejects repeated single characters', () => {
  assert.strictEqual(isGibberish('aaa'), true);
  assert.strictEqual(isGibberish('hhhhhh'), true);
  assert.strictEqual(isGibberish('!!!!'), true);
});

test('isGibberish: rejects keyboard row mashing', () => {
  assert.strictEqual(isGibberish('asdfgh'), true);
  assert.strictEqual(isGibberish('qwertyuiop'), true);
  assert.strictEqual(isGibberish('zxcvbnm'), true);
});

test('isGibberish: rejects digit-only and letterless input', () => {
  assert.strictEqual(isGibberish('123'), true);
  assert.strictEqual(isGibberish('4815162342'), true);
  assert.strictEqual(isGibberish('!?!?!?'), true);
});

test('isGibberish: rejects consonant clusters with no vowels', () => {
  assert.strictEqual(isGibberish('bcdfghjk'), true);
});

test('isGibberish: rejects short unrecognised tokens', () => {
  assert.strictEqual(isGibberish('xqz'), true);
  assert.strictEqual(isGibberish('bl'), true);
});

test('isGibberish: accepts short recognised commands', () => {
  for (const word of ['yes', 'no', 'ok', 'go', 'run', 'hi']) {
    assert.strictEqual(isGibberish(word), false, `"${word}" should be accepted`);
  }
});

test('isGibberish: accepts normal game actions', () => {
  const actions = [
    'I look around the room',
    'Check on Master Elara',
    'Ask Tomas for help',
    'Enter the forest alone',
    'I search the shelves for a remedy',
  ];
  for (const action of actions) {
    assert.strictEqual(isGibberish(action), false, `"${action}" should be accepted`);
  }
});

test('isGibberish: is case-insensitive', () => {
  assert.strictEqual(isGibberish('ASDFGH'), true);
  assert.strictEqual(isGibberish('I Look Around'), false);
});

// --- Known defects -----------------------------------------------------------

test('BUG: single words made only of top-row letters are wrongly rejected', { todo: true }, () => {
  // "quiet", "poetry", "tree" are all spelled with letters from qwertyuiop,
  // so /^[qwertyuiop]+$/i flags them as keyboard mashing.
  assert.strictEqual(isGibberish('quiet'), false);
  assert.strictEqual(isGibberish('poetry'), false);
  assert.strictEqual(isGibberish('tree'), false);
});

test('BUG: single words made only of home-row letters are wrongly rejected', { todo: true }, () => {
  assert.strictEqual(isGibberish('flask'), false);
  assert.strictEqual(isGibberish('salads'), false);
});
