const test = require('node:test');
const assert = require('node:assert');

const NarrationService = require('../src/NarrationService');

const storyManagerStub = {
  getSystemPrompt: () => 'SYSTEM',
  getConcludingDirective: () => 'ENDING DIRECTIVE {variants}',
  getStory: () => ({ content: 'CONTENT', config: {} }),
};

function sessionWithLastOutput(lastOutput) {
  return { session: { story_id: 's', last_llm_output: lastOutput } };
}

function makePrompt(action = 'PROMPT') {
  return { systemContext: 'SYSTEM_CONTEXT', userMessage: action };
}

function toolUseResponse(id) {
  return {
    json: {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'get_last_narration', input: {} }],
    },
  };
}

/**
 * Replaces global.fetch with a stub that returns the queued responses in order.
 * Returns the list of captured request bodies.
 */
function stubFetch(t, responses) {
  const bodies = [];
  const original = global.fetch;

  let call = 0;
  global.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const r = responses[call++];
    if (!r) throw new Error(`Unexpected fetch call #${call}`);
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      headers: new Headers(r.headers || {}),
      json: async () => r.json,
      text: async () => r.text || '',
    };
  };

  t.after(() => { global.fetch = original; });
  return bodies;
}

// Retries wait by default. Tests pass an instant sleep unless they are
// asserting the delay itself.
function kimiService(options = {}) {
  return new NarrationService(storyManagerStub, 'test-key', {
    sleep: async () => {},
    ...options,
  });
}

// AbortSignal.timeout does not keep the event loop alive. A real hung fetch
// does, because the socket is still open. Hold a timer until the signal
// aborts so a stubbed hang still reports the timeout.
function hangUntilAbort(signal) {
  return new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 2 ** 31 - 1);
    const fail = () => {
      clearTimeout(keepAlive);
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      reject(err);
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

test('callLLM: returns the text block on a normal completion', async (t) => {
  stubFetch(t, [
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You wake up.' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(result, 'You wake up.');
});

test('callLLM: sends the api key, model, tools and prompt', async (t) => {
  const bodies = stubFetch(t, [
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  await svc.callLLM(makePrompt('MY PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(bodies[0].model, 'kimi-k2');
  assert.strictEqual(bodies[0].messages[0].content, 'MY PROMPT');
  assert.strictEqual(bodies[0].system, 'SYSTEM_CONTEXT');
  assert.strictEqual(bodies[0].tools[0].name, 'get_last_narration');
});

test('callLLM: throws with the status code when the API returns an error', async (t) => {
  // A 500 is retried once. Both attempts have to fail, or the second fetch
  // runs off the end of the queue and hides this error text.
  const bodies = stubFetch(t, [
    { ok: false, status: 500, text: 'internal boom' },
    { ok: false, status: 500, text: 'internal boom' },
  ]);

  const svc = kimiService();

  await assert.rejects(
    () => svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null)),
    /Kimi API error: 500 - internal boom/
  );
  assert.strictEqual(bodies.length, 2);
});

test('callLLM: throws when the response carries no text block', async (t) => {
  stubFetch(t, [{ json: { stop_reason: 'end_turn', content: [] } }]);

  const svc = new NarrationService(storyManagerStub, 'test-key');

  await assert.rejects(
    () => svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null)),
    /No text response from Kimi/
  );
});

test('callLLM: resolves get_last_narration and continues the conversation', async (t) => {
  const bodies = stubFetch(t, [
    {
      json: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'get_last_narration', input: {} }],
      },
    },
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here it is again.' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput('THE PREVIOUS SCENE'));

  assert.strictEqual(result, 'Here it is again.');
  assert.strictEqual(bodies.length, 2);

  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.strictEqual(toolResult.type, 'tool_result');
  assert.strictEqual(toolResult.tool_use_id, 'tool_1');
  assert.strictEqual(toolResult.content, 'THE PREVIOUS SCENE');
});

test('callLLM: falls back gracefully when there is no previous narration', async (t) => {
  const bodies = stubFetch(t, [
    {
      json: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'get_last_narration', input: {} }],
      },
    },
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Starting fresh.' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(
    bodies[1].messages.at(-1).content[0].content,
    'No previous narration found.'
  );
});

