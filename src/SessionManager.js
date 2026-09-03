const fs = require('fs').promises;
const path = require('path');

class SessionManager {
  constructor(sessionsDir, storyManager) {
    this.sessionsDir = sessionsDir;
    this.storyManager = storyManager;
  }

  async getNextSessionNumber(userId) {
    const files = await fs.readdir(this.sessionsDir);
    const userSessions = files.filter(f => f.startsWith(`session-${userId}-`) && f.endsWith('.json'));

    if (userSessions.length === 0) return 1;

    const numbers = userSessions.map(f => {
      const match = f.match(new RegExp(`session-${userId}-(\\d+)\\.json`));
      return match ? parseInt(match[1]) : 0;
    });

    return Math.max(...numbers) + 1;
  }

  async getUserSessions(userId) {
    const files = await fs.readdir(this.sessionsDir);
    const userSessions = files.filter(f => f.startsWith(`session-${userId}-`) && f.endsWith('.json'));

    const sessions = [];
    for (const file of userSessions) {
      try {
        const data = await fs.readFile(path.join(this.sessionsDir, file), 'utf8');
        const session = JSON.parse(data);
        const match = file.match(new RegExp(`session-${userId}-(\\d+)\\.json`));
        sessions.push({
          file: file,
          sessionNumber: match ? parseInt(match[1]) : 0,
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

  async getActiveSession(userId) {
    const sessions = await this.getUserSessions(userId);
    if (sessions.length === 0) return null;

    const latest = sessions[0];
    const data = await fs.readFile(path.join(this.sessionsDir, latest.file), 'utf8');
    return JSON.parse(data);
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

    return { session, sessionNumber };
  }

  async saveSession(userId, sessionNumber, session) {
    const sessionFile = path.join(this.sessionsDir, `session-${userId}-${sessionNumber}.json`);
    await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf8');
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
