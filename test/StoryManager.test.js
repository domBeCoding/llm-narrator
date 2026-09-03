const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const StoryManager = require('../src/StoryManager');

async function makeDirs(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-stories-'));
  const storiesDir = path.join(root, 'stories');
  const promptsDir = path.join(root, 'prompts');
  await fs.mkdir(storiesDir);
  await fs.mkdir(promptsDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { storiesDir, promptsDir };
}

async function writePromptFiles(promptsDir) {
  await fs.writeFile(path.join(promptsDir, 'system-prompt.md'), 'THE PROMPT', 'utf8');
  await fs.writeFile(path.join(promptsDir, 'concluding-directive.md'), 'ENDING DIRECTIVE {variants}', 'utf8');
}

async function writeStory(storiesDir, id, config = {}, content = '# Story') {
  await fs.writeFile(
    path.join(storiesDir, `${id}-config.json`),
    JSON.stringify({
      story_id: id,
      title: 'A Title',
      description: 'A description',
      genre: 'Fantasy',
      tone: 'warm',
      estimated_play_time: '10 minutes',
      ...config,
    }),
    'utf8'
  );
  await fs.writeFile(path.join(storiesDir, `${id}.md`), content, 'utf8');
}

test('loadStoryData: loads the system prompt', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);
  await writePromptFiles(promptsDir);

  const manager = new StoryManager(storiesDir, promptsDir);
  await manager.loadStoryData();

  assert.strictEqual(manager.getSystemPrompt(), 'THE PROMPT');
});

test('loadStoryData: loads the concluding directive', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);
  await writePromptFiles(promptsDir);

  const manager = new StoryManager(storiesDir, promptsDir);
  await manager.loadStoryData();

  assert.strictEqual(manager.getConcludingDirective(), 'ENDING DIRECTIVE {variants}');
});

test('loadStoryData: registers each story with its config and markdown content', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);
  await writePromptFiles(promptsDir);
  await writeStory(storiesDir, 'my-story', { title: 'My Story' }, '# My Story\n\nBody text.');

  const manager = new StoryManager(storiesDir, promptsDir);
  await manager.loadStoryData();

  const story = manager.getStory('my-story');
  assert.strictEqual(story.id, 'my-story');
  assert.strictEqual(story.title, 'My Story');
  assert.strictEqual(story.description, 'A description');
  assert.strictEqual(story.genre, 'Fantasy');
  assert.strictEqual(story.estimatedPlayTime, '10 minutes');
  assert.match(story.content, /Body text\./);
  assert.strictEqual(story.config.story_id, 'my-story');
});

test('loadStoryData: loads multiple stories', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);
  await writePromptFiles(promptsDir);
  await writeStory(storiesDir, 'story-a');
  await writeStory(storiesDir, 'story-b');

  const manager = new StoryManager(storiesDir, promptsDir);
  await manager.loadStoryData();

  assert.strictEqual(manager.getAllStories().size, 2);
  assert.ok(manager.getStory('story-a'));
  assert.ok(manager.getStory('story-b'));
});

test('loadStoryData: exposes a story-specific opening action when declared', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);
  await writePromptFiles(promptsDir);
  await writeStory(storiesDir, 'my-story', { opening_action: 'You awaken on a cold shore.' });

  const manager = new StoryManager(storiesDir, promptsDir);
  await manager.loadStoryData();

  assert.strictEqual(manager.getStory('my-story').openingAction, 'You awaken on a cold shore.');
});

test('loadStoryData: openingAction is null when a story declares none', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);
  await writePromptFiles(promptsDir);
  await writeStory(storiesDir, 'my-story');

  const manager = new StoryManager(storiesDir, promptsDir);
  await manager.loadStoryData();

  assert.strictEqual(manager.getStory('my-story').openingAction, null);
});

test('the Herbalist opening action belongs to that story alone', async (t) => {
  const root = path.join(__dirname, '..');
  const manager = new StoryManager(path.join(root, 'stories'), path.join(root, 'prompts'));
  await manager.loadStoryData();

  const herbalist = manager.getStory('the-herbalists-choice');
  assert.match(herbalist.openingAction, /Master Elara/);

  // No other installed story may carry Herbalist-specific setup text.
  for (const [id, story] of manager.getAllStories()) {
    if (id === 'the-herbalists-choice') continue;
    assert.doesNotMatch(
      story.openingAction || '',
      /Elara|apothecary/i,
      `story "${id}" must not reuse the Herbalist opening`
    );
  }
});

