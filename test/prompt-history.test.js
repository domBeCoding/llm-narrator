// Earlier turns reach the AI as chat messages, and not a second time inside
// the session state in the final user message. Once the saved history is
// longer than the prompt window, older messages become one recap and the
// recent turns stay word for word. The saved history is never shortened.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const NarrationService = require('../src/NarrationService');
const { PROMPT_HISTORY_TURNS } = NarrationService;
const StoryManager = require('../src/StoryManager');
const SessionManager = require('../src/SessionManager');

const ROOT = path.join(__dirname, '..');
const STORY_ID = 'the-herbalists-choice';

async function loadStories(t) {
  t.mock.method(console, 'log', () => {});
  const storyManager = new StoryManager(path.join(ROOT, 'stories'), path.join(ROOT, 'prompts'));
  await storyManager.loadStoryData();
  return storyManager;
}

async function freshSession() {
  const template = JSON.parse(await fs.readFile(path.join(ROOT, 'sessions', 'session-template.json'), 'utf8'));
  template.session.session_id = 'session-42-1';
  template.session.user_id = '42';
  return template;
}

// Each request the client sends goes through this stub, which answers with
// the next queued reply.
function stubFetch(t, replies) {
  const bodies = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const json = replies.shift();
    if (!json) throw new Error('Unexpected request');
    return { ok: true, status: 200, json: async () => json, text: async () => '' };
  });
  return bodies;
}

function textReply(text) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}

// A story turn's reply: the narration followed by a state block, as the
// system prompt asks for every real story action.
function storyReply(text, turn) {
  const update = { choice_history: { action: `looked closer on turn ${turn}`, consequence: 'saw a little more' } };
  return textReply(`${text}\n\n\`\`\`json\n${JSON.stringify(update)}\n\`\`\``);
}

function narrationFor(turn) {
  return `NARRATION OF TURN ${turn}: the lamplight shifts across the shelves.`;
}

function actionFor(turn) {
  return `ACTION OF TURN ${turn}: I look closer`;
}

// Plays one turn the way Bot does, with the AI's reply supplied, and returns
// the request body that was sent.
async function playTurn(t, svc, session, turn) {
  return playReply(t, svc, session, actionFor(turn), storyReply(narrationFor(turn), turn));
}

// Sends one reader message, with the AI's replies supplied in order, and
// returns the first request body that was sent.
async function playReply(t, svc, session, action, ...replies) {
  const bodies = stubFetch(t, replies);
  const prompt = svc.buildPrompt(session, action);
  const response = await svc.callLLM(prompt, session);
  const { narration, stateUpdate } = svc.parseResponse(response);
  svc.applyStateUpdates(session, stateUpdate, narration, action);
  return bodies[0];
}

function stateBlock(userMessage) {
  const match = userMessage.match(/## Current Session State\n\n```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'the final user message has a session state block');
  return JSON.parse(match[1]);
}

function countIn(text, needle) {
  return text.split(needle).length - 1;
}

const RECAP_LABEL = 'Recap of earlier turns, not a new reader action.';

function messagesFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `HISTORY MESSAGE ${index} UNIQUE`,
  }));
}

// After the fixed label, every remaining word has to be a value or a key
// copied from the structured state the recap is allowed to use.
function assertRecapCopiesStateOnly(recap, session) {
  assert.ok(recap.startsWith(RECAP_LABEL), recap);
  let rest = recap.slice(RECAP_LABEL.length);
  const allowed = [
    'choice_history', 'turn', 'action', 'consequence',
    'flags', 'plot_beats_hit', 'revealed_secrets',
  ];
  for (const entry of session.choice_history || []) {
    for (const key of ['turn', 'action', 'consequence']) {
      const value = entry[key];
      if (typeof value === 'string' && value !== '') allowed.push(value);
      if (typeof value === 'number') allowed.push(String(value));
    }
  }
  const flags = (session.story && session.story.flags) || {};
  for (const [name, value] of Object.entries(flags)) {
    if (value === true) allowed.push(name);
  }
  for (const beat of (session.story && session.story.plot_beats_hit) || []) {
    if (typeof beat === 'string' && beat !== '') allowed.push(beat);
  }
  for (const [name, character] of Object.entries(session.characters || {})) {
    const secrets = character && character.revealed_secrets;
    if (!Array.isArray(secrets) || secrets.length === 0) continue;
    const texts = secrets.filter(secret => typeof secret === 'string' && secret !== '');
    if (texts.length === 0) continue;
    allowed.push(name, ...texts);
  }
  const unique = [...new Set(allowed)].sort((a, b) => b.length - a.length);
  for (const piece of unique) rest = rest.split(piece).join('');
  assert.match(rest, /^\s*$/, `recap added text that is not in the session state: ${JSON.stringify(rest)}`);
}

