// Forty real turns of The Herbalist's Choice, through parse and save.
// Histories of 16 saved turns or fewer are sent word for word. Above that
// the prompt keeps one recap plus the recent turns, and the save keeps
// everything. The model is stubbed: fetch never leaves the process.
require('./preload-no-network');

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
const USER_ID = '40';
const TURNS = 40;
// These are the shipped step sizes. Expectations below use the numbers
// literally, so a change to the step fails this test instead of moving the
// expected cut along with it.
const KEPT_TURNS = 8;
const CUT_STEP = 8;
const WHOLE_HISTORY = KEPT_TURNS + CUT_STEP;
const RECAP_LABEL = 'Recap of earlier turns, not a new reader action.';
const SCENE_1 = 'Scene 1: Morning in the Apothecary';
const SCENE_2 = 'Scene 2: The Crossroads';
const SCENE_3 = 'Scene 3: The Moonpetal';
const KIMI_ENDPOINT = 'https://api.kimi.com/coding/v1/messages';

// Replies on these turns advance the act. The prompt for a turn is built
// before that reply is saved, so the new act is what the next turn sees.
const ACT_2_ON_TURN = 10;
const ACT_3_ON_TURN = 25;

function actionFor(turn) {
  return `ACTION OF TURN ${turn}: I look closer`;
}

function narrationFor(turn) {
  return `NARRATION OF TURN ${turn}: the lamplight shifts across the shelves.`;
}

function choiceAction(turn) {
  return `looked closer on turn ${turn}`;
}

// A normal story reply: narration, then one state block with a choice.
// Act changes only. No flag here meets an end condition.
function storyReply(turn) {
  const update = {
    choice_history: {
      action: choiceAction(turn),
      consequence: 'saw a little more',
    },
  };
  if (turn === ACT_2_ON_TURN) update.story = { current_act: 2 };
  if (turn === ACT_3_ON_TURN) update.story = { current_act: 3 };
  const text = `${narrationFor(turn)}\n\n\`\`\`json\n${JSON.stringify(update)}\n\`\`\``;
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}

// floor((saved - 8) / 8) * 8 once more than 16 turns are saved, else 0.
function cutFor(savedTurns) {
  if (savedTurns <= WHOLE_HISTORY) return 0;
  return Math.floor((savedTurns - KEPT_TURNS) / CUT_STEP) * CUT_STEP;
}

// The act left in the save after `savedTurns` completed turns.
function actForSavedTurns(savedTurns) {
  if (savedTurns >= ACT_3_ON_TURN) return 3;
  if (savedTurns >= ACT_2_ON_TURN) return 2;
  return 1;
}

function countTurns(messages) {
  let turns = 0;
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role === 'user' && i + 1 < messages.length && messages[i + 1].role === 'assistant') {
      turns += 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return turns;
}