test('getStory: returns undefined for an unknown id', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);
  await writePromptFiles(promptsDir);

  const manager = new StoryManager(storiesDir, promptsDir);
  await manager.loadStoryData();

  assert.strictEqual(manager.getStory('nope'), undefined);
});

test('loadStoryData: throws when the system prompt is missing', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);

  const manager = new StoryManager(storiesDir, promptsDir);

  await assert.rejects(() => manager.loadStoryData(), /ENOENT/);
});

test('loadStoryData: throws when a config has no matching markdown file', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);
  await writePromptFiles(promptsDir);
  await fs.writeFile(
    path.join(storiesDir, 'orphan-config.json'),
    JSON.stringify({ title: 'Orphan' }),
    'utf8'
  );

  const manager = new StoryManager(storiesDir, promptsDir);

  await assert.rejects(() => manager.loadStoryData(), /ENOENT/);
});

test('loadStoryData: ignores non-config json files in the stories directory', async (t) => {
  const { storiesDir, promptsDir } = await makeDirs(t);
  await writePromptFiles(promptsDir);
  await writeStory(storiesDir, 'real-story');
  await fs.writeFile(path.join(storiesDir, 'notes.json'), '{"scratch": true}', 'utf8');

  const manager = new StoryManager(storiesDir, promptsDir);
  await manager.loadStoryData();

  assert.strictEqual(manager.getAllStories().size, 1);
});

test('the shipped story loads and matches its config', async () => {
  const root = path.join(__dirname, '..');
  const manager = new StoryManager(path.join(root, 'stories'), path.join(root, 'prompts'));
  await manager.loadStoryData();

  const story = manager.getStory('the-herbalists-choice');
  assert.ok(story, 'the-herbalists-choice should be registered');
  assert.strictEqual(story.title, 'The Herbalist\'s Choice');
  assert.ok(story.content.length > 0);
  assert.ok(manager.getSystemPrompt().length > 0);
});

test('the shipped story config is internally consistent', async () => {
  const root = path.join(__dirname, '..');
  const manager = new StoryManager(path.join(root, 'stories'), path.join(root, 'prompts'));
  await manager.loadStoryData();

  const { config } = manager.getStory('the-herbalists-choice');

  // Every flag referenced by an end condition must exist in the flag registry.
  for (const cond of config.end_conditions.all_required) {
    if (cond.flag) {
      assert.ok(cond.flag in config.flags, `end condition flag "${cond.flag}" is not declared`);
    }
    if (cond.character) {
      assert.ok(
        config.characters.includes(cond.character),
        `end condition character "${cond.character}" is not declared`
      );
    }
  }

  // Every flag referenced by an ending variant must exist too.
  for (const variant of config.ending_variants) {
    for (const cond of variant.conditions) {
      if (cond.flag) {
        assert.ok(cond.flag in config.flags, `variant "${variant.id}" uses undeclared flag "${cond.flag}"`);
      }
    }
  }

  // Every beat named in a path must appear somewhere in the act structure.
  const allBeats = Object.values(config.plot_beats).flat();
  for (const [pathName, pathDef] of Object.entries(config.paths)) {
    for (const beat of pathDef.beats) {
      assert.ok(allBeats.includes(beat), `path "${pathName}" references unknown beat "${beat}"`);
    }
  }
});

test('the shipped session template declares every flag in the story config', async () => {
  const root = path.join(__dirname, '..');
  const manager = new StoryManager(path.join(root, 'stories'), path.join(root, 'prompts'));
  await manager.loadStoryData();

  const { config } = manager.getStory('the-herbalists-choice');
  const template = JSON.parse(
    await fs.readFile(path.join(root, 'sessions', 'session-template.json'), 'utf8')
  );

  for (const flag of Object.keys(config.flags)) {
    assert.ok(flag in template.story.flags, `template is missing flag "${flag}"`);
  }
  for (const location of config.locations) {
    assert.ok(location in template.world.locations, `template is missing location "${location}"`);
  }
  for (const character of config.characters) {
    assert.ok(character in template.characters, `template is missing character "${character}"`);
  }
});
