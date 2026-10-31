const test = require('node:test');
const assert = require('node:assert');

const NarrationService = require('../src/NarrationService');

function makeStoryManagerStub() {
  return {
    getSystemPrompt: () => 'SYSTEM_PROMPT_TEXT',
    getConcludingDirective: () => 'ENDING DIRECTIVE {variants}',
    getStory: (storyId) => ({
      id: storyId,
      title: 'The Herbalist\'s Choice',
      content: 'STORY_CONTENT',
      config: { story_id: storyId, end_conditions: { all_required: [] } },
    }),
  };
}

function makeSession(overrides = {}) {
  return {
    session: {
      session_id: 'session-42-1',
      user_id: '42',
      story_id: 'the-herbalists-choice',
      status: 'active',
      turn_count: 3,
      last_action_at: '2020-01-01T00:00:00.000Z',
      last_llm_output: 'PREVIOUS NARRATION',
      ending_variant: null,
      ...overrides.session,
    },
    reader: {
      location: 'apothecary',
      emotional_state: 'content',
      inventory: ['basic herb kit'],
      knowledge: [],
    },
    characters: {
      elara: { health: 'healthy', disposition: 'calm', revealed_secrets: [] },
      halden: { health: 'healthy', disposition: 'hostile', revealed_secrets: [] },
    },
    story: {
      current_act: 1,
      current_scene: 'Morning in the Apothecary',
      plot_beats_hit: [],
      flags: { story_started: false, reader_checked_elara: false },
    },
    world: {
      locations: {
        apothecary: { visited: true, visit_count: 1 },
        village_square: { visited: false, visit_count: 0 },
      },
    },
    choice_history: [],
    conversation_history: [],
  };
}

// --- buildPrompt -------------------------------------------------------------

test('buildPrompt: embeds system prompt, story content, config and action', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();
  const { systemContext, userMessage } = svc.buildPrompt(session, 'I check on Elara');

  assert.match(systemContext, /SYSTEM_PROMPT_TEXT/);
  assert.match(systemContext, /STORY_CONTENT/);
  assert.match(userMessage, /I check on Elara/);
  assert.match(userMessage, /## Current Session State/);
  assert.match(systemContext, /## Story Config \(Mechanical Rules\)/);
});

test('buildPrompt: serialises the session state as JSON in userMessage', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();
  const { userMessage } = svc.buildPrompt(session, 'action');

  assert.match(userMessage, /"turn_count": 3/);
  assert.match(userMessage, /"location": "apothecary"/);
});

test('buildPrompt: systemContext is static (does not contain session state or action)', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();
  const { systemContext } = svc.buildPrompt(session, 'I check on Elara');

  assert.doesNotMatch(systemContext, /"turn_count"/);
  assert.doesNotMatch(systemContext, /I check on Elara/);
  assert.doesNotMatch(systemContext, /## Current Session State/);
});

// --- parseResponse -----------------------------------------------------------

