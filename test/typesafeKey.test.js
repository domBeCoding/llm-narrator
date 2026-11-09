const { describe, test } = require('node:test');
const assert = require('node:assert');

const Bot = require('../src/Bot');
const { loadTypesafeApiKey, DEFAULT_PARAMETER } = require('../src/typesafeKey');

function captureConsole(t) {
  const lines = [];
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => {
      lines.push(args.map(part => String(part)).join(' '));
    });
  }
  return lines;
}

test('the default parameter name is typesafe-api-key', () => {
  assert.strictEqual(DEFAULT_PARAMETER, 'typesafe-api-key');
});

test('TYPESAFE_API_KEY is used and SSM is not called', async () => {
  let calls = 0;
  const key = await loadTypesafeApiKey({
    getSecret: async () => { calls += 1; return 'from-ssm'; },
  }, { TYPESAFE_API_KEY: 'from-env' });

  assert.strictEqual(key, 'from-env');
  assert.strictEqual(calls, 0);
});

test('an empty env key falls through to the default SSM parameter', async (t) => {
  captureConsole(t);
  let requested;
  const key = await loadTypesafeApiKey({
    getSecret: async (name) => {
      requested = name;
      return 'from-ssm';
    },
  }, { TYPESAFE_API_KEY: '' });

  assert.strictEqual(requested, 'typesafe-api-key');
  assert.strictEqual(key, 'from-ssm');
});

test('TYPESAFE_CREDENTIALS_SECRET selects the SSM parameter', async (t) => {
  captureConsole(t);
  let requested;
  const key = await loadTypesafeApiKey({
    getSecret: async (name) => {
      requested = name;
      return 'from-custom';
    },
  }, { TYPESAFE_CREDENTIALS_SECRET: 'custom-typesafe' });

  assert.strictEqual(requested, 'custom-typesafe');
  assert.strictEqual(key, 'from-custom');
});

test('a missing parameter does not throw and does not log a secret', async (t) => {
  const lines = captureConsole(t);
  const key = await loadTypesafeApiKey({
    getSecret: async () => { throw new Error('ParameterNotFound'); },
  }, {});

  assert.strictEqual(key, null);
  assert.ok(lines.some(line => line.includes('typesafe-api-key')));
  assert.ok(lines.every(line => !line.includes('ParameterNotFound')));
});

test('an empty SSM value is treated as missing', async (t) => {
  captureConsole(t);
  const key = await loadTypesafeApiKey({
    getSecret: async () => '',
  }, {});

  assert.strictEqual(key, null);
});

// bot.init() reads process.env. Hide any host TypeSafe settings for these two
// tests and put them back afterwards. The saved values are never logged.
function withoutHostTypesafeEnv(t) {
  const savedKey = process.env.TYPESAFE_API_KEY;
  const savedName = process.env.TYPESAFE_CREDENTIALS_SECRET;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_CREDENTIALS_SECRET;
  t.after(() => {
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
    if (savedName === undefined) delete process.env.TYPESAFE_CREDENTIALS_SECRET;
    else process.env.TYPESAFE_CREDENTIALS_SECRET = savedName;
  });
}

describe('init loads the TypeSafe key without the host environment', { concurrency: 1 }, () => {
test('init still starts when the TypeSafe key is not configured', async (t) => {
  withoutHostTypesafeEnv(t);
  const lines = captureConsole(t);
  t.mock.method(process, 'exit', (code) => {
    throw new Error(`process.exit ${code}`);
  });

  const names = [];
  const bot = new Bot({
    secretsManager: {
      getSecret: async (name) => {
        names.push(name);
        if (name === 'typesafe-api-key') throw new Error('ParameterNotFound');
        if (name === 'narrator-bot') return 'discord-token';
        return 'llm-key';
      },
    },
    llmCredentialsSecret: 'kimi-credentials',
    storyManager: { loadStoryData: async () => {} },
    narrationService: {},
    sessionManager: {},
    discordUI: {},
  });
  let loggedIn = false;
  bot.client.login = async (token) => {
    loggedIn = true;
    assert.strictEqual(token, 'discord-token');
  };

  await bot.init();

  assert.strictEqual(loggedIn, true);
  assert.strictEqual(bot.typesafeApiKey, null);
  assert.strictEqual(bot.narrationService.apiKey, 'llm-key');
  assert.deepStrictEqual(names, ['narrator-bot', 'kimi-credentials', 'typesafe-api-key']);
  assert.ok(lines.every(line => !line.includes('discord-token') && !line.includes('llm-key')));
});

test('init stores a configured TypeSafe key and does not log it', async (t) => {
  withoutHostTypesafeEnv(t);
  const lines = captureConsole(t);
  t.mock.method(process, 'exit', (code) => {
    throw new Error(`process.exit ${code}`);
  });

  const bot = new Bot({
    secretsManager: {
      getSecret: async (name) => {
        if (name === 'typesafe-api-key') return 'loaded-typesafe-key';
        if (name === 'narrator-bot') return 'discord-token';
        return 'llm-key';
      },
    },
    llmCredentialsSecret: 'kimi-credentials',
    storyManager: { loadStoryData: async () => {} },
    narrationService: {},
    sessionManager: {},
    discordUI: {},
  });
  bot.client.login = async () => {};

  await bot.init();

  assert.strictEqual(bot.typesafeApiKey, 'loaded-typesafe-key');
  assert.ok(lines.every(line => !line.includes('loaded-typesafe-key')));
  assert.ok(lines.every(line => !line.includes('discord-token') && !line.includes('llm-key')));
});
});
