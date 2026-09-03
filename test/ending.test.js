const test = require('node:test');
const assert = require('node:assert');

const NarrationService = require('../src/NarrationService');

const storyManagerStub = {
  getSystemPrompt: () => 'SYSTEM',
  getConcludingDirective: () => `## ⚠️ FINAL TURN — ENDING DIRECTIVE

The end conditions have all been met. This is the **final turn** of the story. You must:

1. Write the closing scene using the ending format described in the system prompt (closing scene, \`========\` divider, "The story ends here.", "The End").
2. Do **not** include a summary prompt, numbered choices, or a custom action prompt.
3. Infer the appropriate ending from the current game state — the flags, character relationships, and events that occurred. The \`ending_variants\` in the story config describe possible endings; select the one (or combination) that best matches the reader's journey and weave it into the closing scene.
4. Include a JSON state block as usual, but do **not** set \`session.status\` or \`session.ending_variant\` — the application handles those.`,
  getStory: () => ({
    id: 'the-herbalists-choice',
    title: 'The Herbalist\'s Choice',
    content: 'CONTENT',
    config: {
      story_id: 'the-herbalists-choice',
      end_conditions: {
        all_required: [
          { flag: 'moonpetal_obtained', value: true },
          { character: 'elara', field: 'health', value: 'recovering' },
          { flag: 'halden_reconciled', value: true },
        ],
      },
      ending_variants: [
        {
          id: 'halden_reconciled',
          conditions: [{ flag: 'halden_reconciled', value: true }],
          description: 'Halden visits regularly now.',
        },
        {
          id: 'tomas_helped',
          conditions: [{ flag: 'tomas_involved', value: true }],
          description: 'Tomas and the reader share a quiet moment.',
        },
        {
          id: 'solo_path',
          conditions: [
            { flag: 'halden_encountered', value: false },
            { flag: 'tomas_involved', value: false },
          ],
          description: 'The reader sits with Elara as she recovers.',
        },
        {
          id: 'corwin_involved',
          conditions: [{ flag: 'corwin_involvement', value: true }],
          description: 'Corwin visits, grudgingly impressed.',
        },
      ],
      flags: {
        moonpetal_obtained: false,
        halden_reconciled: false,
        halden_encountered: false,
        tomas_involved: false,
        corwin_involvement: false,
      },
    },
  }),
};

function makeSession(overrides = {}) {
  return {
    session: {
      session_id: 'session-42-1',
      story_id: 'the-herbalists-choice',
      status: 'active',
      turn_count: 5,
      last_action_at: '2020-01-01T00:00:00.000Z',
      last_llm_output: 'PREVIOUS',
      ending_variant: null,
      ...overrides.session,
    },
    reader: { location: 'apothecary' },
    characters: {
      elara: { health: 'critical_fever', disposition: 'delirious' },
      halden: { health: 'healthy', disposition: 'hostile' },
    },
    story: {
      current_act: 2,
      current_scene: 'Forest Edge',
      plot_beats_hit: ['enter_forest'],
      flags: {
        moonpetal_obtained: false,
        halden_reconciled: false,
        halden_encountered: false,
        tomas_involved: false,
        corwin_involvement: false,
      },
    },
    world: { locations: {} },
    choice_history: [],
    conversation_history: [],
  };
}

function makeService() {
  return new NarrationService(storyManagerStub, 'test-key');
}

// --- evaluateEndConditions --------------------------------------------------

test('evaluateEndConditions: returns false when no conditions are met', () => {
  const svc = makeService();
  const session = makeSession();
  const { config } = storyManagerStub.getStory();

  assert.strictEqual(svc.evaluateEndConditions(session, config), false);
});

test('evaluateEndConditions: returns false when only some conditions are met', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();

  let session = makeSession();
  session.story.flags.moonpetal_obtained = true;
  assert.strictEqual(svc.evaluateEndConditions(session, config), false);

  session = makeSession();
  session.story.flags.moonpetal_obtained = true;
  session.characters.elara.health = 'recovering';
  assert.strictEqual(svc.evaluateEndConditions(session, config), false);
});

test('evaluateEndConditions: returns true when all three conditions are met', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();
  const session = makeSession();
  session.story.flags.moonpetal_obtained = true;
  session.characters.elara.health = 'recovering';
  session.story.flags.halden_reconciled = true;

  assert.strictEqual(svc.evaluateEndConditions(session, config), true);
});

