const test = require('node:test');
const assert = require('node:assert');

const NarrationService = require('../src/NarrationService');

const storyManagerStub = {
  getSystemPrompt: () => 'SYSTEM',
  getConcludingDirective: () => `## ⚠️ FINAL TURN — ENDING DIRECTIVE

The end conditions have all been met. This is the **final turn** of the story. The application has already recorded the ending. You must:

1. Write the closing scene using the ending format described in the system prompt (closing scene, \`========\` divider, "The story ends here.", "The End").
2. Do **not** include a summary prompt, numbered choices, or a custom action prompt.
3. Follow the recorded ending below. Weave every named variant into the closing scene. If no variant matched, write the closing scene from the current state. Do not choose or infer an ending yourself.
4. Include a JSON state block as usual, but do **not** set \`session.status\` or \`session.ending_variant\` — the application handles those.

{chosen_endings}`,
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
            { flag: 'corwin_involvement', value: false },
          ],
          description: 'The reader sits with Elara as she recovers.',
        },
        {
          id: 'corwin_involved',
          conditions: [{ flag: 'corwin_involvement', value: true }],
          description: 'Corwin visits, grudgingly impressed.',
        },
        {
          id: 'halden_turned_away',
          conditions: [
            { flag: 'halden_encountered', value: true },
            { flag: 'halden_reconciled', value: false },
            { flag: 'tomas_involved', value: false },
            { flag: 'corwin_involvement', value: false },
          ],
          description: 'The reader brings the moonpetal home without Halden.',
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
  session.characters.elara.health = 'recovering';
  assert.strictEqual(svc.evaluateEndConditions(session, config), false);
});

test('evaluateEndConditions: returns true when both conditions are met, without halden_reconciled', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();
  const session = makeSession();
  session.story.flags.moonpetal_obtained = true;
  session.characters.elara.health = 'recovering';

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

test('buildPrompt: concluding directive names the recorded variants and does not ask the model to choose', () => {
  const svc = makeService();
  const session = makeSession({
    session: { status: 'concluding', ending_variant: ['halden_reconciled', 'tomas_helped'] },
  });
  const { userMessage } = svc.buildPrompt(session, 'action');
  const directive = userMessage.slice(userMessage.indexOf('FINAL TURN'));

  assert.ok(directive.indexOf('`halden_reconciled`') < directive.indexOf('`tomas_helped`'));
  assert.match(directive, /Halden visits regularly now/);
  assert.match(directive, /Tomas and the reader share a quiet moment/);
  assert.match(directive, /Do not choose or infer an ending yourself/);
  assert.doesNotMatch(directive, /Infer the appropriate ending/);
  assert.doesNotMatch(directive, /select the one/);
});

test('buildPrompt: a concluding session with no recorded ending does not ask the model to pick one', () => {
  const svc = makeService();
  const session = makeSession({ session: { status: 'concluding', ending_variant: null } });
  const { userMessage } = svc.buildPrompt(session, 'action');
  const directive = userMessage.slice(userMessage.indexOf('FINAL TURN'));

  assert.match(directive, /No ending variant matched the current flags/);
  assert.match(directive, /Do not choose an ending yourself/);
  assert.doesNotMatch(directive, /`halden_reconciled`/);
  assert.doesNotMatch(directive, /Infer the appropriate ending/);
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

test('applyStateUpdates: keeps turn_count and last_llm_output when stateUpdate is null', () => {
  const svc = makeService();
  const session = makeSession();
  const before = session.session.turn_count;

  svc.applyStateUpdates(session, null, 'NEW NARRATION');

  assert.strictEqual(session.session.turn_count, before);
  assert.strictEqual(session.session.last_llm_output, 'PREVIOUS');
});

// --- Integration: the full concluding flow ----------------------------------

test('Full flow: active → concluding → completed across two turns', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();
  const session = makeSession();

  // Turn 1: the reader obtains the moonpetal and reconciles Halden.
  // halden_encountered is set too, so the solo variant does not also match.
  svc.applyStateUpdates(session, {
    story: { flags: { moonpetal_obtained: true, halden_reconciled: true, halden_encountered: true } },
    characters: { elara: { health: 'recovering' } },
  }, 'You give Elara the moonpetal tea. Halden stands beside you, tears in his eyes.', 'I give Elara the tea');

  // After applying state, check end conditions and record the ending.
  assert.strictEqual(svc.evaluateEndConditions(session, config), true);
  svc.recordEnding(session, config);
  session.session.status = 'concluding';

  assert.strictEqual(session.session.status, 'concluding');
  assert.deepStrictEqual(session.session.ending_variant, ['halden_reconciled']);

  // Turn 2: the concluding turn. The directive names the recorded ending.
  const { userMessage } = svc.buildPrompt(session, 'I sit with Elara as she recovers');
  const directive = userMessage.slice(userMessage.indexOf('FINAL TURN'));
  assert.match(directive, /`halden_reconciled`/);
  assert.match(directive, /Halden visits regularly now/);
  assert.doesNotMatch(directive, /Infer the appropriate ending/);

  // The model cannot change status or the ending. The bot then completes the story.
  svc.applyStateUpdates(session, {
    session: { status: 'active', ending_variant: ['solo_path'] },
    story: { current_scene: 'Epilogue' },
  }, 'The apothecary has three people in it. The End', 'I sit with Elara');
  assert.strictEqual(session.session.status, 'concluding');
  assert.deepStrictEqual(session.session.ending_variant, ['halden_reconciled']);
  session.session.status = 'completed';

  assert.strictEqual(session.session.status, 'completed');
  assert.deepStrictEqual(session.session.ending_variant, ['halden_reconciled']);
  assert.strictEqual(session.session.turn_count, 7); // 5 + 1 + 1
});

test('recordEnding: saves one match', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();
  const session = makeSession();
  session.story.flags.moonpetal_obtained = true;
  session.characters.elara.health = 'recovering';

  svc.recordEnding(session, config);

  assert.deepStrictEqual(session.session.ending_variant, ['solo_path']);
});

test('recordEnding: saves a mixed route in config order and drops nothing', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();
  const session = makeSession();
  session.story.flags.halden_reconciled = true;
  session.story.flags.halden_encountered = true;
  session.story.flags.tomas_involved = true;

  const matched = svc.recordEnding(session, config);

  assert.deepStrictEqual(matched, ['halden_reconciled', 'tomas_helped']);
  assert.deepStrictEqual(session.session.ending_variant, ['halden_reconciled', 'tomas_helped']);
});

