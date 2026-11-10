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

  assert.deepStrictEqual(chunks, ['aaaa\nbbbb', 'cccc']);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 10, `chunk of ${chunk.length} exceeds limit`);
  }
});

test('splitMessage: keeps packing short lines up to the limit', () => {
  const ui = makeUI();
  assert.deepStrictEqual(ui.splitMessage('aaa\nbbb\nccc', 7), ['aaa\nbbb', 'ccc']);
});

test('splitMessage: preserves all content across chunks', () => {
  const ui = makeUI();
  const lines = Array.from({ length: 200 }, (_, i) => `Line number ${i} of narration prose.`);
  const text = lines.join('\n');

  const chunks = ui.splitMessage(text, DISCORD_LIMIT);

  assert.ok(chunks.length > 1, 'long text should be split');
  // Every split here is on a newline, so joining with '\n' rebuilds the text.
  // A mid-line split must not do that: it would insert a newline.
  assert.strictEqual(chunks.join('\n'), text);
  assert.ok(canAlign(text, chunks));
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

function canAlign(text, chunks) {
  const memo = new Map();

  function walk(index, chunkIndex) {
    const key = `${index}:${chunkIndex}`;
    if (memo.has(key)) return memo.get(key);

    let ok = false;
    if (chunkIndex === chunks.length) {
      ok = index === text.length;
    } else {
      const chunk = chunks[chunkIndex];
      if (chunk.length > 0) {
        if (text.startsWith(chunk, index) && walk(index + chunk.length, chunkIndex + 1)) {
          ok = true;
        } else if (
          text[index] === '\n'
          && text.startsWith(chunk, index + 1)
          && walk(index + chunk.length + 1, chunkIndex + 1)
        ) {
          ok = true;
        }
      }
    }

    memo.set(key, ok);
    return ok;
  }

  return walk(0, 0);
}

function assertWithinLimit(chunks, maxLength) {
  for (const chunk of chunks) {
    assert.ok(
      chunk.length >= 1 && chunk.length <= maxLength,
      `chunk length ${chunk.length} is outside 1..${maxLength}`
    );
  }
}

test('splitMessage: returns a single empty chunk for empty input', () => {
  assert.deepStrictEqual(makeUI().splitMessage(''), ['']);
});

test('splitMessage: breaks a single line of 3000 characters', () => {
  const ui = makeUI();
  const text = 'a'.repeat(3000);
  const chunks = ui.splitMessage(text, DISCORD_LIMIT);

  assert.deepStrictEqual(chunks, ['a'.repeat(DISCORD_LIMIT), 'a'.repeat(1000)]);
  assertWithinLimit(chunks, DISCORD_LIMIT);
  assert.strictEqual(chunks.join(''), text);
  assert.notStrictEqual(chunks.join('\n'), text);
});

test('splitMessage: an oversized first line followed by more lines has no empty chunk', () => {
  const ui = makeUI();
  const text = `${'a'.repeat(3000)}\nsecond line\nthird line`;
  const chunks = ui.splitMessage(text, DISCORD_LIMIT);

  assert.deepStrictEqual(chunks, [
    'a'.repeat(DISCORD_LIMIT),
    `${'a'.repeat(1000)}\nsecond line\nthird line`,
  ]);
  assert.ok(!chunks.includes(''));
  assertWithinLimit(chunks, DISCORD_LIMIT);
  assert.ok(canAlign(text, chunks));
});

test('splitMessage: breaks a line that is one character over the limit', () => {
  const ui = makeUI();
  const text = 'b'.repeat(DISCORD_LIMIT + 1);
  const chunks = ui.splitMessage(text);

  assert.deepStrictEqual(chunks, ['b'.repeat(DISCORD_LIMIT), 'b']);
  assert.strictEqual(chunks.join(''), text);
});

test('splitMessage: breaks a long line at the last space inside the window', () => {
  const ui = makeUI();
  const text = `${'a'.repeat(1980)} ${'b'.repeat(30)}`;
  const chunks = ui.splitMessage(text, DISCORD_LIMIT);

  assert.deepStrictEqual(chunks, [`${'a'.repeat(1980)} `, 'b'.repeat(30)]);
  assert.strictEqual(chunks.join(''), text);
  assertWithinLimit(chunks, DISCORD_LIMIT);
});

test('splitMessage: prefers a space over a hard cut', () => {
  const ui = makeUI();
  const chunks = ui.splitMessage('hello world', 8);

  assert.deepStrictEqual(chunks, ['hello ', 'world']);
  assert.strictEqual(chunks.join(''), 'hello world');
});

test('splitMessage: hard-cuts a long line when the window has no space', () => {
  const ui = makeUI();
  const text = `${'a'.repeat(12)} b`;
  const chunks = ui.splitMessage(text, 10);

  assert.deepStrictEqual(chunks, ['a'.repeat(10), 'aa b']);
  assert.strictEqual(chunks.join(''), text);
});

test('splitMessage: a full line followed by more text does not start with an empty chunk', () => {
  const ui = makeUI();
  const text = `${'a'.repeat(DISCORD_LIMIT)}\nnext`;
  const chunks = ui.splitMessage(text);

  assert.deepStrictEqual(chunks, ['a'.repeat(DISCORD_LIMIT), 'next']);
  assert.ok(!chunks.includes(''));
  assert.strictEqual(chunks.join('\n'), text);
});

test('splitMessage: breaks an oversized line that follows a short one', () => {
  const ui = makeUI();
  const text = `hi\n${'a'.repeat(12)}`;
  const chunks = ui.splitMessage(text, 10);

  assert.deepStrictEqual(chunks, ['hi', 'a'.repeat(10), 'aa']);
  assert.ok(canAlign(text, chunks));
  assertWithinLimit(chunks, 10);
});

test('splitMessage: keeps a leading newline when the text must be split', () => {
  const ui = makeUI();
  const text = `\n${'a'.repeat(10)}\n${'b'.repeat(10)}`;
  const chunks = ui.splitMessage(text, 10);

  assert.deepStrictEqual(chunks, ['\n', 'a'.repeat(10), 'b'.repeat(10)]);
  assert.ok(canAlign(text, chunks));
  assertWithinLimit(chunks, 10);
});