test('the session state in the final user message leaves out conversation_history and last_llm_output', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  for (let turn = 1; turn <= 3; turn++) await playTurn(t, svc, session, turn);

  const { userMessage } = svc.buildPrompt(session, actionFor(4));
  const state = stateBlock(userMessage);

  assert.strictEqual('conversation_history' in state, false);
  assert.strictEqual('last_llm_output' in state.session, false);
  assert.strictEqual(state.session.turn_count, 3);
  assert.strictEqual(state.reader.name, 'Wren');
});

test('every past turn appears exactly once in the full request', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  for (let turn = 1; turn <= 4; turn++) await playTurn(t, svc, session, turn);

  const body = await playTurn(t, svc, session, 5);
  const everything = [body.system, ...body.messages.map(m => m.content)].join('\n');

  for (let turn = 1; turn <= 4; turn++) {
    assert.strictEqual(countIn(everything, actionFor(turn)), 1, `action of turn ${turn}`);
    assert.strictEqual(countIn(everything, narrationFor(turn)), 1, `narration of turn ${turn}`);
  }
  assert.strictEqual(countIn(everything, actionFor(5)), 1, 'the current action');
});

test('building the prompt does not change the session, and the saved session keeps the full history', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  for (let turn = 1; turn <= 3; turn++) await playTurn(t, svc, session, turn);

  const before = structuredClone(session);
  svc.buildPrompt(session, actionFor(4));
  assert.deepStrictEqual(session, before);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narra-history-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessionManager = new SessionManager(dir, null);
  await sessionManager.saveSession('42', 1, session);
  const saved = await sessionManager.getSessionByNumber('42', 1);

  assert.strictEqual(saved.conversation_history.length, 6);
  assert.deepStrictEqual(saved.conversation_history.at(-1), { role: 'assistant', content: narrationFor(3) });
  assert.strictEqual(saved.session.last_llm_output, narrationFor(3));
});

test('the system prompt and earlier messages are byte-for-byte the same from one turn to the next', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  for (let turn = 1; turn <= 3; turn++) await playTurn(t, svc, session, turn);

  const first = await playTurn(t, svc, session, 4);
  const second = await playTurn(t, svc, session, 5);
  const earlier = first.messages.slice(0, -1);

  assert.strictEqual(second.system, first.system);
  assert.strictEqual(
    JSON.stringify(second.messages.slice(0, earlier.length)),
    JSON.stringify(earlier)
  );
  assert.deepStrictEqual(second.messages.slice(earlier.length, -1), [
    { role: 'user', content: actionFor(4) },
    { role: 'assistant', content: narrationFor(4) },
  ]);
});

test('get_last_narration still returns the last narration after it leaves the state block', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  for (let turn = 1; turn <= 2; turn++) await playTurn(t, svc, session, turn);

  const prompt = svc.buildPrompt(session, 'continue');
  assert.strictEqual('last_llm_output' in stateBlock(prompt.userMessage).session, false);

  const bodies = stubFetch(t, [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool_1', name: 'get_last_narration', input: {} }] },
    textReply(narrationFor(2)),
  ]);
  const result = await svc.callLLM(prompt, session);

  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.strictEqual(toolResult.type, 'tool_result');
  assert.strictEqual(toolResult.content, narrationFor(2));
  assert.strictEqual(result, narrationFor(2));
});

// --- The last scene (get_last_narration) -------------------------------------

const HEALTHCHECK_REPLY = 'The Narrator looks up from the page. \'I am still here. Shall we carry on with the story?\'';
const CLARIFICATION_REPLY = 'The Narrator pauses, quill raised. \'Did you mean you want to leave the apothecary, or look out of the window?\'';

test('a story turn sets last_llm_output to its narration', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();

  await playTurn(t, svc, session, 1);
  assert.strictEqual(session.session.last_llm_output, narrationFor(1));

  await playTurn(t, svc, session, 2);
  assert.strictEqual(session.session.last_llm_output, narrationFor(2));
});

for (const [kind, action, reply] of [
  ['healthcheck', 'you there?', HEALTHCHECK_REPLY],
  ['clarification', 'the thing by the door', CLARIFICATION_REPLY],
]) {
  test(`a ${kind} reply leaves last_llm_output as the last scene`, async (t) => {
    const svc = new NarrationService(await loadStories(t), 'key');
    const session = await freshSession();
    await playTurn(t, svc, session, 1);
    await playTurn(t, svc, session, 2);

    await playReply(t, svc, session, action, textReply(reply));

    assert.strictEqual(session.session.last_llm_output, narrationFor(2));
    // Not a story turn, but the exchange stays in the conversation.
    assert.strictEqual(session.session.turn_count, 2);
    assert.deepStrictEqual(session.conversation_history.slice(-2), [
      { role: 'user', content: action },
      { role: 'assistant', content: reply },
    ]);
    assert.strictEqual(session.choice_history.length, 2);
  });
}

