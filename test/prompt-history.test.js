// Earlier turns must reach the AI once, as chat messages, and not a second
// time inside the session state in the final user message.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const NarrationService = require('../src/NarrationService');
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

function narrationFor(turn) {
  return `NARRATION OF TURN ${turn}: the lamplight shifts across the shelves.`;
}

function actionFor(turn) {
  return `ACTION OF TURN ${turn}: I look closer`;
}

// Plays one turn the way Bot does, with the AI's reply supplied, and returns
// the request body that was sent.
async function playTurn(t, svc, session, turn) {
  const bodies = stubFetch(t, [textReply(narrationFor(turn))]);
  const prompt = svc.buildPrompt(session, actionFor(turn));
  const response = await svc.callLLM(prompt, session);
  const { narration, stateUpdate } = svc.parseResponse(response);
  svc.applyStateUpdates(session, stateUpdate, narration, actionFor(turn));
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
