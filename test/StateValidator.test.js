const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { validateStateUpdate } = require('../src/StateValidator');
const NarrationService = require('../src/NarrationService');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'stories/the-herbalists-choice-config.json'), 'utf8'));
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions/session-template.json'), 'utf8'));

function freshSession() {
  const session = JSON.parse(JSON.stringify(template));
  session.session.session_id = 'session-42-1';
  return session;
}

function realService() {
  return new NarrationService({
    getStory: () => ({ id: 'the-herbalists-choice', config }),
  }, 'key');
}

function quietly(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.warn = original;
  }
}

function reasonFor(rejected, p) {
  const item = rejected.find(r => r.path === p);
  return item && item.reason;
}

// --- Shipped config is self-consistent --------------------------------------

test('story config: end conditions and character phases only use allowed values', () => {
  const rules = config.state_rules.character_fields;
  for (const cond of config.end_conditions.all_required) {
    if (cond.character) assert.ok(rules[cond.field].includes(cond.value), `${cond.field}=${cond.value}`);
    if (cond.flag) assert.ok(cond.flag in config.flags, cond.flag);
  }
  for (const phases of Object.values(config.character_state_progression)) {
    for (const phase of phases.phases) {
      for (const [field, value] of Object.entries(phase.state)) {
        if (rules[field]) assert.ok(rules[field].includes(value), `${field}=${value}`);
      }
    }
  }
});

test('story config: the starting template only uses allowed values', () => {
  const rules = config.state_rules;
  for (const character of Object.values(template.characters)) {
    for (const [field, allowed] of Object.entries(rules.character_fields)) {
      assert.ok(allowed.includes(character[field]), `${field}=${character[field]}`);
    }
    assert.ok(config.locations.includes(character.location));
  }
  assert.ok(rules.act_progress.includes(template.story.act_progress));
  for (const [field, allowed] of Object.entries(rules.village_awareness)) {
    assert.ok(allowed.includes(template.world.village_awareness[field]), field);
  }
  assert.deepStrictEqual(Object.keys(template.story.flags).sort(), Object.keys(config.flags).sort());
});

// --- Shape ------------------------------------------------------------------

test('validate: accepts the top-level shape the prompt asks for', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    characters: { elara: { health: 'critical_fever' } },
    story: { flags: { reader_checked_elara: true }, plot_beats_hit: ['elara_found_sick'] },
  }, config);

  assert.deepStrictEqual(rejected, []);
  assert.deepStrictEqual(update.characters, { elara: { health: 'critical_fever' } });
  assert.deepStrictEqual(update.story.flags, { reader_checked_elara: true });
});

test('validate: tolerates the older state_update wrapper', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    state_update: { story: { flags: { reader_checked_elara: true } } },
  }, config);

  assert.deepStrictEqual(rejected, []);
  assert.deepStrictEqual(update.story.flags, { reader_checked_elara: true });
});

test('validate: a block that is not an object is ignored as a whole', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), ['not', 'an', 'object'], config);

  assert.strictEqual(update, null);
  assert.match(rejected[0].reason, /whole block ignored/);
});

test('validate: unknown top-level keys and session fields are rejected', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    session: { status: 'completed' },
    conversation_history: [],
    mystery: 1,
  }, config);

  assert.deepStrictEqual(update, {});
  assert.match(reasonFor(rejected, 'session'), /application/);
  assert.ok(reasonFor(rejected, 'conversation_history'));
  assert.ok(reasonFor(rejected, 'mystery'));
});

// --- Granularity ------------------------------------------------------------

test('validate: drops only the invalid field and keeps the rest of the turn', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    characters: { elara: { health: 'recovering slowly', consciousness: 'awake' } },
    story: { flags: { moonpetal_obtained: true } },
  }, config);

  assert.deepStrictEqual(update.characters, { elara: { consciousness: 'awake' } });
  assert.deepStrictEqual(update.story.flags, { moonpetal_obtained: true });
  assert.match(reasonFor(rejected, 'characters.elara.health'), /must be one of: .*recovering/);
});

// --- Characters -------------------------------------------------------------