test('resuming after a healthcheck gives back the earlier scene', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  await playTurn(t, svc, session, 1);
  await playTurn(t, svc, session, 2);
  await playReply(t, svc, session, 'hey', textReply(HEALTHCHECK_REPLY));

  const bodies = stubFetch(t, [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool_1', name: 'get_last_narration', input: {} }] },
    textReply(narrationFor(2)),
  ]);
  const prompt = svc.buildPrompt(session, 'continue');
  const response = await svc.callLLM(prompt, session);

  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.strictEqual(toolResult.type, 'tool_result');
  assert.strictEqual(toolResult.content, narrationFor(2));

  // The repeated scene comes back without a state block, and the scene to
  // resume stays the same.
  const { narration, stateUpdate } = svc.parseResponse(response);
  svc.applyStateUpdates(session, stateUpdate, narration, 'continue');
  assert.strictEqual(session.session.last_llm_output, narrationFor(2));
});

test('a healthcheck does not count as a turn, and the next story turn counts as one', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  await playTurn(t, svc, session, 1);
  await playTurn(t, svc, session, 2);
  const activeAt = session.session.last_action_at;

  await new Promise(resolve => setTimeout(resolve, 2));
  await playReply(t, svc, session, 'you there?', textReply(HEALTHCHECK_REPLY));
  assert.strictEqual(session.session.turn_count, 2);
  assert.notStrictEqual(session.session.last_action_at, activeAt, 'the reader was still active');

  await playTurn(t, svc, session, 3);
  assert.strictEqual(session.session.turn_count, 3);
  assert.deepStrictEqual(session.choice_history.map(entry => entry.turn), [1, 2, 3]);
});

// --- Compacting older turns --------------------------------------------------

test('historyForPrompt keeps the last 8 turns and recaps only when older messages remain', () => {
  assert.strictEqual(PROMPT_HISTORY_TURNS, 8);
  const kept = PROMPT_HISTORY_TURNS * 2;
  const svc = new NarrationService({}, 'key');

  for (const count of [0, 1, 15, kept]) {
    const session = { conversation_history: messagesFor(count), choice_history: [], story: { flags: {}, plot_beats_hit: [] }, characters: {} };
    const before = structuredClone(session);
    const history = svc.historyForPrompt(session);
    assert.deepStrictEqual(session, before, `the save is untouched at ${count} messages`);
    assert.deepStrictEqual(history, session.conversation_history);
    assert.strictEqual(history.some(message => String(message.content).startsWith(RECAP_LABEL)), false);
  }

  const odd = messagesFor(kept + 1);
  const session = {
    conversation_history: odd,
    choice_history: [],
    story: { flags: { forest_entered: false }, plot_beats_hit: [] },
    characters: { tomas: { revealed_secrets: [] } },
  };
  const before = structuredClone(session);
  const history = svc.historyForPrompt(session);
  assert.deepStrictEqual(session, before);
  assert.strictEqual(history.length, kept + 1);
  assert.deepStrictEqual(history[0], { role: 'user', content: RECAP_LABEL });
  assert.deepStrictEqual(history.slice(1), odd.slice(-kept));
  assert.strictEqual(history.some(message => message.content === odd[0].content), false);
});

test('a request with 8 turns or fewer includes the full history and no recap', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  for (let turn = 1; turn <= PROMPT_HISTORY_TURNS; turn++) await playTurn(t, svc, session, turn);

  const savedHistory = session.conversation_history.map(entry => ({ role: entry.role, content: entry.content }));
  assert.strictEqual(savedHistory.length, PROMPT_HISTORY_TURNS * 2);

  const body = await playTurn(t, svc, session, PROMPT_HISTORY_TURNS + 1);
  const sentHistory = body.messages.slice(0, -1);
  assert.deepStrictEqual(sentHistory, savedHistory);
  assert.strictEqual(sentHistory.some(message => String(message.content).startsWith(RECAP_LABEL)), false);
  for (let turn = 1; turn <= PROMPT_HISTORY_TURNS; turn++) {
    assert.strictEqual(sentHistory[turn * 2 - 2].content, actionFor(turn));
    assert.strictEqual(sentHistory[turn * 2 - 1].content, narrationFor(turn));
  }
});

