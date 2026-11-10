const fs = require('fs/promises');
const path = require('path');

// ./sessions beside index.js. index.js passes the same path explicitly.
const DEFAULT_SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// SESSIONS_DIR when it is set, otherwise the default (./sessions).
function resolveSessionsDir(env = process.env, defaultDir = DEFAULT_SESSIONS_DIR) {
  const configured = env && env.SESSIONS_DIR;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return defaultDir;
}

// Creates the sessions folder, including any missing parents.
async function ensureSessionsDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

module.exports = {
  resolveSessionsDir,
  ensureSessionsDir,
  DEFAULT_SESSIONS_DIR,
};
