const test = require('node:test');
const assert = require('node:assert');

const DiscordUI = require('../src/DiscordUI');

const DISCORD_LIMIT = 2000;

function makeUI(stories = [], sessions = []) {
  const storyMap = new Map(stories.map(s => [s.id, s]));
  return new DiscordUI(
    {
      getAllStories: () => storyMap,
      getStory: (id) => storyMap.get(id),
    },
    {
      getUserSessions: async () => sessions,
    }
  );
}

function story(id, extra = {}) {
  return {
    id,
    title: `Story ${id}`,
    description: 'A description',
    genre: 'Fantasy',
    estimatedPlayTime: '10 minutes',
    ...extra,
  };
}

// --- splitMessage ------------------------------------------------------------

test('splitMessage: returns a single chunk when the text fits', () => {
  const ui = makeUI();
  assert.deepStrictEqual(ui.splitMessage('short text'), ['short text']);
});

test('splitMessage: returns the text unchanged at exactly the limit', () => {
  const ui = makeUI();
  const text = 'a'.repeat(DISCORD_LIMIT);
  assert.deepStrictEqual(ui.splitMessage(text), [text]);
});

test('splitMessage: splits on line boundaries', () => {
  const ui = makeUI();
  const chunks = ui.splitMessage('aaaa\nbbbb\ncccc', 10);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 10, `chunk of ${chunk.length} exceeds limit`);
  }
});

test('splitMessage: preserves all content across chunks', () => {
  const ui = makeUI();
  const lines = Array.from({ length: 200 }, (_, i) => `Line number ${i} of narration prose.`);
  const text = lines.join('\n');

  const chunks = ui.splitMessage(text, DISCORD_LIMIT);

  assert.ok(chunks.length > 1, 'long text should be split');
  assert.strictEqual(chunks.join('\n'), text);
});

test('splitMessage: every chunk respects the Discord limit for realistic narration', () => {
  const ui = makeUI();
  const paragraph = 'You step into the apothecary and the smell of dried lavender greets you.';
  const text = Array.from({ length: 100 }, () => paragraph).join('\n');

  for (const chunk of ui.splitMessage(text, DISCORD_LIMIT)) {
    assert.ok(chunk.length <= DISCORD_LIMIT, `chunk of ${chunk.length} exceeds ${DISCORD_LIMIT}`);
  }
});

test('splitMessage: never emits an empty chunk', () => {
  const ui = makeUI();
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');

  for (const chunk of ui.splitMessage(text, 20)) {
    assert.notStrictEqual(chunk.length, 0, 'Discord rejects empty messages');
  }
});

// --- buildStorySelectionUI ---------------------------------------------------

test('buildStorySelectionUI: builds an embed with one field per story', () => {
  const ui = makeUI([story('a'), story('b')]);

  const { embed, rows } = ui.buildStorySelectionUI();
  const data = embed.toJSON();

  assert.strictEqual(data.fields.length, 2);
  assert.match(data.title, /NarratorBot/);
  assert.ok(rows.length >= 1);
});

test('buildStorySelectionUI: gives each story a button carrying its id', () => {
  const ui = makeUI([story('the-herbalists-choice')]);

  const { rows } = ui.buildStorySelectionUI();
  const buttons = rows.flatMap(r => r.toJSON().components);

  assert.strictEqual(buttons.length, 1);
  assert.strictEqual(buttons[0].custom_id, 'start_story_the-herbalists-choice');
});

test('buildStorySelectionUI: respects the five-buttons-per-row limit', () => {
  const ui = makeUI(Array.from({ length: 7 }, (_, i) => story(`s${i}`)));

  const { rows } = ui.buildStorySelectionUI();

  for (const row of rows) {
    assert.ok(row.toJSON().components.length <= 5, 'a row may hold at most 5 buttons');
  }
  assert.strictEqual(rows.flatMap(r => r.toJSON().components).length, 7);
});

