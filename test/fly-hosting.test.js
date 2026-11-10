// Env-first secrets and the sessions directory. SSM and Discord are stubbed.
// Dummy values such as 'test-token' are not real keys, and they are never logged.
const { describe, test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SessionManager = require('../src/SessionManager');

const ssm = require('@aws-sdk/client-ssm');
const OriginalSSMClient = ssm.SSMClient;
const constructedClients = [];
const ssmSends = [];

class RecordingSSMClient {
  constructor(config) {
    this.config = config;
    constructedClients.push(this);
  }

  async send(command) {
    const input = command && command.input ? command.input : command;
    ssmSends.push(input);
    return { Parameter: { Value: `ssm-${input && input.Name}` } };
  }
}

ssm.SSMClient = RecordingSSMClient;
process.on('exit', () => {
  ssm.SSMClient = OriginalSSMClient;
});

const secretsPath = require.resolve('../src/SecretsManager');
delete require.cache[secretsPath];
const SecretsManager = require('../src/SecretsManager');
const Bot = require('../src/Bot');

let resolveSessionsDir;
let ensureSessionsDir;
let DEFAULT_SESSIONS_DIR;
try {
  ({ resolveSessionsDir, ensureSessionsDir, DEFAULT_SESSIONS_DIR } = require('../src/sessionsDir'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const SECRET_VALUES = ['test-token', 'test-llm-key', 'test-typesafe-key'];

function saveEnv(t) {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!Object.prototype.hasOwnProperty.call(saved, key)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) {
      process.env[key] = value;
    }
  });
}

function assignEnv(values) {
  const keys = ['DISCORD_TOKEN', 'LLM_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_CREDENTIALS_SECRET', 'SESSIONS_DIR'];
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

function captureConsole(t) {
  const lines = [];
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => {
      lines.push(args.map((part) => String(part)).join(' '));
    });
  }
  return lines;
}

function assertNoSecretValues(lines) {
  for (const line of lines) {
    for (const secret of SECRET_VALUES) {
      assert.ok(!line.includes(secret), 'a log line contains a secret value');
    }
  }
}

function openSecrets() {
  const localSends = [];
  let factoryCalls = 0;
  const clientsBefore = constructedClients.length;
  const recordingBefore = ssmSends.length;
  const manager = new SecretsManager('eu-north-1', {
    createClient(region) {
      factoryCalls += 1;
      assert.strictEqual(region, 'eu-north-1');
      return {
        send: async (command) => {
          localSends.push(command.input);
          return { Parameter: { Value: `ssm-${command.input.Name}` } };
        },
      };
    },
  });
  return {
    manager,
    result() {
      return {
        factoryCalls,
        clientCount: constructedClients.length - clientsBefore,
        sends: localSends.concat(ssmSends.slice(recordingBefore)),
      };
    },
  };
}

async function boot(t, secretsManager) {
  const lines = captureConsole(t);
  t.mock.method(process, 'exit', (code) => {
    throw new Error(`process.exit ${code}`);
  });
  const narrationService = {};
  const bot = new Bot({
    secretsManager,
    llmCredentialsSecret: 'kimi-credentials',
    storyManager: { loadStoryData: async () => {} },
    narrationService,
    sessionManager: {},
    discordUI: {},
  });
  bot.client.login = async (token) => {
    bot.loggedInWith = token;
  };
  await bot.init();
  return { bot, narrationService, lines };
}

