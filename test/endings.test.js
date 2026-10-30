// Plays The Herbalist's Choice to each of its four endings through the real
// parse and save path, with the real story config and session template. The
// routes follow the reference trace used to review PR 1. No AI service is
// called: each reply is built locally.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const StoryManager = require('../src/StoryManager');
const NarrationService = require('../src/NarrationService');

const ROOT = path.join(__dirname, '..');
const template = require('../sessions/session-template.json');

function reply(update) {
  return 'scene\n========\nWhat now?\n1. a\n2. b\n\n```json\n' + JSON.stringify(update, null, 2) + '\n```';
}

const ACT_1 = [
  {
    characters: { elara: { health: 'critical_fever', consciousness: 'barely_conscious', disposition: 'delirious' } },
    story: { plot_beats_hit: ['elara_found_sick'], flags: { story_started: true, reader_checked_elara: true } },
    choice_history: { action: 'check Elara', consequence: 'feverish' },
  },
  {
    reader: { knowledge: ['greymere_fever', 'moonpetal_cure'] },
    story: { plot_beats_hit: ['greymere_fever_identified', 'discover_moonpetal_cure', 'decide_on_path'], flags: { reader_found_torn_page: true }, act_progress: 'late' },
    choice_history: { action: 'search books', consequence: 'torn page' },
  },
  {
    story: { current_act: 2, act_progress: 'early', current_scene: 'The Crossroads' },
    characters: { elara: { health: 'deteriorating', consciousness: 'fading' } },
    reader: { location: 'village_square' },
    world: { locations: { village_square: { visited: true, visit_count: 1, last_visited: 'Day 1, morning' } } },
  },
];

const ACT_2_ROUTES = {
  halden_reconciled: [
    { story: { plot_beats_hit: ['halden_encounter'], flags: { reader_left_apothecary: true, halden_encountered: true } }, reader: { location: 'haldens_cottage' }, characters: { halden: { disposition: 'curt, dismissive' } } },
    { story: { plot_beats_hit: ['enter_forest'], flags: { forest_entered: true } }, reader: { location: 'greymere_forest' }, world: { village_awareness: { forest_activity: 'someone_entered' } } },
    { story: { plot_beats_hit: ['obtain_moonpetal'], flags: { moonpetal_obtained: true } }, reader: { inventory: ['basic herb kit', 'moonpetal'] } },
  ],
  tomas_helped: [
    { story: { flags: { reader_left_apothecary: true, tomas_involved: true } }, reader: { location: 'village_square' } },
    { story: { plot_beats_hit: ['enter_forest'], flags: { forest_entered: true } }, reader: { location: 'greymere_forest' } },
    { story: { plot_beats_hit: ['obtain_moonpetal'], flags: { moonpetal_obtained: true } } },
  ],
  solo_path: [
    { story: { plot_beats_hit: ['enter_forest'], flags: { reader_left_apothecary: true, forest_entered: true } }, reader: { location: 'greymere_forest' } },
    { story: { plot_beats_hit: ['obtain_moonpetal'], flags: { moonpetal_obtained: true } } },
  ],
  corwin_involved: [
    { story: { plot_beats_hit: ['corwin_refusal'], flags: { reader_left_apothecary: true, corwin_encountered: true } }, reader: { location: 'village_square' } },
    { story: { plot_beats_hit: ['enter_forest'], flags: { forest_entered: true, corwin_involvement: true } }, reader: { location: 'greymere_forest' } },
    { story: { plot_beats_hit: ['obtain_moonpetal'], flags: { moonpetal_obtained: true } } },
  ],
  // The reader meets Halden, is turned away, and finds the moonpetal alone.
  halden_turned_away: [
    { story: { plot_beats_hit: ['halden_encounter'], flags: { reader_left_apothecary: true, halden_encountered: true } }, reader: { location: 'haldens_cottage' }, characters: { halden: { disposition: 'curt, dismissive' } } },
    { story: { plot_beats_hit: ['enter_forest'], flags: { forest_entered: true } }, reader: { location: 'greymere_forest' } },
    { story: { plot_beats_hit: ['obtain_moonpetal'], flags: { moonpetal_obtained: true } } },
  ],
};

// Act 3: the reader returns and Elara recovers. Only the Halden route has the
// reunion beat and sets halden_reconciled; the other routes never meet her.
const ACT_3 = [
  {
    story: { current_act: 3, plot_beats_hit: ['elara_recovery'] },
    characters: { elara: { health: 'recovering', consciousness: 'awake', disposition: 'calm, grateful' } },
    reader: { location: 'apothecary' },
  },
];

const ACT_3_WITH_HALDEN = [
  {
    story: { current_act: 3, plot_beats_hit: ['elara_recovery', 'halden_elara_reunion'], flags: { halden_reconciled: true } },
    characters: { elara: { health: 'recovering', consciousness: 'awake', disposition: 'calm, grateful' } },
    reader: { location: 'apothecary' },
  },
];

function act3For(ending) {
  return ending === 'halden_reconciled' ? ACT_3_WITH_HALDEN : ACT_3;
}

async function loadStory() {
  const storyManager = new StoryManager(path.join(ROOT, 'stories'), path.join(ROOT, 'prompts'));
  const originalLog = console.log;
  console.log = () => {};
  try {
    await storyManager.loadStoryData();
  } finally {
    console.log = originalLog;
  }
  return storyManager;
}

function matchingVariants(session, config) {
  return config.ending_variants
    .filter(variant => variant.conditions.every(cond => session.story.flags[cond.flag] === cond.value))
    .map(variant => variant.id);
}

