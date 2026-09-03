const path = require('path');

const SecretsManager = require('./src/SecretsManager');
const StoryManager = require('./src/StoryManager');
const SessionManager = require('./src/SessionManager');
const NarrationService = require('./src/NarrationService');
const DiscordUI = require('./src/DiscordUI');
const Bot = require('./src/Bot');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const STORIES_DIR = path.join(__dirname, 'stories');

const llmProvider = process.env.LLM_PROVIDER || 'kimi';
const llmCredentialsSecret = process.env.LLM_CREDENTIALS_SECRET || `${llmProvider}-credentials`;

const secretsManager = new SecretsManager();
const storyManager = new StoryManager(STORIES_DIR, PROMPTS_DIR);
const sessionManager = new SessionManager(SESSIONS_DIR, storyManager);
const narrationService = new NarrationService(storyManager, null, {
  provider: llmProvider,
});
const discordUI = new DiscordUI(storyManager, sessionManager);

const bot = new Bot({
  secretsManager,
  storyManager,
  sessionManager,
  narrationService,
  discordUI,
  llmCredentialsSecret,
});

bot.init();
