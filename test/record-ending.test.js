// Records the ending when a story first moves to concluding, through Bot,
// with the real story config. Fetch is stubbed, the Discord client is never
// logged in, and no live service is called.
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

function directiveOf(body) {
  const content = body.messages.at(-1).content;
  const at = content.indexOf('FINAL TURN');
  assert.ok(at >= 0, 'the concluding turn should carry the ending directive');
  return content.slice(at);
}

async function statusFields(bot) {
  const interaction = {
    commandName: 'status',
    user: { id: USER_ID },
    replies: [],
    reply: async (payload) => { interaction.replies.push(payload); },
  };
  await bot.handleSlashCommand(interaction);
  assert.strictEqual(interaction.replies.length, 1, 'status should reply');
  return interaction.replies[0].embeds[0].toJSON().fields;
}

async function setUp(t, { endingVariants } = {}) {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => {
    warnings.push(args.map(part => String(part)).join(' '));
  });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-ending-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const storyManager = new StoryManager(path.join(ROOT, 'stories'), path.join(ROOT, 'prompts'));
  await storyManager.loadStoryData();
  if (endingVariants) {
    const story = storyManager.getStory('the-herbalists-choice');
    story.config = { ...story.config, ending_variants: endingVariants };
  }

  const sessionManager = new SessionManager(dir, storyManager);
  const narrationService = new NarrationService(storyManager, 'key');
  const bot = new Bot({
    storyManager,
    sessionManager,
    narrationService,
    discordUI: { splitMessage: (text) => [text] },
  });
  bot.client.user = { id: BOT_ID };

  const session = JSON.parse(await fs.readFile(path.join(ROOT, 'sessions', 'session-template.json'), 'utf8'));
  session.session.session_id = `session-${USER_ID}-1`;
  session.session.user_id = USER_ID;
  session.session.started_at = '2026-03-01T12:00:00.000Z';
  await sessionManager.saveSession(USER_ID, 1, session);
  await sessionManager.setActiveSession(USER_ID, 1);

  return {
    bot,
    narrationService,
    warnings,
    readSaved: () => sessionManager.getSessionByNumber(USER_ID, 1),
  };
}

test('/status omits the ending until one is recorded', async (t) => {
  const { bot } = await setUp(t);
  const fields = await statusFields(bot);
  assert.strictEqual(fields.find(field => field.name === 'Ending'), undefined);
});

test('a single matching ending is saved, kept through a healthcheck, and shown on /status', async (t) => {
  const { bot, warnings, readSaved } = await setUp(t);
  const bodies = stubFetch(t, [
    withBlock('You give her the tea.', {
      story: { flags: { moonpetal_obtained: true } },
      characters: { elara: { health: 'recovering' } },
      choice_history: { action: 'give the tea', consequence: 'Elara improves' },
    }),
    textReply('The Narrator looks up. I am still here.'),
    withBlock('The story ends here.\n\nThe End', {
      session: { status: 'active', ending_variant: ['halden_reconciled'] },
      story: { flags: { tomas_involved: true }, current_scene: 'Epilogue' },
      choice_history: { action: 'sit with Elara', consequence: 'the story ended' },
    }),
  ]);

  await bot.handleMessage(fakeMessage('I give Elara the tea'));
  let saved = await readSaved();
  assert.strictEqual(saved.session.status, 'concluding');
  assert.deepStrictEqual(saved.session.ending_variant, ['solo_path']);
  assert.doesNotMatch(bodies[0].messages.at(-1).content, /FINAL TURN/);
  let fields = await statusFields(bot);
  assert.strictEqual(fields.find(field => field.name === 'Ending').value, 'Solo path');

  await bot.handleMessage(fakeMessage('you there?'));
  const directive = directiveOf(bodies[1]);
  assert.match(directive, /`solo_path`/);
  assert.match(directive, /The reader sits with Elara as she recovers/);
  assert.match(directive, /healthcheck or needs clarification/);
  assert.doesNotMatch(directive, /`halden_reconciled`/);
  assert.doesNotMatch(directive, /Infer the appropriate ending/);
  saved = await readSaved();
  assert.strictEqual(saved.session.status, 'concluding');
  assert.deepStrictEqual(saved.session.ending_variant, ['solo_path']);
  assert.strictEqual(saved.session.turn_count, 1);

  await bot.handleMessage(fakeMessage('I sit with Elara'));
  saved = await readSaved();
  assert.strictEqual(saved.session.status, 'completed');
  assert.deepStrictEqual(saved.session.ending_variant, ['solo_path']);
  assert.strictEqual(saved.story.flags.tomas_involved, true);
  assert.strictEqual(saved.story.current_scene, 'Epilogue');
  fields = await statusFields(bot);
  assert.strictEqual(fields.find(field => field.name === 'Status').value, 'completed');
  assert.strictEqual(fields.find(field => field.name === 'Ending').value, 'Solo path');
  assert.deepStrictEqual(warnings.filter(line => line.includes('[ending]')), []);
});