function play(svc, config, replies) {
  const session = JSON.parse(JSON.stringify(template));
  session.session.session_id = 'session-1-1';
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  let endedAtTurn = null;
  try {
    replies.forEach((update, i) => {
      const { narration, stateUpdate } = svc.parseResponse(reply(update));
      svc.applyStateUpdates(session, stateUpdate, narration, i === 0 ? 'opening' : `action ${i}`);
      if (endedAtTurn === null && svc.evaluateEndConditions(session, config)) endedAtTurn = session.session.turn_count;
    });
  } finally {
    console.warn = originalWarn;
  }
  return { session, warnings, endedAtTurn };
}

for (const [ending, act2] of Object.entries(ACT_2_ROUTES)) {
  test(`playthrough: the ${ending} route reaches an ending with nothing rejected`, async () => {
    const storyManager = await loadStory();
    const config = storyManager.getStory('the-herbalists-choice').config;
    const svc = new NarrationService(storyManager, 'key', { llmClient: { call: async () => '' } });

    const replies = [{}, ...ACT_1, ...act2, ...act3For(ending)];
    const { session, warnings, endedAtTurn } = play(svc, config, replies);

    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(endedAtTurn, replies.length, 'the ending should trigger on the final reply, not before');
    assert.strictEqual(session.story.current_act, 3);
    assert.strictEqual(session.characters.elara.health, 'recovering');
    assert.deepStrictEqual(matchingVariants(session, config), [ending]);
    assert.strictEqual(session.choice_history.length, 2);
  });
}

test('playthrough: the solo route ends without ever meeting Halden', async () => {
  const storyManager = await loadStory();
  const config = storyManager.getStory('the-herbalists-choice').config;
  const svc = new NarrationService(storyManager, 'key', { llmClient: { call: async () => '' } });

  const replies = [{}, ...ACT_1, ...ACT_2_ROUTES.solo_path, ...ACT_3];
  const { session, warnings, endedAtTurn } = play(svc, config, replies);

  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(session.story.flags.halden_encountered, false);
  assert.strictEqual(session.story.flags.halden_reconciled, false);
  assert.strictEqual(session.characters.elara.health, 'recovering');
  assert.strictEqual(endedAtTurn, replies.length);
  assert.deepStrictEqual(matchingVariants(session, config), ['solo_path']);
});

test('story config: no ending requires halden_reconciled together with halden_encountered false', () => {
  const config = require('../stories/the-herbalists-choice-config.json');
  const required = config.end_conditions.all_required;
  assert.ok(!required.some(cond => cond.flag === 'halden_reconciled'), 'end conditions must not require halden_reconciled for every ending');
  for (const variant of config.ending_variants) {
    const all = [...required, ...variant.conditions];
    const needsMeeting = all.some(cond => cond.flag === 'halden_reconciled' && cond.value === true);
    const needsNoMeeting = all.some(cond => cond.flag === 'halden_encountered' && cond.value === false);
    assert.ok(!(needsMeeting && needsNoMeeting), `${variant.id} contradicts itself`);
  }
});

test('playthrough: meeting Corwin during act 1 still reaches the corwin_involved ending', async () => {
  const storyManager = await loadStory();
  const config = storyManager.getStory('the-herbalists-choice').config;
  const svc = new NarrationService(storyManager, 'key', { llmClient: { call: async () => '' } });

  const [corwin, ...restOfAct2] = ACT_2_ROUTES.corwin_involved;
  const replies = [{}, ACT_1[0], ACT_1[1], corwin, ACT_1[2], ...restOfAct2, ...ACT_3];
  const { session, warnings, endedAtTurn } = play(svc, config, replies);

  assert.deepStrictEqual(warnings, []);
  assert.ok(session.story.plot_beats_hit.includes('corwin_refusal'));
  assert.strictEqual(endedAtTurn, replies.length);
  assert.deepStrictEqual(matchingVariants(session, config), ['corwin_involved']);
});

test('playthrough: no scripted route matches more than one ending', async () => {
  const storyManager = await loadStory();
  const config = storyManager.getStory('the-herbalists-choice').config;
  const svc = new NarrationService(storyManager, 'key', { llmClient: { call: async () => '' } });

  const [corwin, ...restOfCorwinAct2] = ACT_2_ROUTES.corwin_involved;
  const routes = {
    ...Object.fromEntries(Object.entries(ACT_2_ROUTES).map(([ending, act2]) => [ending, [{}, ...ACT_1, ...act2, ...act3For(ending)]])),
    corwin_met_in_act_1: [{}, ACT_1[0], ACT_1[1], corwin, ACT_1[2], ...restOfCorwinAct2, ...ACT_3],
  };

  for (const [route, replies] of Object.entries(routes)) {
    const { session } = play(svc, config, replies);
    const matched = matchingVariants(session, config);
    assert.strictEqual(matched.length, 1, `${route} matched ${JSON.stringify(matched)}`);
  }
});

test('playthrough: a mixed Halden and Tomas route matches both of their endings, by design', async () => {
  const storyManager = await loadStory();
  const config = storyManager.getStory('the-herbalists-choice').config;
  const svc = new NarrationService(storyManager, 'key', { llmClient: { call: async () => '' } });

  const [tomasJoins] = ACT_2_ROUTES.tomas_helped;
  const replies = [{}, ...ACT_1, tomasJoins, ...ACT_2_ROUTES.halden_reconciled, ...ACT_3_WITH_HALDEN];
  const { warnings, session, endedAtTurn } = play(svc, config, replies);

  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(endedAtTurn, replies.length);
  // The concluding directive lets the AI weave a combination of endings.
  assert.deepStrictEqual(matchingVariants(session, config), ['halden_reconciled', 'tomas_helped']);
});