test('recordEnding: follows config order when the mixed route is listed the other way', () => {
  const svc = makeService();
  const { config } = storyManagerStub.getStory();
  const reversed = {
    ...config,
    ending_variants: config.ending_variants.filter(variant => variant.id === 'tomas_helped' || variant.id === 'halden_reconciled').reverse(),
  };
  const session = makeSession();
  session.story.flags.halden_reconciled = true;
  session.story.flags.halden_encountered = true;
  session.story.flags.tomas_involved = true;

  svc.recordEnding(session, reversed);

  assert.deepStrictEqual(session.session.ending_variant, ['tomas_helped', 'halden_reconciled']);
});

test('recordEnding: leaves null and warns when nothing matches', () => {
  const svc = makeService();
  const session = makeSession();
  session.session.session_id = 'session-42-1';
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    svc.recordEnding(session, {
      ending_variants: [{ id: 'unreachable', conditions: [{ flag: 'moonpetal_obtained', value: true }] }],
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(session.session.ending_variant, null);
  assert.deepStrictEqual(warnings, ['[ending] session=session-42-1 no ending variant matched the current flags']);
});

test('prompts: the model is not asked to infer or select the ending', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const directive = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'concluding-directive.md'), 'utf8');
  const system = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'system-prompt.md'), 'utf8');

  assert.match(directive, /\{chosen_endings\}/);
  assert.match(directive, /Do not choose or infer an ending yourself/);
  assert.match(directive, /healthcheck or needs clarification/);
  assert.match(directive, /get_last_narration/);
  assert.doesNotMatch(directive, /Infer the appropriate ending/);
  assert.doesNotMatch(directive, /select the one/);
  assert.doesNotMatch(system, /you do that on the concluding turn/);
  assert.doesNotMatch(system, /It does not say which ending variant applies/);
  assert.doesNotMatch(system, /Select the variant/);
  assert.doesNotMatch(system, /to select the appropriate ending variant/);
  assert.match(system, /do not use `halden_turned_away`/);
  assert.match(system, /write the reunion of Halden and Elara into the closing scene instead/);
});

test('stub config: end conditions and ending rules match the shipped story config', () => {
  const real = require('../stories/the-herbalists-choice-config.json');
  const { config } = storyManagerStub.getStory();
  assert.deepStrictEqual(config.end_conditions, real.end_conditions);
  const rules = variants => variants.map(({ id, conditions }) => ({ id, conditions }));
  assert.deepStrictEqual(rules(config.ending_variants), rules(real.ending_variants));
});