describe('Fly hosting secrets and sessions', { concurrency: 1 }, () => {
  test('with DISCORD_TOKEN and LLM_API_KEY set, init uses them and does not construct or call SSM', async (t) => {
    saveEnv(t);
    // TYPESAFE_API_KEY is set as well: that loader already returns before SSM,
    // so a fully configured process must not build a client for any of the three.
    assignEnv({
      DISCORD_TOKEN: 'test-token',
      LLM_API_KEY: 'test-llm-key',
      TYPESAFE_API_KEY: 'test-typesafe-key',
    });

    const secrets = openSecrets();
    const { bot, narrationService, lines } = await boot(t, secrets.manager);
    const seen = secrets.result();

    assert.strictEqual(bot.discordToken, 'test-token');
    assert.strictEqual(bot.loggedInWith, 'test-token');
    assert.strictEqual(narrationService.apiKey, 'test-llm-key');
    assert.strictEqual(bot.typesafeApiKey, 'test-typesafe-key');
    assert.strictEqual(seen.factoryCalls, 0);
    assert.strictEqual(seen.clientCount, 0);
    assert.deepStrictEqual(seen.sends, []);
    assert.ok(lines.some((line) => line === 'Using Discord token and LLM API key from the environment'));
    assert.ok(lines.every((line) => !line.includes('SSM')));
    assertNoSecretValues(lines);
  });

  test('with DISCORD_TOKEN and LLM_API_KEY unset, init loads them from SSM', async (t) => {
    saveEnv(t);
    assignEnv({});

    const secrets = openSecrets();
    const { bot, narrationService, lines } = await boot(t, secrets.manager);
    const seen = secrets.result();

    assert.strictEqual(bot.discordToken, 'ssm-narrator-bot');
    assert.strictEqual(bot.loggedInWith, 'ssm-narrator-bot');
    assert.strictEqual(narrationService.apiKey, 'ssm-kimi-credentials');
    assert.strictEqual(bot.typesafeApiKey, 'ssm-typesafe-api-key');
    assert.deepStrictEqual(seen.sends.map((input) => input.Name), [
      'narrator-bot',
      'kimi-credentials',
      'typesafe-api-key',
    ]);
    assert.ok(seen.sends.every((input) => input.WithDecryption === true));
    assert.ok(seen.factoryCalls + seen.clientCount >= 1);
    assert.ok(lines.some((line) => line === 'Loading secrets from SSM...'));
    assertNoSecretValues(lines);
  });

  test('with only DISCORD_TOKEN set, the env value is used and the LLM key comes from SSM', async (t) => {
    saveEnv(t);
    assignEnv({
      DISCORD_TOKEN: 'test-token',
      TYPESAFE_API_KEY: 'test-typesafe-key',
    });

    const secrets = openSecrets();
    const { bot, narrationService, lines } = await boot(t, secrets.manager);
    const seen = secrets.result();

    assert.strictEqual(bot.discordToken, 'test-token');
    assert.strictEqual(bot.loggedInWith, 'test-token');
    assert.strictEqual(narrationService.apiKey, 'ssm-kimi-credentials');
    assert.strictEqual(bot.typesafeApiKey, 'test-typesafe-key');
    assert.deepStrictEqual(seen.sends.map((input) => input.Name), ['kimi-credentials']);
    assert.ok(seen.factoryCalls + seen.clientCount >= 1);
    assertNoSecretValues(lines);
  });

  test('with only LLM_API_KEY set, the env value is used and the Discord token comes from SSM', async (t) => {
    saveEnv(t);
    assignEnv({
      LLM_API_KEY: 'test-llm-key',
      TYPESAFE_API_KEY: 'test-typesafe-key',
    });

    const secrets = openSecrets();
    const { bot, narrationService, lines } = await boot(t, secrets.manager);
    const seen = secrets.result();

    assert.strictEqual(bot.loggedInWith, 'ssm-narrator-bot');
    assert.strictEqual(bot.discordToken, 'ssm-narrator-bot');
    assert.strictEqual(narrationService.apiKey, 'test-llm-key');
    assert.strictEqual(bot.typesafeApiKey, 'test-typesafe-key');
    assert.deepStrictEqual(seen.sends.map((input) => input.Name), ['narrator-bot']);
    assert.ok(seen.factoryCalls + seen.clientCount >= 1);
    assertNoSecretValues(lines);
  });

  test('with Discord and LLM keys set, an unset TypeSafe key uses SSM only for that key', async (t) => {
    saveEnv(t);
    assignEnv({
      DISCORD_TOKEN: 'test-token',
      LLM_API_KEY: 'test-llm-key',
    });

    const secrets = openSecrets();
    const { bot, narrationService, lines } = await boot(t, secrets.manager);
    const seen = secrets.result();

    assert.strictEqual(bot.discordToken, 'test-token');
    assert.strictEqual(narrationService.apiKey, 'test-llm-key');
    assert.strictEqual(bot.typesafeApiKey, 'ssm-typesafe-api-key');
    assert.deepStrictEqual(seen.sends.map((input) => input.Name), ['typesafe-api-key']);
    assert.strictEqual(seen.factoryCalls, 1);
    assert.strictEqual(seen.clientCount, 0);
    assertNoSecretValues(lines);
  });

  test('SecretsManager does not construct an SSM client until a secret is requested', async (t) => {
    saveEnv(t);
    const before = constructedClients.length;
    const plain = new SecretsManager('eu-north-1');
    assert.strictEqual(constructedClients.length, before);
    assert.ok(plain);

    const secrets = openSecrets();
    assert.strictEqual(secrets.result().factoryCalls, 0);
    assert.strictEqual(secrets.result().clientCount, 0);
    assert.strictEqual(await secrets.manager.getSecret('narrator-bot'), 'ssm-narrator-bot');
    const after = secrets.result();
    assert.strictEqual(after.factoryCalls, 1);
    assert.strictEqual(after.clientCount, 0);
    assert.deepStrictEqual(after.sends.map((input) => input.Name), ['narrator-bot']);
  });

  test('SESSIONS_DIR is honoured and created, including nested paths', async (t) => {
    saveEnv(t);
    assert.ok(resolveSessionsDir && ensureSessionsDir, 'sessions directory helpers should exist');

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-sessions-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const nested = path.join(root, 'data', 'sessions');
    assignEnv({ SESSIONS_DIR: nested });

    assert.strictEqual(resolveSessionsDir(process.env, path.join(root, 'fallback')), nested);
    const created = await ensureSessionsDir(nested);
    assert.strictEqual(created, nested);
    const stat = await fs.stat(nested);
    assert.strictEqual(stat.isDirectory(), true);
    await ensureSessionsDir(nested);
  });

  test('the default sessions directory is ./sessions', (t) => {
    saveEnv(t);
    assert.ok(resolveSessionsDir && DEFAULT_SESSIONS_DIR, 'sessions directory helpers should exist');
    assignEnv({});

    const expected = path.join(__dirname, '..', 'sessions');
    assert.strictEqual(DEFAULT_SESSIONS_DIR, expected);
    assert.strictEqual(resolveSessionsDir(process.env, expected), expected);
    assert.strictEqual(resolveSessionsDir({}), expected);
    assert.strictEqual(path.basename(expected), 'sessions');
  });

  test('index.js starts on load unless NARRA_SKIP_START=1', async (t) => {
    saveEnv(t);
    const source = await fs.readFile(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(source, /resolveSessionsDir\(\s*process\.env,\s*path\.join\(__dirname, 'sessions'\)\s*\)/);
    assert.match(source, /ensureSessionsDir\(/);
    assert.match(source, /NARRA_SKIP_START/);
    assert.match(source, /if \(process\.env\.NARRA_SKIP_START !== '1'\)/);
    assert.doesNotMatch(source, /require\.main\s*===\s*module/);
  });

  test('index.js starts when NARRA_SKIP_START is unset', async (t) => {
    saveEnv(t);
    const started = await runIndex(t, {});
    assert.strictEqual(started.code, 0);
    assert.match(started.stdout, /Logging in to Discord/);
    assert.match(started.stdout, /NarratorBot is online as Narrator#0001/);
    assert.doesNotMatch(started.stdout, /SSM_CLIENT/);
    assertNoStartupSecrets(started);
  });

  test('index.js does not start when NARRA_SKIP_START=1', async (t) => {
    saveEnv(t);
    const skipped = await runIndex(t, { NARRA_SKIP_START: '1' });
    assert.strictEqual(skipped.code, 0);
    assert.doesNotMatch(skipped.stdout, /Logging in to Discord/);
    assert.doesNotMatch(skipped.stdout, /NarratorBot is online/);
    assert.doesNotMatch(skipped.stdout, /SSM_CLIENT/);
    assertNoStartupSecrets(skipped);
  });

  test('creating a new game works with an empty SESSIONS_DIR', async (t) => {
    saveEnv(t);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-empty-sessions-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    assert.deepStrictEqual(await fs.readdir(dir), []);

    const templatePath = path.join(__dirname, '..', 'sessions', 'session-template.json');
    const templateBefore = await fs.readFile(templatePath);
    const manager = new SessionManager(dir, {
      getStory: () => ({ title: 'The Herbalist\'s Choice' }),
    });

    const { session, sessionNumber } = await manager.createSession('42', 'reader', 'the-herbalists-choice');

    assert.strictEqual(sessionNumber, 1);
    assert.strictEqual(session.session.session_id, 'session-42-1');
    assert.strictEqual(session.session.user_id, '42');
    assert.strictEqual(session.session.story_id, 'the-herbalists-choice');
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'session-42-1.json'), 'utf8'));
    assert.strictEqual(saved.session.session_id, 'session-42-1');
    assert.deepStrictEqual(await fs.readFile(templatePath), templateBefore);
    const names = await fs.readdir(dir);
    assert.ok(!names.includes('session-template.json'));
  });

  test('the Docker image keeps session-template.json', async (t) => {
    saveEnv(t);
    const ignore = await fs.readFile(path.join(__dirname, '..', '.dockerignore'), 'utf8');
    assert.match(ignore, /^sessions\/\*$/m);
    assert.match(ignore, /^!sessions\/session-template\.json$/m);
    assert.doesNotMatch(ignore, /^sessions$/m);
  });
});

