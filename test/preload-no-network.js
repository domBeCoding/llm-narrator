// Loaded with node --require before index.js in tests. Discord, SSM, and fetch
// stay local, so startup cannot call Discord, AWS, or Kimi.
const Module = require('module');

const originalRequire = Module.prototype.require;

class SlashCommandBuilder {
  setName() { return this; }
  setDescription() { return this; }
  toJSON() { return {}; }
}

class Client {
  constructor() {
    this.user = { id: 'bot', tag: 'Narrator#0001' };
    this.guilds = { cache: new Map() };
    this.onceHandlers = new Map();
  }

  once(event, handler) {
    this.onceHandlers.set(event, handler);
  }

  on() {}

  async login() {
    const handler = this.onceHandlers.get('clientReady');
    if (handler) await handler({ user: { tag: 'Narrator#0001' } });
  }
}

class REST {
  setToken() { return this; }
  async put() {
    throw new Error('Discord REST is not allowed in this test');
  }
}

class SSMClient {
  constructor() {
    process.stdout.write('SSM_CLIENT\n');
  }

  async send() {
    throw new Error('SSM send is not allowed in this test');
  }
}

class GetParameterCommand {
  constructor(input) {
    this.input = input;
  }
}

const discordStub = {
  Client,
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 3 },
  Events: { ClientReady: 'clientReady', MessageCreate: 'messageCreate', InteractionCreate: 'interactionCreate' },
  REST,
  Routes: { applicationGuildCommands: () => '' },
  SlashCommandBuilder,
  EmbedBuilder: class EmbedBuilder {},
};

Module.prototype.require = function (id) {
  if (id === 'discord.js') return discordStub;
  if (id === '@aws-sdk/client-ssm') return { SSMClient, GetParameterCommand };
  return originalRequire.apply(this, arguments);
};

global.fetch = async () => {
  throw new Error('network fetch is not allowed in this test');
};
