const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const NarrationService = require('../src/NarrationService');
const StoryManager = require('../src/StoryManager');
const { validateStateUpdate } = require('../src/StateValidator');

const ROOT = path.join(__dirname, '..');
const prompt = fs.readFileSync(path.join(ROOT, 'prompts/system-prompt.md'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'stories/the-herbalists-choice-config.json'), 'utf8'));
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions/session-template.json'), 'utf8'));

function promptExample() {
  const section = prompt.slice(prompt.indexOf('**The state update block: exact format**'));
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'system prompt has a json example block in the exact format section');
  return match[1];
}

function svc() {
  return new NarrationService({ getStory: () => ({ config }) }, 'key');
}

test('system prompt: example block is valid JSON at the top level, not wrapped', () => {
  const example = JSON.parse(promptExample());
  assert.ok(!('state_update' in example));
  assert.ok('choice_history' in example);
  assert.ok(!('choice_log' in example));
});

test('system prompt: example block passes validation with no rejections', () => {
  const session = JSON.parse(JSON.stringify(template));
  const { update, rejected } = validateStateUpdate(session, JSON.parse(promptExample()), config);

  assert.deepStrictEqual(rejected, []);
  assert.ok(update.characters && update.story && update.reader && update.world && update.choice_history);
});

test('system prompt: example block is found by parseResponse in a full reply', () => {
  const reply = [
    'You kneel by the cot. Elara is burning up.',
    '',
    '========',
    '',
    'Her breathing is shallow. What do you do?',
    '',
    '1. Search the shelves',
    '2. Run for help',
    'Or you can suggest your own action.',
    '',
    '```json',
    promptExample(),
    '```',
  ].join('\n');

  const { narration, stateUpdate } = svc().parseResponse(reply);
  assert.deepStrictEqual(stateUpdate, JSON.parse(promptExample()));
  assert.doesNotMatch(narration, /```/);
  assert.match(narration, /Or you can suggest your own action\.$/);
});

test('system prompt: asks for choice_history, never choice_log, and names the fixed values', () => {
  assert.match(prompt, /`choice_history`/);
  assert.doesNotMatch(prompt, /choice_log/);
  assert.match(prompt, /state_rules/);
  assert.match(prompt, /must be exactly `"recovering"`/);
});

test('parseResponse: tolerates Windows line endings and spaces after the fence', () => {
  const reply = 'Prose.\r\n\r\n```json  \r\n{"story": {"flags": {"forest_entered": true}}}\r\n```';
  const { narration, stateUpdate } = svc().parseResponse(reply);

  assert.deepStrictEqual(stateUpdate, { story: { flags: { forest_entered: true } } });
  assert.strictEqual(narration, 'Prose.');
});

test('parseResponse plus applyStateUpdates: the wrapped shape from the old design doc is still saved', () => {
  const session = JSON.parse(JSON.stringify(template));
  const reply = 'Prose.\n\n```json\n{"state_update": {"story": {"flags": {"reader_checked_elara": true}}, "choice_log": {"action": "check on Elara", "consequence": "found her feverish"}}}\n```';
  const service = svc();
  const { narration, stateUpdate } = service.parseResponse(reply);
  service.applyStateUpdates(session, stateUpdate, narration, 'I check on Elara');

  assert.strictEqual(session.story.flags.reader_checked_elara, true);
  assert.deepStrictEqual(session.choice_history, [
    { turn: 1, action: 'check on Elara', consequence: 'found her feverish' },
  ]);
});

test('system prompt: on the Halden path Elara must not recover before the reunion', () => {
  const line = prompt.split('\n').find(l => l.startsWith("**The Herbalist's Choice, Halden path:**"));
  assert.ok(line, 'system prompt has the Halden path line');
  assert.match(line, /do not set Elara's `health` to `"recovering"` until the reunion/);
  assert.match(line, /halden_elara_reunion/);
  assert.match(line, /halden_reconciled: true/);
  assert.match(line, /set `halden_agreed_to_help` true in the same reply/);
  assert.match(line, /if she turns the reader away, leave it false/);
});

// Phase conditions are not evaluated by the code; the whole config is sent to
// the AI as its mechanical rules. So the note on Elara's final phase is how the
// config stops pushing recovery on the Halden path before the reunion.
test('story config: Elara\'s final phase waits for the reunion on the Halden path, and the AI sees it', () => {
  const finalPhase = config.character_state_progression.elara.phases.find(p => p.name === 'final_encounter');
  assert.strictEqual(finalPhase.state.health, 'recovering');
  assert.match(finalPhase.note, /Halden path/);
  assert.match(finalPhase.note, /halden_elara_reunion/);
  assert.match(finalPhase.note, /halden_reconciled true/);

  const service = new NarrationService({
    getStory: () => ({ content: 'CONTENT', config }),
    getSystemPrompt: () => prompt,
  }, 'key');
  const session = JSON.parse(JSON.stringify(template));
  const { systemContext } = service.buildPrompt(session, 'I look around');
  assert.ok(systemContext.includes(JSON.stringify(finalPhase.note)), 'the note is in the config sent to the AI');
});

test('buildPrompt: uses session.story.current_act when building systemContext', async (t) => {
  t.mock.method(console, 'log', () => {});
  const manager = new StoryManager(path.join(ROOT, 'stories'), path.join(ROOT, 'prompts'));
  await manager.loadStoryData();
  const seen = [];
  if (typeof manager.getStoryContentForAct === 'function') {
    const selectAct = manager.getStoryContentForAct.bind(manager);
    manager.getStoryContentForAct = (storyId, actNumber) => {
      seen.push({ storyId, actNumber });
      return selectAct(storyId, actNumber);
    };
  }
  const service = new NarrationService(manager, 'key');
  const session = JSON.parse(JSON.stringify(template));

  session.story.current_act = 1;
  const act1 = service.buildPrompt(session, 'I look around').systemContext;
  assert.match(act1, /Scene 1: Morning in the Apothecary/);
  assert.doesNotMatch(act1, /Scene 2: The Crossroads/);
  assert.doesNotMatch(act1, /Scene 3: The Moonpetal/);
  assert.doesNotMatch(act1, /## Author Notes/);

  session.story.current_act = 3;
  const act3 = service.buildPrompt(session, 'I look around').systemContext;
  assert.match(act3, /Scene 3: The Moonpetal/);
  assert.match(act3, /# The Herbalist's Choice/);
  assert.doesNotMatch(act3, /## State Tracking Reference/);
  assert.doesNotMatch(act3, /## Author Notes/);

  assert.deepStrictEqual(seen, [
    { storyId: 'the-herbalists-choice', actNumber: 1 },
    { storyId: 'the-herbalists-choice', actNumber: 3 },
  ]);
});