test('a request with 9 turns keeps turns 2 to 9, one recap before them, and the save keeps turn 1', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  for (let turn = 1; turn <= 9; turn++) await playTurn(t, svc, session, turn);

  assert.strictEqual(session.conversation_history.length, 18);
  assert.deepStrictEqual(session.conversation_history[0], { role: 'user', content: actionFor(1) });
  assert.deepStrictEqual(session.conversation_history[1], { role: 'assistant', content: narrationFor(1) });

  session.story.flags.reader_checked_elara = true;
  session.story.plot_beats_hit = ['elara_found_sick'];
  session.characters.elara.revealed_secrets = ['the torn page names moonpetal'];

  const saved = structuredClone(session);
  const bodies = stubFetch(t, [textReply('The window holds.')]);
  const prompt = svc.buildPrompt(session, 'I wait by the window');
  await svc.callLLM(prompt, session);

  assert.deepStrictEqual(session, saved, 'building and sending the prompt does not change the save');
  assert.deepStrictEqual(
    prompt.history.slice(1),
    saved.conversation_history.slice(-PROMPT_HISTORY_TURNS * 2).map(entry => ({ role: entry.role, content: entry.content }))
  );

  const msgs = bodies[0].messages;
  const recaps = msgs.filter(message => typeof message.content === 'string' && message.content.startsWith(RECAP_LABEL));
  assert.strictEqual(recaps.length, 1);
  assert.strictEqual(msgs[0], recaps[0]);
  assert.strictEqual(msgs[0].role, 'user');
  assert.deepStrictEqual(msgs.slice(0, -1), prompt.history);
  assert.strictEqual(msgs.at(-1).content, prompt.userMessage);

  for (let turn = 2; turn <= 9; turn++) {
    assert.strictEqual(msgs[(turn - 2) * 2 + 1].content, actionFor(turn));
    assert.strictEqual(msgs[(turn - 2) * 2 + 2].content, narrationFor(turn));
  }

  const everything = [bodies[0].system, ...msgs.map(message => message.content)].join('\n');
  assert.strictEqual(countIn(everything, actionFor(1)), 0, 'turn 1 action');
  assert.strictEqual(countIn(everything, narrationFor(1)), 0, 'turn 1 narration');
  for (let turn = 2; turn <= 9; turn++) {
    assert.strictEqual(countIn(everything, actionFor(turn)), 1, actionFor(turn));
    assert.strictEqual(countIn(everything, narrationFor(turn)), 1, narrationFor(turn));
  }

  const recap = msgs[0].content;
  assert.ok(recap.includes('looked closer on turn 1'));
  assert.ok(recap.includes('reader_checked_elara'));
  assert.ok(recap.includes('elara_found_sick'));
  assert.ok(recap.includes('the torn page names moonpetal'));
  assert.ok(recap.indexOf('choice_history') < recap.indexOf('\nflags\n'));
  assert.ok(recap.indexOf('\nflags\n') < recap.indexOf('\nplot_beats_hit\n'));
  assert.ok(recap.indexOf('\nplot_beats_hit\n') < recap.indexOf('\nrevealed_secrets\n'));
  assert.strictEqual(recap.includes('forest_entered'), false);
  assert.strictEqual(recap.includes('tomas'), false);
  assertRecapCopiesStateOnly(recap, session);

  const stateText = JSON.stringify(stateBlock(prompt.userMessage));
  assert.strictEqual(countIn(stateText, actionFor(1)), 0);
  assert.strictEqual(countIn(stateText, narrationFor(1)), 0);
  assert.strictEqual(countIn(stateText, RECAP_LABEL), 0);
  assert.strictEqual(stateText.includes('conversation_history'), false);
});

test('call uses prompt.history when it is an array and falls back only when it is missing', async (t) => {
  const svc = new NarrationService(await loadStories(t), 'key');
  const session = await freshSession();
  session.conversation_history = [
    { role: 'user', content: 'SAVED USER' },
    { role: 'assistant', content: 'SAVED ASSISTANT' },
  ];

  const compact = stubFetch(t, [textReply('ok'), textReply('ok')]);
  await svc.callLLM({
    systemContext: 'sys',
    userMessage: 'CURRENT',
    history: [{ role: 'user', content: 'COMPACT USER' }],
  }, session);
  await svc.callLLM({
    systemContext: 'sys',
    userMessage: 'CURRENT',
    history: [],
  }, session);

  assert.deepStrictEqual(compact[0].messages, [
    { role: 'user', content: 'COMPACT USER' },
    { role: 'user', content: 'CURRENT' },
  ]);
  assert.deepStrictEqual(compact[1].messages, [
    { role: 'user', content: 'CURRENT' },
  ]);
  assert.deepStrictEqual(session.conversation_history, [
    { role: 'user', content: 'SAVED USER' },
    { role: 'assistant', content: 'SAVED ASSISTANT' },
  ]);

  const fallback = stubFetch(t, [textReply('ok')]);
  await svc.callLLM({ systemContext: 'sys', userMessage: 'CURRENT' }, session);
  assert.deepStrictEqual(fallback[0].messages, [
    { role: 'user', content: 'SAVED USER' },
    { role: 'assistant', content: 'SAVED ASSISTANT' },
    { role: 'user', content: 'CURRENT' },
  ]);
});
