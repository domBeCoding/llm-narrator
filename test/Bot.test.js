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

  await fs.writeFile(path.join(dir, 'session-template.json'), JSON.stringify(makeSession(0)), 'utf8');

  const storyManager = { getStory: () => ({ title: 'The Herbalist\'s Choice', openingAction: 'OPENING', config: {} }) };
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

test('two quick messages from the same reader both reach the save', async (t) => {
  // The first reply is slower than the second, so without one-at-a-time turns
  // both start from turn 0 and the first save overwrites the second.
  const { bot, readSaved } = await makeBot(t, { delays: { 'I open the door': 50, 'I step inside': 0 } });

  await Promise.all([
    bot.handleMessage(fakeMessage('I open the door')),
    bot.handleMessage(fakeMessage('I step inside')),
  ]);

  const saved = await readSaved(1);
  assert.strictEqual(saved.session.turn_count, 2);
  assert.deepStrictEqual(saved.choice_history, ['I open the door', 'I step inside']);
});

test('one reader\'s slow turn does not hold up another reader', async (t) => {
  const { bot, dir, readSaved } = await makeBot(t, { delays: { 'I open the door': 200 } });
  const other = makeSession(1);
  other.session.session_id = 'session-7-1';
  other.session.user_id = '7';
  await fs.writeFile(path.join(dir, 'session-7-1.json'), JSON.stringify(other), 'utf8');

  const otherMessage = fakeMessage('I wave');
  otherMessage.author = { bot: false, id: '7', username: 'other' };

  const slow = bot.handleMessage(fakeMessage('I open the door'));
  const started = Date.now();
  await bot.handleMessage(otherMessage);
  assert.ok(Date.now() - started < 150, 'the other reader was not queued behind the slow turn');
  await slow;
  assert.strictEqual((await readSaved(1)).session.turn_count, 1);
});

test('a message sent while the opening scene is generating waits for it and both are saved', async (t) => {
  const { bot, readSaved } = await makeBot(t, { sessions: [], delays: { OPENING: 50 } });
  const button = fakeButton('start_story_the-herbalists-choice');
  button.followUp = async () => {};
  button.channel = { send: async () => {} };

  const opening = bot.handleButtonInteraction(button);
  // Let the session be created and the opening start before the reader speaks.
  await new Promise(resolve => setTimeout(resolve, 10));
  await Promise.all([opening, bot.handleMessage(fakeMessage('I look around'))]);

  const saved = await readSaved(1);
  assert.deepStrictEqual(saved.choice_history, ['OPENING', 'I look around']);
  assert.strictEqual(saved.session.turn_count, 2);
});

test('a message sent before the reader switches session stays with the session it was sent to', async (t) => {
  // Message A is slow. Message B arrives while A is still playing, so it waits
  // in the queue. The reader then switches to session 2 before B's turn starts.
  const { bot, prompted, readSaved } = await makeBot(t, { sessions: [1, 2], delays: { 'I open the door': 50 } });
  await bot.sessionManager.setActiveSession(USER_ID, 1);

  const a = bot.handleMessage(fakeMessage('I open the door'));
  await new Promise(resolve => setTimeout(resolve, 10));
  const b = bot.handleMessage(fakeMessage('I step inside'));
  await new Promise(resolve => setTimeout(resolve, 10));
  await bot.handleButtonInteraction(fakeButton('load_session_2'));
  await Promise.all([a, b]);

  assert.deepStrictEqual(prompted.map(p => [p.action, p.sessionId]), [
    ['I open the door', 'session-42-1'],
    ['I step inside', 'session-42-1'],
  ]);
  assert.deepStrictEqual((await readSaved(1)).choice_history, ['I open the door', 'I step inside']);
  assert.deepStrictEqual((await readSaved(2)).choice_history, []);

  // Messages sent after the switch go to session 2.
  await bot.handleMessage(fakeMessage('I wave'));
  assert.deepStrictEqual((await readSaved(2)).choice_history, ['I wave']);
});

test('messages from one reader are played in the order they arrived', async (t) => {
  const { bot, readSaved } = await makeBot(t);
  const actions = ['one', 'two', 'three', 'four', 'five'].map(w => `I count ${w}`);

  await Promise.all(actions.map(action => bot.handleMessage(fakeMessage(action))));

  assert.deepStrictEqual((await readSaved(1)).choice_history, actions);
});