test('the mixed Halden and Tomas route saves both ids, names them, and /status shows both', async (t) => {
  const { bot, narrationService, readSaved } = await setUp(t);
  const bodies = stubFetch(t, [
    withBlock('Halden and Tomas are both here as Elara drinks.', {
      story: {
        flags: {
          moonpetal_obtained: true,
          halden_reconciled: true,
          halden_encountered: true,
          tomas_involved: true,
        },
      },
      characters: { elara: { health: 'recovering' } },
      choice_history: { action: 'give the tea', consequence: 'Elara improves' },
    }),
    withBlock('The story ends here.\n\nThe End', {
      story: { current_scene: 'Epilogue' },
      choice_history: { action: 'sit with them', consequence: 'the story ended' },
    }),
  ]);

  await bot.handleMessage(fakeMessage('I give Elara the tea'));
  let saved = await readSaved();
  assert.strictEqual(saved.session.status, 'concluding');
  assert.deepStrictEqual(saved.session.ending_variant, ['halden_reconciled', 'tomas_helped']);

  const { userMessage } = narrationService.buildPrompt(saved, 'I sit with them');
  const named = userMessage.slice(userMessage.indexOf('FINAL TURN'));
  assert.ok(named.indexOf('`halden_reconciled`') < named.indexOf('`tomas_helped`'));
  assert.match(named, /Halden visits regularly now/);
  assert.match(named, /Tomas and the reader share a quiet moment/);
  assert.match(named, /Do not choose or infer an ending yourself/);
  assert.doesNotMatch(named, /`solo_path`/);

  let fields = await statusFields(bot);
  assert.strictEqual(fields.find(field => field.name === 'Ending').value, 'Halden reconciled, Tomas helped');

  await bot.handleMessage(fakeMessage('I sit with them'));
  const directive = directiveOf(bodies[1]);
  assert.ok(directive.indexOf('`halden_reconciled`') < directive.indexOf('`tomas_helped`'));
  assert.match(directive, /Halden visits regularly now/);
  assert.match(directive, /Tomas and the reader share a quiet moment/);
  saved = await readSaved();
  assert.strictEqual(saved.session.status, 'completed');
  assert.deepStrictEqual(saved.session.ending_variant, ['halden_reconciled', 'tomas_helped']);
  fields = await statusFields(bot);
  assert.strictEqual(fields.find(field => field.name === 'Status').value, 'completed');
  assert.strictEqual(fields.find(field => field.name === 'Ending').value, 'Halden reconciled, Tomas helped');
});

test('a missing match warns, leaves the ending unset, and the story still completes', async (t) => {
  const { bot, warnings, readSaved } = await setUp(t, {
    endingVariants: [
      {
        id: 'unreachable',
        conditions: [{ flag: 'moonpetal_obtained', value: false }],
        description: 'The moonpetal was never found.',
      },
    ],
  });
  const bodies = stubFetch(t, [
    withBlock('You give her the tea.', {
      story: { flags: { moonpetal_obtained: true } },
      characters: { elara: { health: 'recovering' } },
      choice_history: { action: 'give the tea', consequence: 'Elara improves' },
    }),
    withBlock('The story ends here.\n\nThe End', {
      story: { current_scene: 'Epilogue' },
      choice_history: { action: 'sit with Elara', consequence: 'the story ended' },
    }),
  ]);

  await bot.handleMessage(fakeMessage('I give Elara the tea'));
  let saved = await readSaved();
  assert.strictEqual(saved.session.status, 'concluding');
  assert.strictEqual(saved.session.ending_variant, null);
  assert.deepStrictEqual(
    warnings.filter(line => line.includes('[ending]')),
    ['[ending] session=session-42-1 no ending variant matched the current flags']
  );
  let fields = await statusFields(bot);
  assert.strictEqual(fields.find(field => field.name === 'Ending'), undefined);

  await bot.handleMessage(fakeMessage('I sit with Elara'));
  const directive = directiveOf(bodies[1]);
  assert.match(directive, /No ending variant matched the current flags/);
  assert.match(directive, /Do not choose an ending yourself/);
  assert.doesNotMatch(directive, /`unreachable`/);
  saved = await readSaved();
  assert.strictEqual(saved.session.status, 'completed');
  assert.strictEqual(saved.session.ending_variant, null);
  assert.strictEqual(saved.story.current_scene, 'Epilogue');
  assert.strictEqual(warnings.filter(line => line.includes('[ending]')).length, 1);
  fields = await statusFields(bot);
  assert.strictEqual(fields.find(field => field.name === 'Status').value, 'completed');
  assert.strictEqual(fields.find(field => field.name === 'Ending'), undefined);
});