test('validate: character health must be one of the fixed values', () => {
  const good = validateStateUpdate(freshSession(), { characters: { elara: { health: 'recovering' } } }, config);
  assert.deepStrictEqual(good.rejected, []);

  const bad = validateStateUpdate(freshSession(), { characters: { elara: { health: 'Recovering' } } }, config);
  assert.strictEqual(bad.update.characters, undefined);
  assert.strictEqual(bad.rejected.length, 1);
});

test('validate: unknown characters, unknown fields and bad locations are rejected', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    characters: {
      mira: { health: 'healthy' },
      halden: { mood: 'angry', location: 'the_moon', disposition: 'curt, dismissive' },
    },
  }, config);

  assert.deepStrictEqual(update.characters, { halden: { disposition: 'curt, dismissive' } });
  assert.match(reasonFor(rejected, 'characters.mira'), /unknown character/);
  assert.match(reasonFor(rejected, 'characters.halden.mood'), /unknown field/);
  assert.match(reasonFor(rejected, 'characters.halden.location'), /must be one of/);
});

test('validate: revealed secrets are merged and never removed', () => {
  const session = freshSession();
  session.characters.halden.revealed_secrets = ['knows_elara'];
  const { update } = validateStateUpdate(session, {
    characters: { halden: { revealed_secrets: ['was_apprentice'] } },
  }, config);

  assert.deepStrictEqual(update.characters.halden.revealed_secrets, ['knows_elara', 'was_apprentice']);
});

test('validate: text fields must be text', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    characters: { tomas: { current_activity: 42, disposition: '' } },
  }, config);

  assert.strictEqual(update.characters, undefined);
  assert.match(reasonFor(rejected, 'characters.tomas.current_activity'), /text/);
  assert.match(reasonFor(rejected, 'characters.tomas.disposition'), /empty/);
});

// --- Reader -----------------------------------------------------------------

test('validate: reader location must be a known place and the name is code-owned', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    reader: { location: 'village_square', name: 'Bob', gold: 10 },
  }, config);

  assert.deepStrictEqual(update.reader, { location: 'village_square' });
  assert.ok(reasonFor(rejected, 'reader.name'));
  assert.ok(reasonFor(rejected, 'reader.gold'));

  const bad = validateStateUpdate(freshSession(), { reader: { location: 'Greymere Forest' } }, config);
  assert.match(reasonFor(bad.rejected, 'reader.location'), /must be one of/);
});

test('validate: reader knowledge only grows, inventory is the full new list', () => {
  const session = freshSession();
  session.reader.knowledge = ['elara_is_sick'];
  const { update } = validateStateUpdate(session, {
    reader: { knowledge: ['moonpetal_cures_fever'], inventory: ['basic herb kit', 'torn page'] },
  }, config);

  assert.deepStrictEqual(update.reader.knowledge, ['elara_is_sick', 'moonpetal_cures_fever']);
  assert.deepStrictEqual(update.reader.inventory, ['basic herb kit', 'torn page']);
});

test('validate: relationships only update known people', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    reader: { relationships: { halden: 'wary ally', stranger: 'odd' } },
  }, config);

  assert.strictEqual(update.reader.relationships.halden, 'wary ally');
  assert.strictEqual(update.reader.relationships.elara, template.reader.relationships.elara);
  assert.ok(reasonFor(rejected, 'reader.relationships.stranger'));
});

// --- Story ------------------------------------------------------------------

test('validate: unknown flags and non-boolean flag values are rejected', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    story: { flags: { found_treasure: true, forest_entered: 'yes' } },
  }, config);

  assert.strictEqual(update.story, undefined);
  assert.match(reasonFor(rejected, 'story.flags.found_treasure'), /unknown flag/);
  assert.match(reasonFor(rejected, 'story.flags.forest_entered'), /true or false/);
});

test('validate: flags are one-way', () => {
  const session = freshSession();
  session.story.flags.forest_entered = true;
  const { update, rejected } = validateStateUpdate(session, { story: { flags: { forest_entered: false } } }, config);

  assert.strictEqual(update.story, undefined);
  assert.match(reasonFor(rejected, 'story.flags.forest_entered'), /one-way/);
});

