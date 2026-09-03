const test = require('node:test');
const assert = require('node:assert');

const SecretsManager = require('../src/SecretsManager');

test('getSecret: returns the decrypted parameter value', async () => {
  const manager = new SecretsManager('eu-north-1');
  manager.ssmClient = {
    send: async () => ({ Parameter: { Value: 'super-secret' } }),
  };

  assert.strictEqual(await manager.getSecret('narrator-bot'), 'super-secret');
});

test('getSecret: requests decryption for the named parameter', async () => {
  const manager = new SecretsManager('eu-north-1');
  let captured;
  manager.ssmClient = {
    send: async (command) => {
      captured = command.input;
      return { Parameter: { Value: 'v' } };
    },
  };

  await manager.getSecret('kimi-credentials');

  assert.strictEqual(captured.Name, 'kimi-credentials');
  assert.strictEqual(captured.WithDecryption, true);
});

test('getSecret: propagates SSM failures', async () => {
  const manager = new SecretsManager('eu-north-1');
  manager.ssmClient = {
    send: async () => { throw new Error('ParameterNotFound'); },
  };

  await assert.rejects(() => manager.getSecret('missing'), /ParameterNotFound/);
});

test('constructor: honours an explicit region', () => {
  const manager = new SecretsManager('us-east-1');
  assert.ok(manager.ssmClient, 'an SSM client should be constructed');
});