test('parseResponse: splits narration from the trailing JSON block', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const raw = [
    'You step into the apothecary.',
    '',
    '========',
    '',
    'What do you do?',
    '',
    '```json',
    '{"reader": {"location": "apothecary"}}',
    '```',
  ].join('\n');

  const { narration, stateUpdate } = svc.parseResponse(raw);

  assert.deepStrictEqual(stateUpdate, { reader: { location: 'apothecary' } });
  assert.match(narration, /You step into the apothecary\./);
  assert.doesNotMatch(narration, /```json/);
  assert.doesNotMatch(narration, /"location"/);
});

test('parseResponse: returns null stateUpdate when no JSON block is present', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const { narration, stateUpdate } = svc.parseResponse('Just prose, no state.');

  assert.strictEqual(stateUpdate, null);
  assert.strictEqual(narration, 'Just prose, no state.');
});

test('parseResponse: returns null stateUpdate when the JSON block is malformed', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const raw = 'Prose here.\n\n```json\n{not valid json,}\n```';
  const { narration, stateUpdate } = svc.parseResponse(raw);

  assert.strictEqual(stateUpdate, null);
  // Narration is left untouched (including the bad block) when parsing fails.
  assert.match(narration, /Prose here\./);
});

test('parseResponse: strips bookkeeping markers from the narration', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const { narration } = svc.parseResponse('The scene.\n[State updated]\n[Thinking]');

  assert.doesNotMatch(narration, /State updated/);
  assert.doesNotMatch(narration, /Thinking/);
  assert.match(narration, /The scene\./);
});

// --- applyStateUpdates -------------------------------------------------------

test('applyStateUpdates: increments turn count and stamps the timestamp', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();
  const before = session.session.last_action_at;

  svc.applyStateUpdates(session, {}, 'NEW NARRATION');

  assert.strictEqual(session.session.turn_count, 4);
  assert.notStrictEqual(session.session.last_action_at, before);
  assert.doesNotThrow(() => new Date(session.session.last_action_at).toISOString());
});

test('applyStateUpdates: sets last_llm_output from the narration argument, not the LLM payload', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  // Even if the model tries to supply its own value, the narration wins.
  svc.applyStateUpdates(session, { last_llm_output: 'MODEL SUPPLIED' }, 'ACTUAL NARRATION');

  assert.strictEqual(session.session.last_llm_output, 'ACTUAL NARRATION');
});

test('applyStateUpdates: merges character updates without dropping untouched fields', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {
    characters: { elara: { health: 'critical_fever' } },
  }, 'n');

  assert.strictEqual(session.characters.elara.health, 'critical_fever');
  assert.strictEqual(session.characters.elara.disposition, 'calm');
});

test('applyStateUpdates: ignores updates for characters not in the session', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {
    characters: { nonexistent: { health: 'dead' } },
  }, 'n');

  assert.strictEqual(session.characters.nonexistent, undefined);
});

test('applyStateUpdates: merges reader updates', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {
    reader: { location: 'greymere_forest', emotional_state: 'afraid' },
  }, 'n');

  assert.strictEqual(session.reader.location, 'greymere_forest');
  assert.strictEqual(session.reader.emotional_state, 'afraid');
  assert.deepStrictEqual(session.reader.inventory, ['basic herb kit']);
});

test('applyStateUpdates: appends plot beats and merges flags', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {
    story: {
      plot_beats_hit: ['elara_found_sick'],
      flags: { reader_checked_elara: true },
      current_act: 2,
      current_scene: 'The Forest Edge',
    },
  }, 'n');

  assert.deepStrictEqual(session.story.plot_beats_hit, ['elara_found_sick']);
  assert.strictEqual(session.story.flags.reader_checked_elara, true);
  assert.strictEqual(session.story.flags.story_started, false);
  assert.strictEqual(session.story.current_act, 2);
  assert.strictEqual(session.story.current_scene, 'The Forest Edge');
});

test('applyStateUpdates: merges location updates', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {
    world: { locations: { village_square: { visited: true, visit_count: 1 } } },
  }, 'n');

  assert.strictEqual(session.world.locations.village_square.visited, true);
  assert.strictEqual(session.world.locations.village_square.visit_count, 1);
});

test('applyStateUpdates: appends to choice history stamped with the new turn number', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {
    choice_log: { action: 'checked on Elara', consequence: 'found her feverish' },
  }, 'n');

  assert.strictEqual(session.choice_history.length, 1);
  assert.deepStrictEqual(session.choice_history[0], {
    turn: 4,
    action: 'checked on Elara',
    consequence: 'found her feverish',
  });
});

test('applyStateUpdates: accepts the choice_history key the prompt asks for', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {
    choice_history: { action: 'checked on Elara', consequence: 'found her feverish' },
  }, 'n');

  assert.deepStrictEqual(session.choice_history, [
    { turn: 4, action: 'checked on Elara', consequence: 'found her feverish' },
  ]);
});

test('applyStateUpdates: accepts a list of choice_history entries', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {
    choice_history: [
      { action: 'checked on Elara', consequence: 'found her feverish' },
      { action: 'read the torn page', consequence: 'learned of moonpetal' },
    ],
  }, 'n');

  assert.strictEqual(session.choice_history.length, 2);
  assert.ok(session.choice_history.every(e => e.turn === 4));
});

test('applyStateUpdates: the code sets the choice turn number, not the model', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {
    choice_history: { turn: 99, action: 'a', consequence: 'c' },
  }, 'n');

  assert.strictEqual(session.choice_history[0].turn, 4);
});

test('applyStateUpdates: records no choice when the AI reports none, such as small talk', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');

  const smallTalk = makeSession();
  svc.applyStateUpdates(smallTalk, {}, 'Elara stirs at your greeting.', 'hi');
  assert.deepStrictEqual(smallTalk.choice_history, []);

  const noBlock = makeSession();
  svc.applyStateUpdates(noBlock, null, 'The scene unfolds.', 'I check on Elara');
  assert.deepStrictEqual(noBlock.choice_history, []);

  const opening = makeSession({ session: { turn_count: 0 } });
  svc.applyStateUpdates(opening, {}, 'Opening narration.', 'Opening turn instruction');
  assert.deepStrictEqual(opening.choice_history, []);
});

test('applyStateUpdates: appends user action and narration to conversation_history', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {}, 'The scene unfolds.', 'I check on Elara');

  assert.strictEqual(session.conversation_history.length, 2);
  assert.deepStrictEqual(session.conversation_history[0], { role: 'user', content: 'I check on Elara' });
  assert.deepStrictEqual(session.conversation_history[1], { role: 'assistant', content: 'The scene unfolds.' });
});

test('applyStateUpdates: does not append to conversation_history when userAction is omitted', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, {}, 'The scene unfolds.');

  assert.strictEqual(session.conversation_history.length, 0);
});

test('applyStateUpdates: initialises conversation_history if missing from session', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();
  delete session.conversation_history;

  svc.applyStateUpdates(session, {}, 'narration', 'action');

  assert.ok(Array.isArray(session.conversation_history));
  assert.strictEqual(session.conversation_history.length, 2);
});

// --- Known defects -----------------------------------------------------------

test('applyStateUpdates: keeps the turn count and last scene when stateUpdate is null', () => {
  // A reply with no state block (a clarification, healthcheck or resume) is
  // not a story turn: it leaves turn_count and last_llm_output alone, but
  // still records when the reader was last active.
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();
  session.session.last_action_at = 'EARLIER';

  svc.applyStateUpdates(session, null, 'NEW NARRATION');

  assert.strictEqual(session.session.turn_count, 3);
  assert.strictEqual(session.session.last_llm_output, 'PREVIOUS NARRATION');
  assert.notStrictEqual(session.session.last_action_at, 'EARLIER');
});

// Fixed by state validation (src/StateValidator.js); was a TODO test.
test('applyStateUpdates: plot beats are not recorded twice', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, { story: { plot_beats_hit: ['enter_forest'] } }, 'n');
  svc.applyStateUpdates(session, { story: { plot_beats_hit: ['enter_forest'] } }, 'n');

  assert.deepStrictEqual(session.story.plot_beats_hit, ['enter_forest']);
});

// Fixed by state validation (src/StateValidator.js); was a TODO test.
test('applyStateUpdates: flags are one-way and cannot be reset to false', () => {
  // docs/state-management.md and AGENTS.md both state "Flags never go back to
  // false"; the validator now rejects a true to false change.
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();

  svc.applyStateUpdates(session, { story: { flags: { story_started: true } } }, 'n');
  svc.applyStateUpdates(session, { story: { flags: { story_started: false } } }, 'n');

  assert.strictEqual(session.story.flags.story_started, true);
});

test('applyStateUpdates: rejects moving current_act back to act 0 and clearing the scene', () => {
  const svc = new NarrationService(makeStoryManagerStub(), 'key');
  const session = makeSession();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  let result;
  try {
    result = svc.applyStateUpdates(session, { story: { current_act: 0, current_scene: '' } }, 'n');
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(session.story.current_act, 1);
  assert.strictEqual(session.story.current_scene, 'Morning in the Apothecary');
  assert.deepStrictEqual(result.rejected.map(r => r.path).sort(), ['story.current_act', 'story.current_scene']);
  assert.strictEqual(warnings.length, 2);
});