test('buildStorySelectionUI: produces no button rows when no stories are loaded', () => {
  const ui = makeUI([]);

  const { embed, rows } = ui.buildStorySelectionUI();

  assert.strictEqual(rows.length, 0);
  assert.strictEqual(embed.toJSON().fields, undefined);
});

// --- buildSessionSelectionUI -------------------------------------------------

function sessionSummary(n, extra = {}) {
  return {
    sessionNumber: n,
    storyId: 'a',
    startedAt: new Date(2024, 0, n).toISOString(),
    status: 'active',
    turnCount: n * 2,
    ...extra,
  };
}

test('buildSessionSelectionUI: returns null when the user has no sessions', async () => {
  const ui = makeUI([story('a')], []);
  assert.strictEqual(await ui.buildSessionSelectionUI('42'), null);
});

test('buildSessionSelectionUI: lists sessions and appends a new-game button', async () => {
  const ui = makeUI([story('a')], [sessionSummary(2), sessionSummary(1)]);

  const { embed, rows } = await ui.buildSessionSelectionUI('42');
  const buttons = rows.flatMap(r => r.toJSON().components);

  assert.strictEqual(embed.toJSON().fields.length, 2);
  assert.deepStrictEqual(
    buttons.map(b => b.custom_id),
    ['load_session_2', 'load_session_1', 'start_new_game']
  );
});

test('buildSessionSelectionUI: caps the list at ten sessions', async () => {
  const sessions = Array.from({ length: 15 }, (_, i) => sessionSummary(15 - i));
  const ui = makeUI([story('a')], sessions);

  const { embed, rows } = await ui.buildSessionSelectionUI('42');
  const loadButtons = rows
    .flatMap(r => r.toJSON().components)
    .filter(b => b.custom_id.startsWith('load_session_'));

  assert.strictEqual(embed.toJSON().fields.length, 10);
  assert.strictEqual(loadButtons.length, 10);
});

test('buildSessionSelectionUI: marks completed sessions distinctly', async () => {
  const ui = makeUI([story('a')], [sessionSummary(1, { status: 'completed' })]);

  const { embed } = await ui.buildSessionSelectionUI('42');

  assert.match(embed.toJSON().fields[0].name, /✅/);
});

test('buildSessionSelectionUI: tolerates a session whose story is no longer installed', async () => {
  const ui = makeUI([], [sessionSummary(1, { storyId: 'removed-story' })]);

  const { embed } = await ui.buildSessionSelectionUI('42');

  assert.match(embed.toJSON().fields[0].name, /Unknown/);
});

test('buildSessionSelectionUI: never exceeds the five-actionrow limit', async () => {
  const sessions = Array.from({ length: 15 }, (_, i) => sessionSummary(15 - i));
  const ui = makeUI([story('a')], sessions);

  const { rows } = await ui.buildSessionSelectionUI('42');

  assert.ok(rows.length <= 5, `Discord allows at most 5 action rows, got ${rows.length}`);
});

// --- Known defects -----------------------------------------------------------

test('BUG: a single line longer than the limit is not broken up', { todo: true }, () => {
  // splitMessage only breaks on '\n'. One very long paragraph (which the model
  // regularly produces) is pushed through whole and Discord rejects it.
  const ui = makeUI();
  const oneLongLine = 'a'.repeat(3000);

  for (const chunk of ui.splitMessage(oneLongLine, DISCORD_LIMIT)) {
    assert.ok(chunk.length <= DISCORD_LIMIT, `chunk of ${chunk.length} exceeds ${DISCORD_LIMIT}`);
  }
});

test('BUG: an oversized first line produces a leading empty chunk', { todo: true }, () => {
  // currentChunk is still '' on the first iteration, so it gets pushed as-is.
  const ui = makeUI();

  const chunks = ui.splitMessage('a'.repeat(3000), DISCORD_LIMIT);

  assert.ok(!chunks.includes(''), 'Discord rejects empty messages');
});