test('callLLM: reports unknown tool names back to the model', async (t) => {
  const bodies = stubFetch(t, [
    {
      json: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'delete_everything', input: {} }],
      },
    },
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.match(bodies[1].messages.at(-1).content[0].content, /Unknown tool: delete_everything/);
});

test('callLLM: breaks out if tool_use is signalled with no tool_use block', async (t) => {
  stubFetch(t, [
    { json: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'orphan text' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(result, 'orphan text');
});

test('callLLM: throws if a tool continuation call fails', async (t) => {
  // A 429 on a continuation is retried once, same as the initial request.
  const bodies = stubFetch(t, [
    {
      json: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'get_last_narration', input: {} }],
      },
    },
    { ok: false, status: 429, text: 'rate limited' },
    { ok: false, status: 429, text: 'rate limited' },
  ]);

  const svc = kimiService();

  await assert.rejects(
    () => svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput('x')),
    /Kimi API error on tool continuation: 429 - rate limited/
  );
  assert.strictEqual(bodies.length, 3);
});

test('callLLM: prepends conversation history as alternating messages', async (t) => {
  const bodies = stubFetch(t, [
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const session = {
    session: { story_id: 's', last_llm_output: null },
    conversation_history: [
      { role: 'user', content: 'I check on Elara' },
      { role: 'assistant', content: 'She looks pale.' },
    ],
  };
  await svc.callLLM(makePrompt('CURRENT PROMPT'), session);

  const msgs = bodies[0].messages;
  assert.strictEqual(msgs.length, 3);
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].content, 'I check on Elara');
  assert.strictEqual(msgs[1].role, 'assistant');
  assert.strictEqual(msgs[1].content, 'She looks pale.');
  assert.strictEqual(msgs[2].role, 'user');
  assert.strictEqual(msgs[2].content, 'CURRENT PROMPT');
});