test('validate: plot beats must be known, new, and at most one act ahead', () => {
  const session = freshSession();
  session.story.plot_beats_hit = ['elara_found_sick'];
  const { update, rejected } = validateStateUpdate(session, {
    story: { plot_beats_hit: ['elara_found_sick', 'greymere_fever_identified', 'made_up_beat', 'elara_recovery'] },
  }, config);

  assert.deepStrictEqual(update.story.plot_beats_hit, ['greymere_fever_identified']);
  assert.strictEqual(rejected.length, 2);
  assert.match(rejected.find(r => r.value === '"made_up_beat"').reason, /unknown plot beat/);
  assert.match(rejected.find(r => r.value === '"elara_recovery"').reason, /act 3 but the story is in act 1/);
});

test('validate: meeting Corwin in act 1 keeps the act 2 corwin_refusal beat', () => {
  const svc = realService();
  const session = freshSession();
  assert.strictEqual(session.story.current_act, 1);

  const { lines } = quietly(() => svc.applyStateUpdates(session, {
    reader: { location: 'village_square' },
    story: { plot_beats_hit: ['corwin_refusal'], flags: { corwin_encountered: true } },
  }, 'n', 'I ask Corwin for permission to enter the forest'));

  assert.deepStrictEqual(lines, []);
  assert.deepStrictEqual(session.story.plot_beats_hit, ['corwin_refusal']);
  assert.strictEqual(session.story.flags.corwin_encountered, true);
  // The beat does not move the act on by itself.
  assert.strictEqual(session.story.current_act, 1);
});

test('validate: act 3 beats are kept when hit during act 2', () => {
  const session = freshSession();
  session.story.current_act = 2;
  const { update, rejected } = validateStateUpdate(session, {
    story: { plot_beats_hit: ['elara_recovery', 'halden_elara_reunion'] },
  }, config);

  assert.deepStrictEqual(rejected, []);
  assert.deepStrictEqual(update.story.plot_beats_hit, ['elara_recovery', 'halden_elara_reunion']);
});

test('validate: a later-act beat is allowed on the turn the act advances', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    story: { current_act: 2, plot_beats_hit: ['enter_forest'] },
  }, config);

  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(update.story.current_act, 2);
  assert.deepStrictEqual(update.story.plot_beats_hit, ['enter_forest']);
});

test('validate: acts only move forward one at a time and must exist', () => {
  for (const act of [0, 3, 4, '2', 1.5]) {
    const { update, rejected } = validateStateUpdate(freshSession(), { story: { current_act: act } }, config);
    assert.strictEqual(update.story, undefined, `act ${act}`);
    assert.ok(reasonFor(rejected, 'story.current_act'), `act ${act}`);
  }
  const session = freshSession();
  session.story.current_act = 2;
  const back = validateStateUpdate(session, { story: { current_act: 1 } }, config);
  assert.match(reasonFor(back.rejected, 'story.current_act'), /forward/);
});

test('validate: act progress uses fixed values; other story fields are code-owned', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    story: { act_progress: 'middle', current_scene: 'The Village Square', plot_beats_locked: [] },
  }, config);

  assert.deepStrictEqual(update.story, { act_progress: 'middle', current_scene: 'The Village Square' });
  assert.ok(reasonFor(rejected, 'story.plot_beats_locked'));

  const bad = validateStateUpdate(freshSession(), { story: { act_progress: 'nearly done' } }, config);
  assert.match(reasonFor(bad.rejected, 'story.act_progress'), /must be one of/);
});

// --- World ------------------------------------------------------------------

test('validate: location visits cannot be undone and counts cannot go down', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    world: {
      locations: {
        apothecary: { visited: false, visit_count: 0 },
        village_square: { visited: true, visit_count: 1, last_visited: 'Day 1, morning' },
        castle: { visited: true },
      },
    },
  }, config);

  assert.deepStrictEqual(update.world.locations, {
    village_square: { visited: true, visit_count: 1, last_visited: 'Day 1, morning' },
  });
  assert.ok(reasonFor(rejected, 'world.locations.apothecary.visited'));
  assert.ok(reasonFor(rejected, 'world.locations.apothecary.visit_count'));
  assert.match(reasonFor(rejected, 'world.locations.castle'), /unknown location/);
});