const REPO_ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'preload-no-network.js');

function childEnv(sessionsDir, extra) {
  const env = { ...process.env };
  delete env.NARRA_SKIP_START;
  delete env.NODE_OPTIONS;
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_PROFILE;
  delete env.AWS_REGION;
  env.DISCORD_TOKEN = 'test-token';
  env.LLM_API_KEY = 'test-llm-key';
  env.TYPESAFE_API_KEY = 'test-typesafe-key';
  env.SESSIONS_DIR = sessionsDir;
  Object.assign(env, extra);
  return env;
}

function redactStartup(text) {
  return String(text)
    .replaceAll('test-token', '[redacted]')
    .replaceAll('test-llm-key', '[redacted]')
    .replaceAll('test-typesafe-key', '[redacted]');
}

function assertNoStartupSecrets(result) {
  const combined = `${result.stdout}\n${result.stderr}`;
  for (const secret of SECRET_VALUES) {
    assert.ok(!combined.includes(secret), 'startup output contains a secret value');
  }
}

function runIndex(t, extra) {
  return fs.mkdtemp(path.join(os.tmpdir(), 'narrator-start-')).then((sessionsDir) => {
    t.after(() => fs.rm(sessionsDir, { recursive: true, force: true }));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', PRELOAD, path.join(REPO_ROOT, 'index.js')], {
        cwd: REPO_ROOT,
        env: childEnv(sessionsDir, extra),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`index.js did not exit\n${redactStartup(stdout)}\n${redactStartup(stderr)}`));
      }, 8000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  });
}
