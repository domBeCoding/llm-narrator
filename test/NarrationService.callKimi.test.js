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
      json: async () => r.json,
      text: async () => r.text || '',
    };
  };

  t.after(() => { global.fetch = original; });
  return bodies;
}

test('callKimi: returns the text block on a normal completion', async (t) => {
  stubFetch(t, [
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You wake up.' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const result = await svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(result, 'You wake up.');
});

test('callKimi: sends the api key, model, tools and prompt', async (t) => {
  const bodies = stubFetch(t, [
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  await svc.callKimi(makePrompt('MY PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(bodies[0].model, 'kimi-k2');
  assert.strictEqual(bodies[0].messages[0].content, 'MY PROMPT');
  assert.strictEqual(bodies[0].system, 'SYSTEM_CONTEXT');
  assert.strictEqual(bodies[0].tools[0].name, 'get_last_narration');
});

test('callKimi: throws with the status code when the API returns an error', async (t) => {
  stubFetch(t, [{ ok: false, status: 500, text: 'internal boom' }]);

  const svc = new NarrationService(storyManagerStub, 'test-key');

  await assert.rejects(
    () => svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput(null)),
    /Kimi API error: 500 - internal boom/
  );
});

test('callKimi: throws when the response carries no text block', async (t) => {
  stubFetch(t, [{ json: { stop_reason: 'end_turn', content: [] } }]);

  const svc = new NarrationService(storyManagerStub, 'test-key');

  await assert.rejects(
    () => svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput(null)),
    /No text response from Kimi/
  );
});

test('callKimi: resolves get_last_narration and continues the conversation', async (t) => {
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
  const result = await svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput('THE PREVIOUS SCENE'));

  assert.strictEqual(result, 'Here it is again.');
  assert.strictEqual(bodies.length, 2);

  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.strictEqual(toolResult.type, 'tool_result');
  assert.strictEqual(toolResult.tool_use_id, 'tool_1');
  assert.strictEqual(toolResult.content, 'THE PREVIOUS SCENE');
});

test('callKimi: falls back gracefully when there is no previous narration', async (t) => {
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
  await svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(
    bodies[1].messages.at(-1).content[0].content,
    'No previous narration found.'
  );
});

test('callKimi: reports unknown tool names back to the model', async (t) => {
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
  await svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.match(bodies[1].messages.at(-1).content[0].content, /Unknown tool: delete_everything/);
});

test('callKimi: breaks out if tool_use is signalled with no tool_use block', async (t) => {
  stubFetch(t, [
    { json: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'orphan text' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const result = await svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.strictEqual(result, 'orphan text');
});

test('callKimi: throws if a tool continuation call fails', async (t) => {
  stubFetch(t, [
    {
      json: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'get_last_narration', input: {} }],
      },
    },
    { ok: false, status: 429, text: 'rate limited' },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');

  await assert.rejects(
    () => svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput('x')),
    /Kimi API error on tool continuation: 429 - rate limited/
  );
});

test('callKimi: prepends conversation history as alternating messages', async (t) => {
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
  await svc.callKimi(makePrompt('CURRENT PROMPT'), session);

  const msgs = bodies[0].messages;
  assert.strictEqual(msgs.length, 3);
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].content, 'I check on Elara');
  assert.strictEqual(msgs[1].role, 'assistant');
  assert.strictEqual(msgs[1].content, 'She looks pale.');
  assert.strictEqual(msgs[2].role, 'user');
  assert.strictEqual(msgs[2].content, 'CURRENT PROMPT');
});

test('callKimi: sends only the prompt when conversation_history is empty', async (t) => {
  const bodies = stubFetch(t, [
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const session = {
    session: { story_id: 's', last_llm_output: null },
    conversation_history: [],
  };
  await svc.callKimi(makePrompt('PROMPT'), session);

  assert.strictEqual(bodies[0].messages.length, 1);
  assert.strictEqual(bodies[0].messages[0].content, 'PROMPT');
});

test('callKimi: handles missing conversation_history gracefully', async (t) => {
  const bodies = stubFetch(t, [
    { json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]);

  const svc = new NarrationService(storyManagerStub, 'test-key');
  const session = { session: { story_id: 's', last_llm_output: null } };
  await svc.callKimi(makePrompt('PROMPT'), session);

  assert.strictEqual(bodies[0].messages.length, 1);
  assert.strictEqual(bodies[0].messages[0].content, 'PROMPT');
});

// --- Known defects -----------------------------------------------------------

test('BUG: the tool_use loop has no iteration cap', { skip: 'would loop forever against the current implementation' }, async (t) => {
  // A model that keeps asking for the same tool will loop forever, holding the
  // Discord interaction open and burning tokens. There should be a max-rounds
  // guard (e.g. 5) after which the service gives up.
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `t${calls}`, name: 'get_last_narration', input: {} }],
      }),
      text: async () => '',
    };
  };
  t.after(() => { global.fetch = original; });

  const svc = new NarrationService(storyManagerStub, 'test-key');
  await assert.rejects(() => svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput('x')), /too many tool/i);
});

// --- Timeout behaviour -------------------------------------------------------

test('callKimi: defaults to a 60 second timeout', () => {
  const svc = new NarrationService(storyManagerStub, 'test-key');
  assert.strictEqual(svc.timeoutMs, 60000);
});

test('callKimi: timeout is configurable', () => {
  const svc = new NarrationService(storyManagerStub, 'test-key', { timeoutMs: 5000 });
  assert.strictEqual(svc.timeoutMs, 5000);
});

test('callKimi: passes an abort signal to fetch', async (t) => {
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
  await svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput(null));

  assert.ok(signal instanceof AbortSignal, 'an AbortSignal should be supplied');
});

test('callKimi: aborts a hung request and reports a timeout', async (t) => {
  const original = global.fetch;
  // Honour the abort signal the way undici does.
  global.fetch = (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      reject(err);
    });
  });
  t.after(() => { global.fetch = original; });

  const svc = new NarrationService(storyManagerStub, 'test-key', { timeoutMs: 50 });

  await assert.rejects(
    () => svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput(null)),
    /Kimi API timeout after 50ms \(initial\)/
  );
});

test('callKimi: reports a timeout during a tool continuation', async (t) => {
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
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        reject(err);
      });
    });
  };
  t.after(() => { global.fetch = original; });

  const svc = new NarrationService(storyManagerStub, 'test-key', { timeoutMs: 50 });

  await assert.rejects(
    () => svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput('x')),
    /Kimi API timeout after 50ms \(tool continuation\)/
  );
});

test('callKimi: propagates non-abort network errors unchanged', async (t) => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  t.after(() => { global.fetch = original; });

  const svc = new NarrationService(storyManagerStub, 'test-key');

  await assert.rejects(() => svc.callKimi(makePrompt('PROMPT'), sessionWithLastOutput(null)), /ECONNREFUSED/);
});