test('evaluateEndConditions: checks character field, not just flags', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();
  const session = makeSession();
  session.story.flags.moonpetal_obtained = true;
  session.story.flags.halden_reconciled = true;
  session.characters.elara.health = 'deteriorating';

  assert.strictEqual(svc.evaluateEndConditions(session, config), false);
});

test('evaluateEndConditions: returns false for a missing character', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();
  const session = makeSession();
  session.story.flags.moonpetal_obtained = true;
  session.story.flags.halden_reconciled = true;
  delete session.characters.elara;

  assert.strictEqual(svc.evaluateEndConditions(session, config), false);
});

test('evaluateEndConditions: returns false when config has no end_conditions', () => {
  const svc = makeService();
  const session = makeSession();

  assert.strictEqual(svc.evaluateEndConditions(session, null), false);
  assert.strictEqual(svc.evaluateEndConditions(session, {}), false);
  assert.strictEqual(svc.evaluateEndConditions(session, { end_conditions: {} }), false);
});

// --- buildPrompt concluding directive ---------------------------------------

test('buildPrompt: does not include ending directive when status is active', () => {
  const svc = makeService();
  const session = makeSession();
  const { systemContext, userMessage } = svc.buildPrompt(session, 'I look around');
  const combined = systemContext + userMessage;

  assert.doesNotMatch(combined, /FINAL TURN/);
  assert.doesNotMatch(combined, /ENDING DIRECTIVE/);
});

test('buildPrompt: includes ending directive when status is concluding', () => {
  const svc = makeService();
  const session = makeSession({ session: { status: 'concluding' } });
  const { systemContext, userMessage } = svc.buildPrompt(session, 'I say goodbye to Elara');
  const combined = systemContext + userMessage;

  assert.match(combined, /FINAL TURN/);
  assert.match(combined, /ENDING DIRECTIVE/);
  assert.match(combined, /closing scene/);
  assert.match(combined, /The End/);
});

test('buildPrompt: concluding directive tells the LLM to infer ending from game state', () => {
  const svc = makeService();
  const session = makeSession({ session: { status: 'concluding' } });
  const { systemContext, userMessage } = svc.buildPrompt(session, 'action');
  const combined = systemContext + userMessage;

  assert.match(combined, /Infer the appropriate ending/);
  assert.match(combined, /ending_variants/);
});

test('buildPrompt: concluding directive tells the LLM not to set status or ending_variant', () => {
  const svc = makeService();
  const session = makeSession({ session: { status: 'concluding' } });
  const { systemContext, userMessage } = svc.buildPrompt(session, 'action');
  const combined = systemContext + userMessage;

  assert.match(combined, /do.*not.*set.*session\.status/);
  assert.match(combined, /application handles those/);
});

// --- applyStateUpdates bookkeeping fix --------------------------------------

test('applyStateUpdates: increments turn_count and sets last_llm_output even when stateUpdate is null', () => {
  const svc = makeService();
  const session = makeSession();
  const before = session.session.turn_count;

  svc.applyStateUpdates(session, null, 'NEW NARRATION');

  assert.strictEqual(session.session.turn_count, before + 1);
  assert.strictEqual(session.session.last_llm_output, 'NEW NARRATION');
});

// --- Integration: the full concluding flow ----------------------------------

test('Full flow: active → concluding → completed across two turns', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();
  const session = makeSession();

  // Turn 1: the reader obtains the moonpetal and reconciles Halden
  svc.applyStateUpdates(session, {
    story: { flags: { moonpetal_obtained: true, halden_reconciled: true } },
    characters: { elara: { health: 'recovering' } },
  }, 'You give Elara the moonpetal tea. Halden stands beside you, tears in his eyes.', 'I give Elara the tea');

  // After applying state, check end conditions
  assert.strictEqual(svc.evaluateEndConditions(session, config), true);

  // Transition to concluding (bot does this, no variant matching)
  session.session.status = 'concluding';

  assert.strictEqual(session.session.status, 'concluding');

  // Turn 2: the concluding turn — LLM writes the ending
  const { systemContext, userMessage } = svc.buildPrompt(session, 'I sit with Elara as she recovers');
  const combined = systemContext + userMessage;
  assert.match(combined, /FINAL TURN/);
  assert.match(combined, /Infer the appropriate ending/);

  // After the concluding turn, the bot transitions to completed
  svc.applyStateUpdates(session, { story: { current_scene: 'Epilogue' } }, 'The apothecary has three people in it. The End', 'I sit with Elara');
  session.session.status = 'completed';

  assert.strictEqual(session.session.status, 'completed');
  assert.strictEqual(session.session.turn_count, 7); // 5 + 1 + 1
});
