const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { isGibberish } = require('./utils');

class Bot {
  constructor({ secretsManager, storyManager, sessionManager, narrationService, discordUI, llmCredentialsSecret }) {
    this.secretsManager = secretsManager;
    this.llmCredentialsSecret = llmCredentialsSecret;
    this.storyManager = storyManager;
    this.sessionManager = sessionManager;
    this.narrationService = narrationService;
    this.discordUI = discordUI;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ]
    });

    this.discordToken = null;
    this._setupEventHandlers();
  }

  _setupEventHandlers() {
    this.client.once(Events.ClientReady, async (readyClient) => {
      console.log(`NarratorBot is online as ${readyClient.user.tag}`);
      await this.registerSlashCommands();
    });

    this.client.on(Events.MessageCreate, async (message) => {
      await this.handleMessage(message);
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        console.log('[DEBUG] Interaction received:', interaction.type, interaction.customId || interaction.commandName);
        if (interaction.isChatInputCommand()) {
          await this.handleSlashCommand(interaction);
        } else if (interaction.isButton()) {
          await this.handleButtonInteraction(interaction);
        }
      } catch (error) {
        console.error('Error handling interaction:', error);
        console.error('Error stack:', error.stack);
        try {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'An error occurred!', ephemeral: true });
          } else {
            await interaction.reply({ content: 'An error occurred!', ephemeral: true });
          }
        } catch (replyError) {
          console.error('Failed to send error message:', replyError);
        }
      }
    });
  }

  async init() {
    try {
      console.log('Loading secrets from SSM...');
      this.discordToken = await this.secretsManager.getSecret('narrator-bot');
      const llmApiKey = await this.secretsManager.getSecret(this.llmCredentialsSecret);
      this.narrationService.apiKey = llmApiKey;

      console.log('Loading story data...');
      await this.storyManager.loadStoryData();

      console.log('Logging in to Discord...');
      await this.client.login(this.discordToken);

    } catch (error) {
      console.error('Failed to initialize bot:', error);
      process.exit(1);
    }
  }

  async registerSlashCommands() {
    const commands = [
      new SlashCommandBuilder()
        .setName('start')
        .setDescription('Start a new story adventure'),
      new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Restart with a new story or continue a previous session'),
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check your current game status')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(this.discordToken);

    try {
      console.log('Registering slash commands...');

      const guilds = this.client.guilds.cache;

      for (const [guildId, guild] of guilds) {
        await rest.put(
          Routes.applicationGuildCommands(this.client.user.id, guildId),
          { body: commands }
        );
        console.log(`Registered commands to guild: ${guild.name} (${guildId})`);
      }

      console.log('Slash commands registered successfully');
    } catch (error) {
      console.error('Failed to register slash commands:', error);
    }
  }

  async handleSlashCommand(interaction) {
    const { commandName, user } = interaction;

    if (commandName === 'start') {
      const activeSession = await this.sessionManager.getActiveSession(user.id);

      if (activeSession && (activeSession.session.status === 'active' || activeSession.session.status === 'concluding')) {
        const story = this.storyManager.getStory(activeSession.session.story_id);
        const statusHint = activeSession.session.status === 'concluding' ? ' Your story is in its final turn — @mention me with your last action to see the ending.' : '';
        await interaction.reply({
          content: `You already have an active game of **${story?.title || 'Unknown Story'}**. Use \`/restart\` to start a new game, or continue playing by @mentioning me with your action.${statusHint}`,
          ephemeral: true
        });
        return;
      }

      const { embed, rows } = this.discordUI.buildStorySelectionUI();
      await interaction.reply({
        embeds: [embed],
        components: rows,
        ephemeral: true
      });

    } else if (commandName === 'restart') {
      const sessions = await this.sessionManager.getUserSessions(user.id);

      if (sessions.length === 0) {
        const { embed, rows } = this.discordUI.buildStorySelectionUI();
        await interaction.reply({
          content: '🎮 Starting your first game...',
          embeds: [embed],
          components: rows,
          ephemeral: true
        });
        return;
      }

      const sessionUI = await this.discordUI.buildSessionSelectionUI(user.id);
      await interaction.reply({
        content: '🔄 Choose a session to continue, or start a new game:',
        embeds: [sessionUI.embed],
        components: sessionUI.rows,
        ephemeral: true
      });

    } else if (commandName === 'status') {
      const session = await this.sessionManager.getActiveSession(user.id);

      if (!session) {
        await interaction.reply({
          content: 'You don\'t have an active game. Use `/start` to begin!',
          ephemeral: true
        });
        return;
      }

      const story = this.storyManager.getStory(session.session.story_id);
      const embed = new EmbedBuilder()
        .setTitle(`📖 ${story?.title || 'Current Game'}`)
        .setColor(0x5865F2)
        .addFields(
          { name: 'Status', value: session.session.status, inline: true },
          { name: 'Turn', value: String(session.session.turn_count), inline: true },
          { name: 'Started', value: new Date(session.session.started_at).toLocaleDateString(), inline: true },
          { name: 'Current Scene', value: session.story.current_scene || 'Unknown', inline: false }
        );

      await interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }
  }

  async handleButtonInteraction(interaction) {
    const { customId, user } = interaction;

    if (customId.startsWith('start_story_')) {
      const storyId = customId.replace('start_story_', '');
      const story = this.storyManager.getStory(storyId);

      if (!story) {
        await interaction.reply({
          content: '❌ Story not found. Please try again.',
          ephemeral: true
        });
        return;
      }

      const { session, sessionNumber } = await this.sessionManager.createSession(user.id, user.username, storyId);

      await interaction.update({
        content: `🎮 **${story.title}** — Session ${sessionNumber}\n\n*Generating your opening scene...*`,
        embeds: [],
        components: []
      });

      try {
        const openingAction = story.openingAction
          || 'This is the opening turn. Set the scene where the story begins, introduce the reader to their surroundings, and establish the situation that sets the story in motion.';
        const prompt = this.narrationService.buildPrompt(session, openingAction);
        const response = await this.narrationService.callLLM(prompt, session);
        const { narration, stateUpdate } = this.narrationService.parseResponse(response);

        this.narrationService.applyStateUpdates(session, stateUpdate, narration, openingAction);

        if (this.narrationService.evaluateEndConditions(session, story.config)) {
          session.session.status = 'concluding';
        }

        await this.sessionManager.saveSession(user.id, sessionNumber, session);

        const chunks = this.discordUI.splitMessage(narration);
        for (const chunk of chunks) {
          await interaction.followUp({ content: chunk });
        }

        await interaction.channel.send({
          content: `🎮 <@${user.id}> has started **${story.title}** (Session ${sessionNumber})!`
        });

      } catch (error) {
        console.error('Error generating opening narration:', error);
        await interaction.followUp({
          content: `🎮 **${story.title}** — Session ${sessionNumber}\n\n${story.description}\n\n*${story.genre} • ${story.estimatedPlayTime}*\n\n---\n\nTo begin, @mention me with your first action. For example:\n\`@NarratorBot I look around the room\``
        });
      }

    } else if (customId.startsWith('load_session_')) {
      const sessionNumber = parseInt(customId.replace('load_session_', ''));
      const session = await this.sessionManager.getSessionByNumber(user.id, sessionNumber);

      if (!session) {
        await interaction.reply({
          content: '❌ Session not found. Please try again.',
          ephemeral: true
        });
        return;
      }

      const story = this.storyManager.getStory(session.session.story_id);

      await interaction.update({
        content: `📚 **${story?.title || 'Unknown Story'}** — Session ${sessionNumber}\n\nStatus: ${session.session.status}\nTurns: ${session.session.turn_count}\nStarted: ${new Date(session.session.started_at).toLocaleDateString()}\n\n---\n\nTo continue, @mention me with your next action.`,
        embeds: [],
        components: []
      });

    } else if (customId === 'start_new_game') {
      console.log('[DEBUG] start_new_game button pressed by', user.username);
      try {
        const { embed, rows } = this.discordUI.buildStorySelectionUI();
        await interaction.update({
          content: '🎮 Choose a story to begin:',
          embeds: [embed],
          components: rows
        });
        console.log('[DEBUG] start_new_game UI sent successfully');
      } catch (error) {
        console.error('[ERROR] start_new_game failed:', error);
        throw error;
      }
    }
  }

  async handleMessage(message) {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.mentions.has(this.client.user.id)) return;

    const userAction = message.content.replace(/<@!?\d+>/g, '').trim();
    const userId = message.author.id;
    const username = message.author.username;

    if (!userAction) return;

    if (isGibberish(userAction)) {
      const clarifications = [
        'The Narrator pauses, quill hovering over the page. \'Sorry, I didn\'t quite catch that. What did you want to do?\'',
        'The story holds its breath. \'Give me that again — what\'s your move?\'',
        'The Narrator tilts their head. \'I want to make sure I got that right. What are you doing?\'',
        'The Narrator looks up from their notes. \'I didn\'t understand that. What action do you want to take?\''
      ];
      const reply = clarifications[Math.floor(Math.random() * clarifications.length)];
      await message.reply(reply);
      return;
    }

    try {
      await message.react('👀');
    } catch (reactError) {
      console.error('Failed to add reaction:', reactError);
    }

    try {
      await message.channel.sendTyping();
      console.log(`[DEBUG] Processing action from ${username}: ${userAction}`);

      const session = await this.sessionManager.getActiveSession(userId);

      if (!session) {
        await message.reply('You don\'t have an active game. Use `/start` to begin a new story!');
        return;
      }

      if (session.session.status === 'completed') {
        await message.reply('This story has already been completed. Use `/restart` to play again!');
        return;
      }

      const story = this.storyManager.getStory(session.session.story_id);

      console.log('[DEBUG] Building prompt...');
      const prompt = this.narrationService.buildPrompt(session, userAction);
      console.log('[DEBUG] Calling LLM API...');
      const response = await this.narrationService.callLLM(prompt, session);
      console.log('[DEBUG] LLM response received');

      const { narration, stateUpdate } = this.narrationService.parseResponse(response);
      console.log('[DEBUG] Narration length:', narration.length);

      this.narrationService.applyStateUpdates(session, stateUpdate, narration, userAction);

      if (session.session.status === 'concluding') {
        session.session.status = 'completed';
        console.log('[DEBUG] Story concluded, setting status to completed');
      } else if (this.narrationService.evaluateEndConditions(session, story.config)) {
        session.session.status = 'concluding';
        console.log('[DEBUG] End conditions met, setting status to concluding');
      }

      const sessionNumber = parseInt(session.session.session_id.split('-').pop());
      await this.sessionManager.saveSession(userId, sessionNumber, session);

      const chunks = this.discordUI.splitMessage(narration);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }

    } catch (error) {
      console.error('Error handling message:', error);
      await message.reply('Sorry, something went wrong. Please try again.');
    }
  }
}

module.exports = Bot;