test('callLLM: sends only the prompt when conversation_history is empty', async (t) => {
  const bodies = stubFetch(t, [
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const session = {
    session: { story_id: 's', last_llm_output: null },
    conversation_history: [],
  };
  await svc.callLLM(makePrompt('PROMPT'), session);

  assert.strictEqual(bodies[0].messages.length, 1);
  assert.strictEqual(bodies[0].messages[0].content, 'PROMPT');
});

test('callLLM: handles missing conversation_history gracefully', async (t) => {
  const bodies = stubFetch(t, [
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const session = { session: { story_id: 's', last_llm_output: null } };
  await svc.callLLM(makePrompt('PROMPT'), session);

  assert.strictEqual(bodies[0].messages.length, 1);
  assert.strictEqual(bodies[0].messages[0].content, 'PROMPT');
});

// --- Tool-round cap ----------------------------------------------------------
// stubFetch throws once its queued responses run out, so these tests fail
// against an uncapped loop instead of hanging.

test('callLLM: after three tool rounds, a further tool_use returns the saved last scene', async (t) => {
  const bodies = stubFetch(t, [
    toolUseResponse('t1'),
    toolUseResponse('t2'),
    toolUseResponse('t3'),
    toolUseResponse('t4'),
  ]);
  const warn = t.mock.method(console, 'warn', () => {});

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput('THE SAVED SCENE'));

  assert.strictEqual(result, 'THE SAVED SCENE');
  // Initial request plus three continuations. The fourth response is still
  // tool_use, and no fourth continuation is sent.
  assert.strictEqual(bodies.length, 4);
  assert.strictEqual(bodies[3].messages.at(-1).content[0].type, 'tool_result');
  assert.strictEqual(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /3-round cap/);
});

test('callLLM: three tool rounds followed by a text reply still works', async (t) => {
  const bodies = stubFetch(t, [
    toolUseResponse('t1'),
    toolUseResponse('t2'),
    toolUseResponse('t3'),
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The scene continues.' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput('THE SAVED SCENE'));

  assert.strictEqual(result, 'The scene continues.');
  assert.strictEqual(bodies.length, 4);
});

test('callLLM: the tool cap throws when there is no saved scene', async (t) => {
  const bodies = stubFetch(t, [
    toolUseResponse('t1'),
    toolUseResponse('t2'),
    toolUseResponse('t3'),
    toolUseResponse('t4'),
  ]);
  const warn = t.mock.method(console, 'warn', () => {});

  const svc = new NarrationService(storyManagerStub, 'test-key');

  await assert.rejects(
    () => svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null)),
    /3-round cap and there is no saved scene/
  );
  assert.strictEqual(bodies.length, 4);
  assert.strictEqual(warn.mock.calls.length, 1);
});

// --- Timeout behaviour -------------------------------------------------------

test('callLLM: defaults to a 60 second timeout', () => {
  const svc = new NarrationService(storyManagerStub, 'test-key');
  assert.strictEqual(svc.timeoutMs, 60000);
});

test('callLLM: timeout is configurable', () => {
  const svc = new NarrationService(storyManagerStub, 'test-key', { timeoutMs: 5000 });
  assert.strictEqual(svc.timeoutMs, 5000);
});

test('callLLM: passes an abort signal to fetch', async (t) => {
  const original = global.fetch;
  let signal;
  global.fetch = async (url, opts) => {
    signal = opts.signal;
    return {
      ok: true,
      status: 200,
      json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
      text: async () => '',
    };
  };
  t.after(() => { global.fetch = original; });

  const svc = new NarrationService(storyManagerStub, 'test-key');
  await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.ok(signal instanceof AbortSignal, 'an AbortSignal should be supplied');
});

test('callLLM: aborts a hung request and reports a timeout', async (t) => {
  const original = global.fetch;
  // Honour the abort signal the way undici does.
  global.fetch = (url, opts) => hangUntilAbort(opts.signal);
  t.after(() => { global.fetch = original; });

  const svc = kimiService({ timeoutMs: 50 });

  await assert.rejects(
    () => svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null)),
    /Kimi API timeout after 50ms \(initial\)/
  );
});

test('callLLM: reports a timeout during a tool continuation', async (t) => {
  const original = global.fetch;
  let call = 0;
  global.fetch = (url, opts) => {
    call++;
    if (call === 1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't1', name: 'get_last_narration', input: {} }],
        }),
        text: async () => '',
      });
    }
    return hangUntilAbort(opts.signal);
  };
  t.after(() => { global.fetch = original; });

  const svc = kimiService({ timeoutMs: 50 });

  await assert.rejects(
    () => svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput('x')),
    /Kimi API timeout after 50ms \(tool continuation\)/
  );
});

test('callLLM: propagates non-abort network errors unchanged', async (t) => {
  const original = global.fetch;
  let calls = 0;
  // A network error is retried once, so fetch runs twice. The error that
  // propagates is still the rejection from fetch, unchanged.
  global.fetch = async () => {
    calls += 1;
    throw new Error('ECONNREFUSED');
  };
  t.after(() => { global.fetch = original; });

  const svc = kimiService();

  await assert.rejects(() => svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null)), /ECONNREFUSED/);
  assert.strictEqual(calls, 2);
});

function scene(text) {
  return { json: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } };
}

