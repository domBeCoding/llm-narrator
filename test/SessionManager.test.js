const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SessionManager = require('../src/SessionManager');

const TEMPLATE = {
  session: {
    session_id: null,
    user_id: null,
    story_id: 'the-herbalists-choice',
    status: 'active',
    turn_count: 0,
    started_at: null,
    last_action_at: null,
    last_llm_output: null,
    ending_variant: null,
  },
  reader: { location: 'apothecary' },
  characters: {},
  story: { current_act: 1, flags: {} },
  world: { locations: {} },
  choice_history: [],
};

const storyManagerStub = {
  getStory: (id) => (id === 'the-herbalists-choice' ? { id, title: 'The Herbalist\'s Choice' } : undefined),
};

/** Creates an isolated sessions dir seeded with the template. */
async function makeManager(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-sessions-'));
  await fs.writeFile(
    path.join(dir, 'session-template.json'),
    JSON.stringify(TEMPLATE, null, 2),
    'utf8'
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, manager: new SessionManager(dir, storyManagerStub) };
}

async function writeSession(dir, userId, n, overrides = {}) {
  const session = JSON.parse(JSON.stringify(TEMPLATE));
  session.session.session_id = `session-${userId}-${n}`;
  session.session.user_id = userId;
  session.session.started_at = new Date(2024, 0, n).toISOString();
  Object.assign(session.session, overrides);
  await fs.writeFile(
    path.join(dir, `session-${userId}-${n}.json`),
    JSON.stringify(session, null, 2),
    'utf8'
  );
  return session;
}

// --- getNextSessionNumber ----------------------------------------------------

test('getNextSessionNumber: starts at 1 when the user has no sessions', async (t) => {
  const { manager } = await makeManager(t);
  assert.strictEqual(await manager.getNextSessionNumber('42'), 1);
});

test('getNextSessionNumber: returns one past the highest existing number', async (t) => {
  const { dir, manager } = await makeManager(t);
  await writeSession(dir, '42', 1);
  await writeSession(dir, '42', 2);
  await writeSession(dir, '42', 7);

  assert.strictEqual(await manager.getNextSessionNumber('42'), 8);
});

test('getNextSessionNumber: ignores other users\' sessions', async (t) => {
  const { dir, manager } = await makeManager(t);
  await writeSession(dir, '99', 5);

  assert.strictEqual(await manager.getNextSessionNumber('42'), 1);
});

test('getNextSessionNumber: does not confuse a user id that prefixes another', async (t) => {
  const { dir, manager } = await makeManager(t);
  await writeSession(dir, '123', 4);

  // '12' must not match 'session-123-4.json'
  assert.strictEqual(await manager.getNextSessionNumber('12'), 1);
});

// --- getUserSessions ---------------------------------------------------------

test('getUserSessions: returns an empty list for an unknown user', async (t) => {
  const { manager } = await makeManager(t);
  assert.deepStrictEqual(await manager.getUserSessions('42'), []);
});

test('getUserSessions: returns summaries sorted newest first', async (t) => {
  const { dir, manager } = await makeManager(t);
  await writeSession(dir, '42', 1, { turn_count: 5, status: 'completed' });
  await writeSession(dir, '42', 2, { turn_count: 2 });

  const sessions = await manager.getUserSessions('42');

  assert.strictEqual(sessions.length, 2);
  assert.deepStrictEqual(sessions.map(s => s.sessionNumber), [2, 1]);
  assert.strictEqual(sessions[0].storyId, 'the-herbalists-choice');
  assert.strictEqual(sessions[1].status, 'completed');
  assert.strictEqual(sessions[1].turnCount, 5);
});

test('getUserSessions: skips unreadable session files instead of throwing', async (t) => {
  const { dir, manager } = await makeManager(t);
  await writeSession(dir, '42', 1);
  await fs.writeFile(path.join(dir, 'session-42-2.json'), '{ this is not json', 'utf8');

  const sessions = await manager.getUserSessions('42');

  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].sessionNumber, 1);
});

test('getUserSessions: ignores the template file', async (t) => {
  const { manager } = await makeManager(t);
  assert.deepStrictEqual(await manager.getUserSessions('template'), []);
});

// --- getActiveSession / getSessionByNumber -----------------------------------

test('getActiveSession: returns null when the user has no sessions', async (t) => {
  const { manager } = await makeManager(t);
  assert.strictEqual(await manager.getActiveSession('42'), null);
});

test('getActiveSession: returns the highest-numbered session', async (t) => {
  const { dir, manager } = await makeManager(t);
  await writeSession(dir, '42', 1);
  await writeSession(dir, '42', 2);

  const session = await manager.getActiveSession('42');

  assert.strictEqual(session.session.session_id, 'session-42-2');
});

test('getSessionByNumber: loads the requested session', async (t) => {
  const { dir, manager } = await makeManager(t);
  await writeSession(dir, '42', 3, { turn_count: 9 });

  const session = await manager.getSessionByNumber('42', 3);

  assert.strictEqual(session.session.turn_count, 9);
});

