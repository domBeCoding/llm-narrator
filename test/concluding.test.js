// The final turn of a story, end to end through Bot with the real story,
// session template, StoryManager, SessionManager and NarrationService. The AI
// is a stubbed fetch, the Discord client is never logged in, and no live
// service is called.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const Bot = require('../src/Bot');
const NarrationService = require('../src/NarrationService');
const StoryManager = require('../src/StoryManager');
const SessionManager = require('../src/SessionManager');

const ROOT = path.join(__dirname, '..');
const BOT_ID = '999';
const USER_ID = '42';

const LAST_SCENE = 'Elara breathes easier as the tea takes hold. Halden waits by the door.';
const HEALTHCHECK_REPLY = 'The Narrator looks up from the page. \'I am still here. Shall we carry on?\'';
const ENDING = 'The apothecary has three people in it again.\n\n========\n\nThe story ends here.\n\nThe End';

function textReply(text) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}

function withBlock(text, update) {
  return textReply(`${text}\n\n\`\`\`json\n${JSON.stringify(update)}\n\`\`\``);
}

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

// A saved session on its final turn: the last story scene has been played and
// the bot has set it to concluding.
async function setUp(t) {
  t.mock.method(console, 'log', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-concluding-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const storyManager = new StoryManager(path.join(ROOT, 'stories'), path.join(ROOT, 'prompts'));
  await storyManager.loadStoryData();
  const sessionManager = new SessionManager(dir, storyManager);
  const narrationService = new NarrationService(storyManager, 'key');
  const bot = new Bot({ storyManager, sessionManager, narrationService, discordUI: { splitMessage: (text) => [text] } });
  bot.client.user = { id: BOT_ID };

  const session = JSON.parse(await fs.readFile(path.join(ROOT, 'sessions', 'session-template.json'), 'utf8'));
  session.session.session_id = `session-${USER_ID}-1`;
  session.session.user_id = USER_ID;
  session.session.status = 'concluding';
  session.session.turn_count = 5;
  session.session.last_llm_output = LAST_SCENE;
  await sessionManager.saveSession(USER_ID, 1, session);
  await sessionManager.setActiveSession(USER_ID, 1);

  const readSaved = () => sessionManager.getSessionByNumber(USER_ID, 1);
  return { bot, readSaved };
}

test('resuming on the final turn gives back the last scene, and the next action ends the story', async (t) => {
  const { bot, readSaved } = await setUp(t);

  // A healthcheck: the AI answers in character with no state block.
  let bodies = stubFetch(t, [textReply(HEALTHCHECK_REPLY)]);
  const healthcheck = fakeMessage('you there?');
  await bot.handleMessage(healthcheck);
  assert.deepStrictEqual(healthcheck.replies, [HEALTHCHECK_REPLY]);
  assert.match(bodies[0].messages.at(-1).content, /FINAL TURN/);
  assert.match(bodies[0].messages.at(-1).content, /healthcheck or needs clarification/);
  let saved = await readSaved();
  assert.strictEqual(saved.session.status, 'concluding');
  assert.strictEqual(saved.session.last_llm_output, LAST_SCENE);
  assert.strictEqual(saved.session.turn_count, 5);

  // Resume: the AI fetches the last scene and repeats it with no state block.
  t.mock.restoreAll();
  t.mock.method(console, 'log', () => {});
  bodies = stubFetch(t, [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool_1', name: 'get_last_narration', input: {} }] },
    textReply(LAST_SCENE),
  ]);
  const resume = fakeMessage('continue');
  await bot.handleMessage(resume);
  assert.strictEqual(bodies[1].messages.at(-1).content[0].content, LAST_SCENE);
  assert.deepStrictEqual(resume.replies, [LAST_SCENE]);
  saved = await readSaved();
  assert.strictEqual(saved.session.status, 'concluding');

  // The next real action gets the ending, with a state block, and completes it.
  t.mock.restoreAll();
  t.mock.method(console, 'log', () => {});
  stubFetch(t, [withBlock(ENDING, { story: { current_scene: 'Epilogue' }, choice_history: { action: 'sat with Elara', consequence: 'the story ended' } })]);
  const action = fakeMessage('I sit with Elara');
  await bot.handleMessage(action);
  assert.deepStrictEqual(action.replies, [ENDING]);
  saved = await readSaved();
  assert.strictEqual(saved.session.status, 'completed');
  assert.strictEqual(saved.session.last_llm_output, ENDING);
  assert.strictEqual(saved.session.turn_count, 6);
});
