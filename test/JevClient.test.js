const test = require('node:test');
const assert = require('node:assert');

const {
  JevClient,
  JEV_ENDPOINT,
  JEV_MODEL,
  JUNK_NOUL_THRESHOLD,
  JEV_TIMEOUT_MS,
} = require('../src/JevClient');

const API_KEY = 'test-key';

function warningsOf(t) {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => {
    warnings.push(args.map(part => String(part)).join(' '));
  });
  return warnings;
}

function jevResult(noul) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: JEV_MODEL,
      answers: { is_junk: { type: 'noul', noul } },
    }),
  };
}

test('Jev is pinned to jev-1.14.0 and times out within two to three seconds', () => {
  assert.strictEqual(JEV_MODEL, 'jev-1.14.0');
  assert.notStrictEqual(JEV_MODEL, 'jev-latest');
  assert.ok(JEV_TIMEOUT_MS >= 2000 && JEV_TIMEOUT_MS <= 3000);
  assert.strictEqual(JUNK_NOUL_THRESHOLD, 0.7);
});

test('a missing key fails open without calling Jev', async (t) => {
  const warnings = warningsOf(t);
  let called = false;
  const client = new JevClient({
    apiKey: null,
    fetchImpl: async () => { called = true; throw new Error('should not be called'); },
  });

  assert.strictEqual(await client.isJunk('flask'), false);
  assert.strictEqual(called, false);
  assert.ok(warnings.some(line => /missing/i.test(line)));
});

test('the request sends only the player message and one Noul', async (t) => {
  warningsOf(t);
  let captured;
  const client = new JevClient({
    apiKey: API_KEY,
    fetchImpl: async (url, opts) => {
      captured = { url, opts, body: JSON.parse(opts.body) };
      return jevResult(0.1);
    },
  });

  assert.strictEqual(await client.isJunk('flask'), false);

  assert.strictEqual(captured.url, JEV_ENDPOINT);
  assert.strictEqual(captured.opts.method, 'POST');
  assert.strictEqual(captured.opts.headers.Authorization, `Bearer ${API_KEY}`);
  assert.strictEqual(captured.opts.headers['Content-Type'], 'application/json');
  assert.ok(captured.opts.signal instanceof AbortSignal);
  assert.strictEqual(captured.body.model, 'jev-1.14.0');
  assert.deepStrictEqual(captured.body.state, {
    note: 'This is a player message in an interactive story.',
    message: 'flask',
  });
  assert.deepStrictEqual(Object.keys(captured.body.questions), ['is_junk']);
  const question = captured.body.questions.is_junk;
  assert.strictEqual(question.type, 'noul');
  assert.match(question.instructions, /unintelligible junk/i);
  assert.match(question.criteria.true, /keyboard mashing/i);
  assert.match(question.criteria.false, /healthcheck/i);
  assert.match(question.criteria.false, /continue/);
  assert.match(question.criteria.false, /\byes\b/);
  assert.match(question.criteria.false, /look/);
  assert.match(question.criteria.false, /wait/);
  assert.match(question.criteria.false, /flask/);
  assert.doesNotMatch(JSON.stringify(captured.body), /test-key|Elara|session|secret/i);
});

test('a Noul above 0.7 is junk, and 0.7 or below is not', async (t) => {
  warningsOf(t);
  for (const [noul, junk] of [[0.5, false], [0.7, false], [0.71, true], [0.99, true]]) {
    const client = new JevClient({
      apiKey: API_KEY,
      fetchImpl: async () => jevResult(noul),
    });
    assert.strictEqual(await client.isJunk('plokij'), junk, `noul ${noul}`);
  }
});

test('HTTP 500 fails open', async (t) => {
  const warnings = warningsOf(t);
  const client = new JevClient({
    apiKey: API_KEY,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });

  assert.strictEqual(await client.isJunk('flask'), false);
  assert.ok(warnings.some(line => /HTTP 500/.test(line)));
  assert.ok(warnings.every(line => !line.includes(API_KEY)));
});

test('a timeout fails open', async (t) => {
  const warnings = warningsOf(t);
  const client = new JevClient({
    apiKey: API_KEY,
    fetchImpl: async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    },
  });

  assert.strictEqual(await client.isJunk('flask'), false);
  assert.ok(warnings.some(line => /TimeoutError/.test(line)));
  assert.ok(warnings.every(line => !line.includes(API_KEY)));
});

test('a hung request is aborted by the timeout and fails open', async (t) => {
  const warnings = warningsOf(t);
  let aborted = false;
  const client = new JevClient({
    apiKey: API_KEY,
    timeoutMs: 30,
    fetchImpl: (url, opts) => new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => {
        reject(new Error('signal did not abort'));
      }, 500);
      opts.signal.addEventListener('abort', () => {
        aborted = true;
        clearTimeout(keepAlive);
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        reject(error);
      });
    }),
  });

  assert.strictEqual(await client.isJunk('flask'), false);
  assert.strictEqual(aborted, true);
  assert.ok(warnings.some(line => /TimeoutError/.test(line)));
  assert.ok(warnings.every(line => !line.includes(API_KEY)));
});

test('unreadable JSON and a missing Noul fail open', async (t) => {
  warningsOf(t);
  const unreadable = new JevClient({
    apiKey: API_KEY,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('bad json'); },
    }),
  });
  const missing = new JevClient({
    apiKey: API_KEY,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: { is_junk: { type: 'noul', noul: '0.99' } } }),
    }),
  });

  assert.strictEqual(await unreadable.isJunk('flask'), false);
  assert.strictEqual(await missing.isJunk('flask'), false);
});
