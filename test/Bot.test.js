// Drives Bot's button and message handlers with fake Discord objects, a real
// SessionManager on a temporary sessions folder, and a stub narration service.
// The Discord client is constructed but never logged in, and no AI service is
// called.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const Bot = require('../src/Bot');
const SessionManager = require('../src/SessionManager');

const BOT_ID = '999';
const USER_ID = '42';

function makeSession(n) {
  return {
    session: {
      session_id: `session-${USER_ID}-${n}`,
      user_id: USER_ID,
      story_id: 'the-herbalists-choice',
      status: 'active',
      turn_count: 0,
      started_at: new Date(2024, 0, n).toISOString(),
    },
    story: { flags: {} },
    choice_history: [],
  };
}

/**
 * Builds a Bot over a temporary sessions folder. `delays` maps a reader action
 * to how long its fake AI call takes, so tests can make replies finish out of
 * order.
 */
async function makeBot(t, { sessions = [1], delays = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-bot-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const n of sessions) {
    await fs.writeFile(path.join(dir, `session-${USER_ID}-${n}.json`), JSON.stringify(makeSession(n)), 'utf8');
  }

  const storyManager = { getStory: () => ({ title: 'The Herbalist\'s Choice', config: {} }) };
  const sessionManager = new SessionManager(dir, storyManager);
  const prompted = [];
  const narrationService = {
    buildPrompt: (session, action) => {
      prompted.push({ sessionId: session.session.session_id, action });
      return { action };
    },
    callLLM: async ({ action }) => {
      await new Promise(resolve => setTimeout(resolve, delays[action] || 0));
      return action;
    },
    parseResponse: (response) => ({ narration: `You: ${response}`, stateUpdate: {} }),
    applyStateUpdates: (session, stateUpdate, narration, action) => {
      session.session.turn_count += 1;
      session.choice_history.push(action);
    },
    evaluateEndConditions: () => false,
  };
  const discordUI = { splitMessage: (text) => [text] };

  const bot = new Bot({ storyManager, sessionManager, narrationService, discordUI });
  bot.client.user = { id: BOT_ID };

  const readSaved = async (n) => JSON.parse(await fs.readFile(path.join(dir, `session-${USER_ID}-${n}.json`), 'utf8'));
  return { bot, dir, prompted, readSaved };
}

function fakeMessage(action) {
  const replies = [];
  return {
    replies,
    author: { bot: false, id: USER_ID, username: 'reader' },
    guild: {},
    mentions: { has: (id) => id === BOT_ID },
    content: `<@${BOT_ID}> ${action}`,
    react: async () => {},
    channel: { sendTyping: async () => {} },
    reply: async (text) => { replies.push(text); },
  };
}

function fakeButton(customId) {
  return {
    customId,
    user: { id: USER_ID, username: 'reader' },
    reply: async () => {},
    update: async () => {},
  };
}

test('continuing a previous session sends later messages to that session', async (t) => {
  const { bot, prompted, readSaved } = await makeBot(t, { sessions: [1, 2] });

  await bot.handleButtonInteraction(fakeButton('load_session_1'));
  await bot.handleMessage(fakeMessage('I open the door'));
  await bot.handleMessage(fakeMessage('I step inside'));

  assert.deepStrictEqual(prompted.map(p => p.sessionId), ['session-42-1', 'session-42-1']);
  assert.strictEqual((await readSaved(1)).session.turn_count, 2);
  assert.strictEqual((await readSaved(2)).session.turn_count, 0, 'the newest session is left alone');
});
