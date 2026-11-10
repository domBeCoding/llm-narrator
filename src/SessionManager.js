const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

/** session-<userId>-<n>.json, and not a temp or any other stray file. */
function sessionFilePattern(userId) {
  const escaped = String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^session-${escaped}-(\\d+)\\.json$`);
}

class SessionManager {
  constructor(sessionsDir, storyManager) {
    this.sessionsDir = sessionsDir;
    this.storyManager = storyManager;
    // userId -> tail of that user's queue of turns (see withUserLock).
    this.userQueues = new Map();
    // The user ids whose lock the current async call chain already holds.
    this.heldLocks = new AsyncLocalStorage();
  }

  /**
   * Runs fn after every earlier call for the same user has finished, so one
   * reader's turns (load, AI call, save) happen one at a time and a later
   * turn always starts from the state the earlier one saved. In-process only:
   * it does not hold across several bot processes.
   *
   * Nesting is safe: a call made from inside fn for the same user runs
   * straight away instead of queueing behind the call it is part of, which
   * would wait for itself forever. The catch: work that fn starts without
   * awaiting, and that runs on after fn has finished, still counts as inside
   * the lock, so always await nested calls.
   */
  withUserLock(userId, fn) {
    const held = this.heldLocks.getStore();
    if (held && held.has(userId)) {
      return Promise.resolve().then(() => fn());
    }

    const previous = this.userQueues.get(userId) || Promise.resolve();
    const run = previous.then(() => this.heldLocks.run(new Set(held || []).add(userId), fn));
    const tail = run.catch(() => {});
    this.userQueues.set(userId, tail);
    tail.then(() => {
      if (this.userQueues.get(userId) === tail) this.userQueues.delete(userId);
    });
    return run;
  }

  activePointerFile(userId) {
    return path.join(this.sessionsDir, `active-${userId}.json`);
  }

  /**
   * Remembers which session the user chose, so later messages go to it. The
   * record is written to a temporary file in the same folder and then renamed
   * over the old one, so a reader never sees a half-written record.
   */
  async setActiveSession(userId, sessionNumber) {
    const target = this.activePointerFile(userId);
    // Ends in .json so it matches the same git-ignore rule as the record.
    const temp = path.join(this.sessionsDir, `active-${userId}.tmp-${process.pid}-${crypto.randomUUID()}.json`);
    try {
      await fs.writeFile(temp, JSON.stringify({ sessionNumber }), 'utf8');
      await fs.rename(temp, target);
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    }
  }

  async getNextSessionNumber(userId) {
    const files = await fs.readdir(this.sessionsDir);
    const pattern = sessionFilePattern(userId);
    const numbers = [];
    for (const file of files) {
      const match = file.match(pattern);
      if (match) numbers.push(parseInt(match[1], 10));
    }

    if (numbers.length === 0) return 1;
    return Math.max(...numbers) + 1;
  }

  async getUserSessions(userId) {
    const files = await fs.readdir(this.sessionsDir);
    const pattern = sessionFilePattern(userId);

    const sessions = [];
    for (const file of files) {
      const match = file.match(pattern);
      if (!match) continue;
      try {
        const data = await fs.readFile(path.join(this.sessionsDir, file), 'utf8');
        const session = JSON.parse(data);
        sessions.push({
          file: file,
          sessionNumber: parseInt(match[1], 10),
          storyId: session.session.story_id,
          startedAt: session.session.started_at,
          status: session.session.status,
          turnCount: session.session.turn_count
        });
      } catch (e) {
        console.error(`Failed to load session file ${file}:`, e);
      }
    }

    return sessions.sort((a, b) => b.sessionNumber - a.sessionNumber);
  }

  /**
   * The number of the session the user's messages go to: the one they chose,
   * when that choice names a session that exists, even if it is completed.
   * With no valid choice, the newest session whose status is not completed
   * (active or concluding). If every session is completed, the newest.
   * Null if they have no sessions.
   */
  async getActiveSessionNumber(userId) {
    try {
      const { sessionNumber } = JSON.parse(await fs.readFile(this.activePointerFile(userId), 'utf8'));
      // Only a positive whole number names a session; anything else (a
      // string, a fraction, a path) is ignored rather than used in a file name.
      if (Number.isInteger(sessionNumber) && sessionNumber > 0
        && await this.getSessionByNumber(userId, sessionNumber)) {
        return sessionNumber;
      }
    } catch (e) {
      // No choice recorded, or it is unreadable: fall back below.
    }

    const sessions = await this.getUserSessions(userId);
    if (sessions.length === 0) return null;
    // getUserSessions is already newest-first and includes status, so the
    // fallback does not open the session files again.
    const unfinished = sessions.find(session => session.status !== 'completed');
    return (unfinished || sessions[0]).sessionNumber;
  }

  async getActiveSession(userId) {
    const sessionNumber = await this.getActiveSessionNumber(userId);
    return sessionNumber === null ? null : this.getSessionByNumber(userId, sessionNumber);
  }

  async getSessionByNumber(userId, sessionNumber) {
    const sessionFile = path.join(this.sessionsDir, `session-${userId}-${sessionNumber}.json`);
    try {
      const data = await fs.readFile(sessionFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  }

  async createSession(userId, username, storyId) {
    const story = this.storyManager.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const sessionNumber = await this.getNextSessionNumber(userId);

    const templateData = await fs.readFile(path.join(this.sessionsDir, 'session-template.json'), 'utf8');
    const session = JSON.parse(templateData);

    session.session.session_id = `session-${userId}-${sessionNumber}`;
    session.session.user_id = userId;
    session.session.story_id = storyId;
    session.session.started_at = new Date().toISOString();
    session.session.last_action_at = new Date().toISOString();

    await this.saveSession(userId, sessionNumber, session);
    await this.setActiveSession(userId, sessionNumber);

    return { session, sessionNumber };
  }

  /**
   * Writes the session to a temporary file in the same folder and then renames
   * it over the previous save, so a crash cannot leave truncated JSON behind.
   * The temporary name does not end in .json.
   */
  async saveSession(userId, sessionNumber, session) {
    const sessionFile = path.join(this.sessionsDir, `session-${userId}-${sessionNumber}.json`);
    const temp = path.join(
      this.sessionsDir,
      `session-${userId}-${sessionNumber}.json.tmp-${process.pid}-${crypto.randomUUID()}`
    );
    try {
      await fs.writeFile(temp, JSON.stringify(session, null, 2), 'utf8');
      await fs.rename(temp, sessionFile);
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    }
  }

  async deleteSession(userId, sessionNumber) {
    const sessionFile = path.join(this.sessionsDir, `session-${userId}-${sessionNumber}.json`);
    try {
      await fs.unlink(sessionFile);
    } catch (e) {
      // File might not exist, that's fine
    }
  }
}

module.exports = SessionManager;