function stateBlock(userMessage) {
  const match = userMessage.match(/## Current Session State\n\n```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'the current user message has a session state block');
  return JSON.parse(match[1]);
}

function assertChoiceCap(userMessage, session, label) {
  const state = stateBlock(userMessage);
  const saved = session.choice_history;
  const expected = saved.length > KEPT_TURNS ? saved.slice(-KEPT_TURNS) : saved;
  assert.ok(state.choice_history.length <= KEPT_TURNS, label);
  assert.deepStrictEqual(state.choice_history, expected, label);
  assert.strictEqual('conversation_history' in state, false, label);
}

function assertCurrentAct(systemContext, act, label) {
  assert.ok(systemContext.includes(act === 1 ? SCENE_1 : act === 2 ? SCENE_2 : SCENE_3), label);
  const absent = {
    1: [SCENE_2, SCENE_3],
    2: [SCENE_1, SCENE_3],
    3: [SCENE_1, SCENE_2],
  };
  for (const scene of absent[act]) {
    assert.strictEqual(systemContext.includes(scene), false, `${label} includes ${scene}`);
  }
  assert.strictEqual(systemContext.includes('## Author Notes'), false, label);
  assert.strictEqual(systemContext.includes('## State Tracking Reference'), false, label);
}

function assertSavedGame(session, turn) {
  assert.strictEqual(session.session.status, 'active', `turn ${turn} status`);
  assert.strictEqual(session.session.ending_variant, null, `turn ${turn} ending`);
  assert.strictEqual(session.session.turn_count, turn, `turn ${turn} count`);
  assert.strictEqual(session.story.current_act, actForSavedTurns(turn), `turn ${turn} act`);
  assert.strictEqual(session.conversation_history.length, turn * 2, `turn ${turn} history length`);
  assert.strictEqual(session.choice_history.length, turn, `turn ${turn} choices`);
  for (let i = 1; i <= turn; i++) {
    assert.deepStrictEqual(session.conversation_history[(i - 1) * 2], { role: 'user', content: actionFor(i) });
    assert.deepStrictEqual(session.conversation_history[(i - 1) * 2 + 1], { role: 'assistant', content: narrationFor(i) });
    assert.strictEqual(session.choice_history[i - 1].turn, i);
    assert.strictEqual(session.choice_history[i - 1].action, choiceAction(i));
  }
}

// `savedTurns` is the length of the history this prompt was built from.
// `playTurn` is the reader turn that would send it (one ahead of the save).
function assertSentHistory(history, session, savedTurns, playTurn, recaps) {
  const label = `play turn ${playTurn}, ${savedTurns} saved`;
  const cut = cutFor(savedTurns);
  const recent = savedTurns - cut;
  const verbatim = session.conversation_history.map(message => ({ role: message.role, content: message.content }));

  if (savedTurns <= WHOLE_HISTORY) {
    assert.strictEqual(cut, 0, label);
    assert.strictEqual(history.length, savedTurns * 2, label);
    assert.strictEqual(countTurns(history), savedTurns, label);
    assert.strictEqual(history.some(message => String(message.content).includes(RECAP_LABEL)), false, label);
    assert.deepStrictEqual(history, verbatim, label);
    return;
  }

  // The recap is merged into the first kept user message, and that pair
  // still counts as one of the recent turns.
  assert.ok(recent >= KEPT_TURNS && recent <= KEPT_TURNS + CUT_STEP - 1, `${label} recent ${recent}`);
  assert.strictEqual(countTurns(history), recent, label);
  assert.strictEqual(history.length, recent * 2, label);
  assert.strictEqual(history.filter(message => String(message.content).startsWith(RECAP_LABEL)).length, 1, label);
  assert.strictEqual(history[0].role, 'user', label);
  assert.ok(String(history[0].content).startsWith(RECAP_LABEL), label);

  const separator = '\n\n---\n\n';
  const splitAt = history[0].content.indexOf(separator);
  assert.ok(splitAt > 0, label);
  const recap = history[0].content.slice(0, splitAt);
  assert.strictEqual(history[0].content.slice(splitAt + separator.length), actionFor(cut + 1), label);
  assert.deepStrictEqual(history.slice(1), verbatim.slice(cut * 2 + 1), label);
  assert.strictEqual(history[1].content, narrationFor(cut + 1), label);

  for (let turn = 1; turn <= cut; turn++) {
    assert.strictEqual(
      history.some(message => message.content === actionFor(turn) || message.content === narrationFor(turn)),
      false,
      `${label} still quotes turn ${turn}`
    );
  }

  const previousCut = recaps.cuts.length ? recaps.cuts[recaps.cuts.length - 1] : null;
  if (previousCut === cut) {
    assert.strictEqual(recap, recaps.text, `${label} recap changed while the cut stayed ${cut}`);
  } else {
    if (previousCut !== null) {
      assert.notStrictEqual(recap, recaps.text, `${label} recap did not change when the cut moved to ${cut}`);
    }
    recaps.cuts.push(cut);
    recaps.text = recap;
    recaps.changes.push({ savedTurns, playTurn });
  }
}

test('a 40-turn Herbalist game compacts the prompt and keeps the full save', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => {
    warnings.push(args.map(part => String(part)).join(' '));
  });
  t.mock.method(console, 'error', (...args) => {
    warnings.push(args.map(part => String(part)).join(' '));
  });

  const storyManager = new StoryManager(path.join(ROOT, 'stories'), path.join(ROOT, 'prompts'));
  await storyManager.loadStoryData();
  // Fixed prompt clock. The minutes line may appear on the current user
  // message; nothing below compares that message to a fixed fixture.
  const now = Date.parse('2026-11-24T00:30:00.000Z');
  const svc = new NarrationService(storyManager, 'not-a-real-token', { now });
  const config = storyManager.getStory(STORY_ID).config;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narra-long-game-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessionManager = new SessionManager(dir, storyManager);
  const { sessionNumber } = await sessionManager.createSession(USER_ID, 'reader', STORY_ID);

  const replies = [];
  for (let turn = 1; turn <= TURNS; turn++) replies.push(storyReply(turn));
  const requests = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    requests.push({ url: String(url), body: JSON.parse(opts.body) });
    const json = replies[requests.length - 1];
    if (!json) throw new Error(`unexpected request ${requests.length}`);
    return { ok: true, status: 200, json: async () => json, text: async () => '' };
  });

  // Recap text is compared as a string. It is stored the first time a cut
  // is seen and must be unchanged until the cut advances.
  const recaps = { cuts: [], text: null, changes: [] };

  for (let turn = 1; turn <= TURNS; turn++) {
    const session = await sessionManager.getSessionByNumber(USER_ID, sessionNumber);
    const savedTurns = turn - 1;
    assert.strictEqual(session.session.turn_count, savedTurns, `before play turn ${turn}`);
    assert.strictEqual(session.story.current_act, actForSavedTurns(savedTurns), `act before play turn ${turn}`);

    // The prompt for play turn N uses the session saved after turn N-1.
    // Act 2 is written by turn 10's reply, so turns 1-10 still show act 1
    // and turn 11 is the first prompt in act 2. Act 3 is written by turn
    // 25's reply, so turns 11-25 show act 2 and turn 26 is the first prompt
    // in act 3.
    const action = actionFor(turn);
    const choicesBefore = session.choice_history.length;
    const historyBefore = session.conversation_history.length;
    const prompt = svc.buildPrompt(session, action);
    assert.strictEqual(session.choice_history.length, choicesBefore, `buildPrompt mutated choices on turn ${turn}`);
    assert.strictEqual(session.conversation_history.length, historyBefore, `buildPrompt mutated history on turn ${turn}`);

    assertSentHistory(prompt.history, session, savedTurns, turn, recaps);
    assertChoiceCap(prompt.userMessage, session, `play turn ${turn}`);
    assertCurrentAct(prompt.systemContext, actForSavedTurns(savedTurns), `play turn ${turn}`);
    assert.strictEqual(prompt.systemContext.includes('Minutes since the last action'), false, `play turn ${turn}`);
    assert.strictEqual(prompt.history.some(message => String(message.content).includes('Minutes since the last action')), false, `play turn ${turn}`);
    assert.ok(prompt.userMessage.includes(action), `play turn ${turn} action`);
    // The minutes line, when present, lives in this message only. Do not
    // require the whole message to equal a snapshot.

    const response = await svc.callLLM(prompt, session);
    const request = requests[turn - 1];
    assert.strictEqual(request.url, KIMI_ENDPOINT, `play turn ${turn} endpoint`);
    assert.strictEqual(request.body.system, prompt.systemContext, `play turn ${turn} system`);
    assert.deepStrictEqual(request.body.messages.slice(0, -1), prompt.history, `play turn ${turn} history`);
    const current = request.body.messages[request.body.messages.length - 1];
    assert.strictEqual(current.role, 'user', `play turn ${turn}`);
    assert.ok(current.content.includes(action), `play turn ${turn} sent action`);
    assert.ok(current.content.includes('## Current Session State'), `play turn ${turn} state`);
    assertChoiceCap(current.content, session, `sent play turn ${turn}`);

    const { narration, stateUpdate } = svc.parseResponse(response);
    assert.strictEqual(narration, narrationFor(turn), `play turn ${turn} narration`);
    svc.applyStateUpdates(session, stateUpdate, narration, action);
    assert.strictEqual(svc.evaluateEndConditions(session, config), false, `play turn ${turn} ended`);
    assert.strictEqual(session.session.status, 'active', `play turn ${turn} status`);

    await sessionManager.saveSession(USER_ID, sessionNumber, session);
    const stored = await sessionManager.getSessionByNumber(USER_ID, sessionNumber);
    assert.deepStrictEqual(stored, session, `play turn ${turn} round trip`);
    assertSavedGame(stored, turn);
  }

  assert.strictEqual(requests.length, TURNS);
  assert.deepStrictEqual(warnings, []);

  // Saved lengths 0 to 39 were on the requests above. This prompt is the
  // one a 41st turn would send, and it is the first look at 40 saved turns.
  // It is not played, so the save stays at 40.
  const finished = await sessionManager.getSessionByNumber(USER_ID, sessionNumber);
  assertSavedGame(finished, TURNS);
  const closing = svc.buildPrompt(finished, actionFor(TURNS + 1));
  assert.deepStrictEqual(finished, await sessionManager.getSessionByNumber(USER_ID, sessionNumber));
  assertSentHistory(closing.history, finished, TURNS, TURNS + 1, recaps);
  assertChoiceCap(closing.userMessage, finished, 'after 40 saved turns');
  assert.deepStrictEqual(stateBlock(closing.userMessage).choice_history.map(entry => entry.turn), [33, 34, 35, 36, 37, 38, 39, 40]);
  assertCurrentAct(closing.systemContext, 3, 'after 40 saved turns');

  // Cut sizes 8, 16, 24 and 32. The recap appears when 17 turns are saved
  // and changes when the saved length hits 24, 32 and 40. Because the
  // request for play turn N is built from N-1 saved turns, those same
  // changes leave on play turns 18, 25, 33 and the unplayed 41st prompt.
  assert.deepStrictEqual(recaps.changes, [
    { savedTurns: 17, playTurn: 18 },
    { savedTurns: 24, playTurn: 25 },
    { savedTurns: 32, playTurn: 33 },
    { savedTurns: 40, playTurn: 41 },
  ]);
  assert.deepStrictEqual(recaps.cuts, [8, 16, 24, 32]);
});