function recordSleep() {
  const sleeps = [];
  return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

// --- One retry ----------------------------------------------------------------
// A timeout, a network error, HTTP 429 and HTTP 5xx are tried once more.
// Any other 4xx is not. The wait is injectable so these tests do not sleep.

test('callLLM: retries a 500 and then returns the scene', async (t) => {
  const bodies = stubFetch(t, [
    { ok: false, status: 500, text: 'internal boom' },
    scene('The lantern steadies.'),
  ]);
  const warn = t.mock.method(console, 'warn', () => {});
  const timing = recordSleep();
  const svc = kimiService({ sleep: timing.sleep });

  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(result, 'The lantern steadies.');
  assert.strictEqual(bodies.length, 2);
  assert.deepStrictEqual(timing.sleeps, [1000]);
  assert.strictEqual(warn.mock.calls.length, 1);
  const warning = String(warn.mock.calls[0].arguments[0]);
  assert.match(warning, /Retrying Kimi initial request once \(HTTP 500\)/);
  assert.ok(!warning.includes('test-key'));
  assert.ok(!/retry-after/i.test(warning));
  assert.ok(!/x-api-key/i.test(warning));
});

test('callLLM: a 429 with Retry-After 2 waits 2000ms', async (t) => {
  const bodies = stubFetch(t, [
    { ok: false, status: 429, text: 'slow down', headers: { 'Retry-After': '2' } },
    scene('The page clears.'),
  ]);
  const timing = recordSleep();
  const svc = kimiService({ sleep: timing.sleep });

  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(result, 'The page clears.');
  assert.strictEqual(bodies.length, 2);
  assert.deepStrictEqual(timing.sleeps, [2000]);
});

test('callLLM: caps a Retry-After above 5 seconds at 5000ms', async (t) => {
  stubFetch(t, [
    { ok: false, status: 429, text: 'slow down', headers: { 'Retry-After': '30' } },
    scene('On we go.'),
  ]);
  const timing = recordSleep();
  const svc = kimiService({ sleep: timing.sleep });

  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(result, 'On we go.');
  assert.deepStrictEqual(timing.sleeps, [5000]);
});

test('callLLM: does not retry a 400', async (t) => {
  const bodies = stubFetch(t, [
    { ok: false, status: 400, text: 'bad request' },
    scene('should not be fetched'),
  ]);
  const warn = t.mock.method(console, 'warn', () => {});
  const timing = recordSleep();
  const svc = kimiService({ sleep: timing.sleep });

  await assert.rejects(
    () => svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null)),
    /Kimi API error: 400 - bad request/
  );
  assert.strictEqual(bodies.length, 1);
  assert.deepStrictEqual(timing.sleeps, []);
  assert.strictEqual(warn.mock.calls.length, 0);
});

test('callLLM: two 503s throw after two fetches', async (t) => {
  const bodies = stubFetch(t, [
    { ok: false, status: 503, text: 'unavailable' },
    { ok: false, status: 503, text: 'unavailable' },
  ]);
  const svc = kimiService();

  await assert.rejects(
    () => svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null)),
    /Kimi API error: 503 - unavailable/
  );
  assert.strictEqual(bodies.length, 2);
});

test('callLLM: retries a timeout and then returns the scene', async (t) => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = (url, opts) => {
    calls += 1;
    if (calls === 1) return hangUntilAbort(opts.signal);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'The scene returns.' }] }),
      text: async () => '',
    });
  };
  t.after(() => { global.fetch = original; });

  const timing = recordSleep();
  const svc = kimiService({ timeoutMs: 30, sleep: timing.sleep });

  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(result, 'The scene returns.');
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(timing.sleeps, [1000]);
});

test('callLLM: retries a tool continuation without counting a tool round', async (t) => {
  const bodies = stubFetch(t, [
    toolUseResponse('t1'),
    toolUseResponse('t2'),
    { ok: false, status: 503, text: 'unavailable' },
    toolUseResponse('t3'),
    scene('The path clears.'),
  ]);
  const warn = t.mock.method(console, 'warn', () => {});
  const timing = recordSleep();
  const svc = kimiService({ sleep: timing.sleep });

  const result = await svc.callLLM(makePrompt('PROMPT'), sessionWithLastOutput('THE SAVED SCENE'));

  // Three tool rounds still finish, and the retry is an extra fetch inside
  // one of them. The cap does not substitute the saved scene.
  assert.strictEqual(result, 'The path clears.');
  assert.strictEqual(bodies.length, 5);
  assert.strictEqual(bodies[2].messages.at(-1).content[0].type, 'tool_result');
  assert.deepStrictEqual(bodies[2].messages, bodies[3].messages);
  assert.deepStrictEqual(timing.sleeps, [1000]);
  assert.strictEqual(warn.mock.calls.length, 1);
  const warning = String(warn.mock.calls[0].arguments[0]);
  assert.match(warning, /Retrying Kimi tool continuation request once \(HTTP 503\)/);
  assert.doesNotMatch(warning, /round cap/);
  assert.ok(!warning.includes('test-key'));
});