test('getSessionByNumber: returns null for a missing session', async (t) => {
  const { manager } = await makeManager(t);
  assert.strictEqual(await manager.getSessionByNumber('42', 99), null);
});

// --- createSession -----------------------------------------------------------

test('createSession: seeds a session from the template with identity fields set', async (t) => {
  const { manager } = await makeManager(t);

  const { session, sessionNumber } = await manager.createSession('42', 'dom', 'the-herbalists-choice');

  assert.strictEqual(sessionNumber, 1);
  assert.strictEqual(session.session.session_id, 'session-42-1');
  assert.strictEqual(session.session.user_id, '42');
  assert.strictEqual(session.session.story_id, 'the-herbalists-choice');
  assert.strictEqual(session.session.status, 'active');
  assert.strictEqual(session.session.turn_count, 0);
  assert.ok(session.session.started_at);
  assert.ok(session.session.last_action_at);
});

test('createSession: persists the new session to disk', async (t) => {
  const { dir, manager } = await makeManager(t);

  await manager.createSession('42', 'dom', 'the-herbalists-choice');

  const raw = await fs.readFile(path.join(dir, 'session-42-1.json'), 'utf8');
  assert.strictEqual(JSON.parse(raw).session.session_id, 'session-42-1');
});

test('createSession: allocates increasing numbers for repeat plays', async (t) => {
  const { manager } = await makeManager(t);

  const first = await manager.createSession('42', 'dom', 'the-herbalists-choice');
  const second = await manager.createSession('42', 'dom', 'the-herbalists-choice');

  assert.strictEqual(first.sessionNumber, 1);
  assert.strictEqual(second.sessionNumber, 2);
});

test('createSession: rejects an unknown story id', async (t) => {
  const { manager } = await makeManager(t);

  await assert.rejects(
    () => manager.createSession('42', 'dom', 'no-such-story'),
    /Story not found: no-such-story/
  );
});

test('createSession: does not mutate the template on disk', async (t) => {
  const { dir, manager } = await makeManager(t);

  await manager.createSession('42', 'dom', 'the-herbalists-choice');

  const raw = await fs.readFile(path.join(dir, 'session-template.json'), 'utf8');
  assert.strictEqual(JSON.parse(raw).session.session_id, null);
});

// --- saveSession / deleteSession ---------------------------------------------

test('saveSession: round-trips state through disk', async (t) => {
  const { manager } = await makeManager(t);
  const { session } = await manager.createSession('42', 'dom', 'the-herbalists-choice');

  session.session.turn_count = 12;
  session.session.last_llm_output = 'A long stretch of prose.';
  await manager.saveSession('42', 1, session);

  const reloaded = await manager.getSessionByNumber('42', 1);
  assert.strictEqual(reloaded.session.turn_count, 12);
  assert.strictEqual(reloaded.session.last_llm_output, 'A long stretch of prose.');
});

test('saveSession: writes human-readable indented JSON', async (t) => {
  const { dir, manager } = await makeManager(t);
  const { session } = await manager.createSession('42', 'dom', 'the-herbalists-choice');
  await manager.saveSession('42', 1, session);

  const raw = await fs.readFile(path.join(dir, 'session-42-1.json'), 'utf8');
  assert.match(raw, /\n {2}"session": \{/);
});

test('deleteSession: removes the session file', async (t) => {
  const { manager } = await makeManager(t);
  await manager.createSession('42', 'dom', 'the-herbalists-choice');

  await manager.deleteSession('42', 1);

  assert.strictEqual(await manager.getSessionByNumber('42', 1), null);
});

test('deleteSession: is a no-op for a missing file', async (t) => {
  const { manager } = await makeManager(t);
  await assert.doesNotReject(() => manager.deleteSession('42', 99));
});

// --- Known defects -----------------------------------------------------------

test('BUG: getActiveSession returns a completed session, hiding an older active one', { todo: true }, async (t) => {
  // handleMessage() uses getActiveSession() and then refuses to play if the
  // status is 'completed'. Because "active" really means "highest numbered",
  // a finished session permanently blocks an earlier unfinished one.
  const { dir, manager } = await makeManager(t);
  await writeSession(dir, '42', 1, { status: 'active' });
  await writeSession(dir, '42', 2, { status: 'completed' });

  const session = await manager.getActiveSession('42');

  assert.strictEqual(session.session.status, 'active');
});

test('BUG: createSession ignores the username it is given', { todo: true }, async (t) => {
  // `username` is accepted but never stored, so the narrator cannot address the
  // reader by name and the template's hardcoded "Wren" is always used.
  const { manager } = await makeManager(t);

  const { session } = await manager.createSession('42', 'dom', 'the-herbalists-choice');

  assert.strictEqual(session.session.reader_name, 'dom');
});