test('validate: village awareness uses fixed values', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    world: { village_awareness: { elara_illness: 'spreading', forest_activity: 'lots' }, weather: 'storm' },
  }, config);

  assert.deepStrictEqual(update.world.village_awareness, { elara_illness: 'spreading' });
  assert.ok(reasonFor(rejected, 'world.village_awareness.forest_activity'));
  assert.ok(reasonFor(rejected, 'world.weather'));
});

// --- Choice history ---------------------------------------------------------

test('validate: choice entries need an action and a consequence', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    choice_history: [
      { action: 'checked on Elara', consequence: 'found her feverish', key_state_changes: ['elara.health=critical_fever'] },
      { action: 'no consequence' },
      'just text',
    ],
  }, config);

  assert.deepStrictEqual(update.choice_history, [
    { action: 'checked on Elara', consequence: 'found her feverish', key_state_changes: ['elara.health=critical_fever'] },
  ]);
  assert.strictEqual(rejected.length, 2);
});

test('validate: choice_history wins when both keys are given', () => {
  const { update, rejected } = validateStateUpdate(freshSession(), {
    choice_history: { action: 'a', consequence: 'b' },
    choice_log: { action: 'c', consequence: 'd' },
  }, config);

  assert.deepStrictEqual(update.choice_history, [{ action: 'a', consequence: 'b' }]);
  assert.ok(reasonFor(rejected, 'choice_log'));
});

// --- Through NarrationService ----------------------------------------------

test('applyStateUpdates: invalid changes are never saved and are logged with a reason', () => {
  const svc = realService();
  const session = freshSession();

  const { lines } = quietly(() => svc.applyStateUpdates(session, {
    characters: { elara: { health: 'recovering slowly' } },
    story: { flags: { moonpetal_obtained: true, secret_flag: true } },
  }, 'n', 'I brew the tea'));

  assert.strictEqual(session.characters.elara.health, 'healthy');
  assert.strictEqual(session.story.flags.moonpetal_obtained, true);
  assert.ok(!('secret_flag' in session.story.flags));
  assert.strictEqual(lines.length, 2);
  assert.match(lines.join('\n'), /\[state-validation\] session=session-42-1 turn=1 rejected characters\.elara\.health="recovering slowly": must be one of/);
  assert.match(lines.join('\n'), /story\.flags\.secret_flag=true: unknown flag/);
});

test('applyStateUpdates: logged values are shortened', () => {
  const svc = realService();
  const session = freshSession();
  const { lines } = quietly(() => svc.applyStateUpdates(session, {
    characters: { elara: { health: 'x'.repeat(5000) } },
  }, 'n'));

  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].length < 400);
});

test('applyStateUpdates: an invalid choice entry falls back to the plain action entry', () => {
  const svc = realService();
  const session = freshSession();
  session.session.turn_count = 2;

  quietly(() => svc.applyStateUpdates(session, { choice_history: { note: 'nothing useful' } }, 'n', 'I look around'));

  assert.deepStrictEqual(session.choice_history, [{
    turn: 3,
    action: 'I look around',
    consequence: 'State advanced without structured choice details.',
  }]);
});

test('Full flow with the real config: the ending only triggers on the exact allowed values', () => {
  const svc = realService();
  const session = freshSession();
  session.story.current_act = 3;

  quietly(() => svc.applyStateUpdates(session, {
    story: { flags: { moonpetal_obtained: true, halden_reconciled: true } },
    characters: { elara: { health: 'recovering slowly' } },
  }, 'n', 'I give Elara the tea'));
  assert.strictEqual(svc.evaluateEndConditions(session, config), false);

  quietly(() => svc.applyStateUpdates(session, {
    characters: { elara: { health: 'recovering' } },
  }, 'n', 'I wait by her side'));
  assert.strictEqual(svc.evaluateEndConditions(session, config), true);
});
