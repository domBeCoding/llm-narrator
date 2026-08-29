const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const STORIES_DIR = path.join(__dirname, 'stories');
const DOCS_DIR = path.join(__dirname, 'docs');

// AWS SSM client
const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'eu-north-1' });

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// In-memory cache for secrets and story data
let discordToken = null;
let kimiApiKey = null;
let systemPrompt = null;

// Available stories registry
const availableStories = new Map();

// Tool definitions for Kimi function calling
const TOOLS = [
  {
    name: 'get_last_narration',
    description: 'Retrieve the exact last narration output from the current game session. Use this when the reader wants to resume after a healthcheck or distraction, to show them the exact same story text and choices they saw before.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

/**
 * Retrieve a secret from AWS SSM Parameter Store
 */
async function getSecret(parameterName) {
  try {
    const command = new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true
    });
    const response = await ssmClient.send(command);
    return response.Parameter.Value;
  } catch (error) {
    console.error(`Failed to retrieve parameter ${parameterName}:`, error.message);
    throw error;
  }
}

/**
 * Load all story files and system prompt
 */
async function loadStoryData() {
  try {
    systemPrompt = await fs.readFile(path.join(DOCS_DIR, 'system-prompt.md'), 'utf8');
    
    const files = await fs.readdir(STORIES_DIR);
    const configFiles = files.filter(f => f.endsWith('-config.json'));
    
    for (const configFile of configFiles) {
      const storyId = configFile.replace('-config.json', '');
      const config = JSON.parse(await fs.readFile(path.join(STORIES_DIR, configFile), 'utf8'));
      const content = await fs.readFile(path.join(STORIES_DIR, `${storyId}.md`), 'utf8');
      
      availableStories.set(storyId, {
        id: storyId,
        title: config.title,
        description: config.description,
        genre: config.genre,
        tone: config.tone,
        estimatedPlayTime: config.estimated_play_time,
        config: config,
        content: content
      });
      
      console.log(`Loaded story: ${config.title} (${storyId})`);
    }
    
    console.log(`Loaded ${availableStories.size} story(ies)`);
  } catch (error) {
    console.error('Failed to load story data:', error);
    throw error;
  }
}

/**
 * Get the next session number for a user
 */
async function getNextSessionNumber(userId) {
  const files = await fs.readdir(SESSIONS_DIR);
  const userSessions = files.filter(f => f.startsWith(`session-${userId}-`) && f.endsWith('.json'));
  
  if (userSessions.length === 0) return 1;
  
  const numbers = userSessions.map(f => {
    const match = f.match(new RegExp(`session-${userId}-(\\d+)\\.json`));
    return match ? parseInt(match[1]) : 0;
  });
  
  return Math.max(...numbers) + 1;
}

/**
 * Get all sessions for a user
 */
async function getUserSessions(userId) {
  const files = await fs.readdir(SESSIONS_DIR);
  const userSessions = files.filter(f => f.startsWith(`session-${userId}-`) && f.endsWith('.json'));
  
  const sessions = [];
  for (const file of userSessions) {
    try {
      const data = await fs.readFile(path.join(SESSIONS_DIR, file), 'utf8');
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

/**
 * Get the active session for a user (most recent)
 */
async function getActiveSession(userId) {
  const sessions = await getUserSessions(userId);
  if (sessions.length === 0) return null;
  
  const latest = sessions[0];
  const data = await fs.readFile(path.join(SESSIONS_DIR, latest.file), 'utf8');
  return JSON.parse(data);
}

/**
 * Get a specific session by number
 */
async function getSessionByNumber(userId, sessionNumber) {
  const sessionFile = path.join(SESSIONS_DIR, `session-${userId}-${sessionNumber}.json`);
  try {
    const data = await fs.readFile(sessionFile, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

/**
 * Create a new session for a user with a specific story
 */
async function createSession(userId, username, storyId) {
  const story = availableStories.get(storyId);
  if (!story) {
    throw new Error(`Story not found: ${storyId}`);
  }

  const sessionNumber = await getNextSessionNumber(userId);
  
  const templateData = await fs.readFile(path.join(SESSIONS_DIR, 'session-template.json'), 'utf8');
  const session = JSON.parse(templateData);
  
  session.session.session_id = `session-${userId}-${sessionNumber}`;
  session.session.user_id = userId;
  session.session.story_id = storyId;
  session.session.started_at = new Date().toISOString();
  session.session.last_action_at = new Date().toISOString();
  
  await saveSession(userId, sessionNumber, session);
  
  return { session, sessionNumber };
}

/**
 * Save session to disk
 */
async function saveSession(userId, sessionNumber, session) {
  const sessionFile = path.join(SESSIONS_DIR, `session-${userId}-${sessionNumber}.json`);
  await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf8');
}

/**
 * Delete a user's session
 */
async function deleteSession(userId, sessionNumber) {
  const sessionFile = path.join(SESSIONS_DIR, `session-${userId}-${sessionNumber}.json`);
  try {
    await fs.unlink(sessionFile);
  } catch (e) {
    // File might not exist, that's fine
  }
}

/**
 * Build the LLM prompt for Kimi
 */
function buildPrompt(session, userAction) {
  const story = availableStories.get(session.session.story_id);
  const stateSummary = JSON.stringify(session, null, 2);
  
  return `${systemPrompt}

---

## Current Session State

\`\`\`json
${stateSummary}
\`\`\`

---

## Story Context

${story.content}

---

## Story Config (Mechanical Rules)

\`\`\`json
${JSON.stringify(story.config, null, 2)}
\`\`\`

---

## Reader's Action

${userAction}

---

Generate the narration response following the format specified in the system prompt. Include the story, divider, summary prompt, and choices. After the narration, include a JSON block with state updates.`;
}

/**
 * Call Kimi API for narration (Anthropic Messages API format with tool support)
 */
async function callKimi(prompt, session) {
  const messages = [
    { role: 'user', content: prompt }
  ];
  
  let response = await fetch('https://api.kimi.com/coding/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': kimiApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'kimi-k2',
      system: 'You are the Narrator, a Dungeon Master for interactive storytelling.',
      messages: messages,
      tools: TOOLS,
      temperature: 0.7,
      max_tokens: 4000
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Kimi API error: ${response.status} - ${error}`);
  }

  let data = await response.json();
  console.log('[DEBUG] Kimi response received, stop_reason:', data.stop_reason);
  
  // Handle tool calls
  while (data.stop_reason === 'tool_use') {
    const toolUseBlock = data.content.find(block => block.type === 'tool_use');
    
    if (!toolUseBlock) {
      console.error('[ERROR] Tool use indicated but no tool_use block found');
      break;
    }
    
    console.log(`[DEBUG] Tool call: ${toolUseBlock.name}`, toolUseBlock.input);
    
    // Execute the tool
    let toolResult;
    if (toolUseBlock.name === 'get_last_narration') {
      toolResult = session.session.last_llm_output || 'No previous narration found.';
      console.log('[DEBUG] Returning last narration, length:', toolResult.length);
    } else {
      toolResult = `Unknown tool: ${toolUseBlock.name}`;
    }
    
    // Add assistant's tool use to messages
    messages.push({
      role: 'assistant',
      content: data.content
    });
    
    // Add tool result
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseBlock.id,
          content: toolResult
        }
      ]
    });
    
    // Call Kimi again with the tool result
    response = await fetch('https://api.kimi.com/coding/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': kimiApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'kimi-k2',
        system: 'You are the Narrator, a Dungeon Master for interactive storytelling.',
        messages: messages,
        tools: TOOLS,
        temperature: 0.7,
        max_tokens: 4000
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Kimi API error on tool continuation: ${response.status} - ${error}`);
    }

    data = await response.json();
    console.log('[DEBUG] Kimi continuation response, stop_reason:', data.stop_reason);
  }
  
  // Extract text response
  if (data.content && Array.isArray(data.content) && data.content.length > 0) {
    const textBlock = data.content.find(block => block.type === 'text');
    if (textBlock) {
      return textBlock.text;
    }
  }
  
  console.error('[ERROR] No text block in Kimi response');
  throw new Error('No text response from Kimi');
}

/**
 * Parse LLM response and extract narration + state updates
 */
function parseResponse(response) {
  const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
  
  let narration = response;
  let stateUpdate = null;
  
  if (jsonMatch) {
    try {
      stateUpdate = JSON.parse(jsonMatch[1]);
      narration = response.replace(/```json\n[\s\S]*?\n```/, '').trim();
    } catch (e) {
      console.error('Failed to parse state update JSON:', e);
    }
  }
  
  narration = narration.replace(/\[State updated\]/gi, '').trim();
  narration = narration.replace(/\[Thinking\]/gi, '').trim();
  narration = narration.replace(/\[.*?updated.*?\]/gi, '').trim();
  
  return { narration, stateUpdate };
}

/**
 * Apply state updates to session
 */
function applyStateUpdates(session, stateUpdate) {
  if (!stateUpdate) return;
  
  session.session.turn_count += 1;
  session.session.last_action_at = new Date().toISOString();
  
  if (stateUpdate.characters) {
    for (const [charName, updates] of Object.entries(stateUpdate.characters)) {
      if (session.characters[charName]) {
        Object.assign(session.characters[charName], updates);
      }
    }
  }
  
  if (stateUpdate.reader) {
    Object.assign(session.reader, stateUpdate.reader);
  }
  
  if (stateUpdate.story) {
    if (stateUpdate.story.plot_beats_hit) {
      session.story.plot_beats_hit.push(...stateUpdate.story.plot_beats_hit);
    }
    if (stateUpdate.story.flags) {
      Object.assign(session.story.flags, stateUpdate.story.flags);
    }
    if (stateUpdate.story.current_act) {
      session.story.current_act = stateUpdate.story.current_act;
    }
    if (stateUpdate.story.current_scene) {
      session.story.current_scene = stateUpdate.story.current_scene;
    }
  }
  
  if (stateUpdate.world) {
    if (stateUpdate.world.locations) {
      for (const [locName, updates] of Object.entries(stateUpdate.world.locations)) {
        if (session.world.locations[locName]) {
          Object.assign(session.world.locations[locName], updates);
        }
      }
    }
  }
  
  if (stateUpdate.choice_log) {
    session.choice_history.push({
      turn: session.session.turn_count,
      ...stateUpdate.choice_log
    });
  }
  
  if (stateUpdate.last_llm_output) {
    session.session.last_llm_output = stateUpdate.last_llm_output;
  }
}

/**
 * Split long messages into Discord-compatible chunks
 */
function splitMessage(text, maxLength = 2000) {
  if (text.length <= maxLength) return [text];
  
  const chunks = [];
  let currentChunk = '';
  
  const lines = text.split('\n');
  
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > maxLength) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * Build the story selection embed and buttons
 */
function buildStorySelectionUI() {
  const embed = new EmbedBuilder()
    .setTitle('🎮 Welcome to NarratorBot')
    .setDescription('Choose a story to begin your adventure:')
    .setColor(0x5865F2);
  
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let buttonCount = 0;
  
  for (const [storyId, story] of availableStories) {
    embed.addFields({
      name: story.title,
      value: `${story.description}\n*${story.genre} • ${story.estimatedPlayTime}*`,
      inline: false
    });
    
    const button = new ButtonBuilder()
      .setCustomId(`start_story_${storyId}`)
      .setLabel(`Start: ${story.title}`)
      .setStyle(ButtonStyle.Primary);
    
    currentRow.addComponents(button);
    buttonCount++;
    
    if (buttonCount % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  
  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }
  
  return { embed, rows };
}

/**
 * Build the session selection embed and buttons
 */
async function buildSessionSelectionUI(userId) {
  const sessions = await getUserSessions(userId);
  
  if (sessions.length === 0) {
    return null;
  }
  
  const embed = new EmbedBuilder()
    .setTitle('📚 Your Previous Sessions')
    .setDescription('Select a session to continue, or start a new game:')
    .setColor(0x5865F2);
  
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let buttonCount = 0;
  
  for (const session of sessions.slice(0, 10)) { // Limit to 10 most recent
    const story = availableStories.get(session.storyId);
    const date = new Date(session.startedAt).toLocaleDateString();
    const status = session.status === 'completed' ? '✅' : '🎮';
    
    embed.addFields({
      name: `${status} Session ${session.sessionNumber} — ${story?.title || 'Unknown'}`,
      value: `Started: ${date} • Turns: ${session.turnCount} • Status: ${session.status}`,
      inline: false
    });
    
    const button = new ButtonBuilder()
      .setCustomId(`load_session_${session.sessionNumber}`)
      .setLabel(`Load Session ${session.sessionNumber}`)
      .setStyle(ButtonStyle.Secondary);
    
    currentRow.addComponents(button);
    buttonCount++;
    
    if (buttonCount % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  
  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }
  
  // Add a "New Game" button at the end
  const newGameRow = new ActionRowBuilder();
  newGameRow.addComponents(
    new ButtonBuilder()
      .setCustomId('start_new_game')
      .setLabel('🎮 Start New Game')
      .setStyle(ButtonStyle.Primary)
  );
  rows.push(newGameRow);
  
  return { embed, rows };
}

/**
 * Handle slash command interactions
 */
async function handleSlashCommand(interaction) {
  const { commandName, user } = interaction;
  
  if (commandName === 'start') {
    const activeSession = await getActiveSession(user.id);
    
    if (activeSession && activeSession.session.status === 'active') {
      const story = availableStories.get(activeSession.session.story_id);
      await interaction.reply({
        content: `You already have an active game of **${story?.title || 'Unknown Story'}**. Use \`/restart\` to start a new game, or continue playing by @mentioning me with your action.`,
        ephemeral: true
      });
      return;
    }
    
    const { embed, rows } = buildStorySelectionUI();
    await interaction.reply({
      embeds: [embed],
      components: rows,
      ephemeral: true
    });
    
  } else if (commandName === 'restart') {
    const sessions = await getUserSessions(user.id);
    
    if (sessions.length === 0) {
      // No previous sessions, just show story selection
      const { embed, rows } = buildStorySelectionUI();
      await interaction.reply({
        content: '🎮 Starting your first game...',
        embeds: [embed],
        components: rows,
        ephemeral: true
      });
      return;
    }
    
    // Show session selection UI
    const sessionUI = await buildSessionSelectionUI(user.id);
    await interaction.reply({
      content: '🔄 Choose a session to continue, or start a new game:',
      embeds: [sessionUI.embed],
      components: sessionUI.rows,
      ephemeral: true
    });
    
  } else if (commandName === 'status') {
    const session = await getActiveSession(user.id);
    
    if (!session) {
      await interaction.reply({
        content: 'You don\'t have an active game. Use `/start` to begin!',
        ephemeral: true
      });
      return;
    }
    
    const story = availableStories.get(session.session.story_id);
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

/**
 * Handle button interactions
 */
async function handleButtonInteraction(interaction) {
  const { customId, user } = interaction;
  
  if (customId.startsWith('start_story_')) {
    const storyId = customId.replace('start_story_', '');
    const story = availableStories.get(storyId);
    
    if (!story) {
      await interaction.reply({
        content: '❌ Story not found. Please try again.',
        ephemeral: true
      });
      return;
    }
    
    const { session, sessionNumber } = await createSession(user.id, user.username, storyId);
    
    // Respond immediately — Kimi takes 30-50s, Discord only gives 3s
    await interaction.update({
      content: `🎮 **${story.title}** — Session ${sessionNumber}\n\n*Generating your opening scene...*`,
      embeds: [],
      components: []
    });
    
    // Generate the opening narration in the background
    try {
      const openingAction = 'You wake in the apothecary to the sound of coughing. Master Elara is still in her cot — she should have been up an hour ago. The morning light filters through the dried herbs hanging from the rafters. Something is wrong.';
      const prompt = buildPrompt(session, openingAction);
      const response = await callKimi(prompt, session);
      const { narration, stateUpdate } = parseResponse(response);
      
      applyStateUpdates(session, stateUpdate);
      await saveSession(user.id, sessionNumber, session);
      
      // Send the opening narration as follow-up
      const chunks = splitMessage(narration);
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
    const session = await getSessionByNumber(user.id, sessionNumber);
    
    if (!session) {
      await interaction.reply({
        content: '❌ Session not found. Please try again.',
        ephemeral: true
      });
      return;
    }
    
    const story = availableStories.get(session.session.story_id);
    
    await interaction.update({
      content: `📚 **${story?.title || 'Unknown Story'}** — Session ${sessionNumber}\n\nStatus: ${session.session.status}\nTurns: ${session.session.turn_count}\nStarted: ${new Date(session.session.started_at).toLocaleDateString()}\n\n---\n\nTo continue, @mention me with your next action.`,
      embeds: [],
      components: []
    });
    
  } else if (customId === 'start_new_game') {
    console.log('[DEBUG] start_new_game button pressed by', user.username);
    try {
      const { embed, rows } = buildStorySelectionUI();
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

/**
 * Handle incoming Discord messages (game actions)
 */
async function handleMessage(message) {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.mentions.has(client.user.id)) return;
  
  const userAction = message.content.replace(/<@!?\d+>/g, '').trim();
  const userId = message.author.id;
  const username = message.author.username;
  
  if (!userAction) return;
  
  // INSTANT ACKNOWLEDGMENT: Add emoji reaction immediately so user knows we saw it
  try {
    await message.react('👀');
  } catch (reactError) {
    console.error('Failed to add reaction:', reactError);
    // Continue anyway — reaction is nice-to-have, not critical
  }
  
  try {
    await message.channel.sendTyping();
    console.log(`[DEBUG] Processing action from ${username}: ${userAction}`);
    
    const session = await getActiveSession(userId);
    
    if (!session) {
      await message.reply('You don\'t have an active game. Use `/start` to begin a new story!');
      return;
    }
    
    if (session.session.status === 'completed') {
      await message.reply('This story has already been completed. Use `/restart` to play again!');
      return;
    }
    
    console.log('[DEBUG] Building prompt...');
    const prompt = buildPrompt(session, userAction);
    console.log('[DEBUG] Calling Kimi API...');
    const response = await callKimi(prompt, session);
    console.log('[DEBUG] Kimi response received');
    
    const { narration, stateUpdate } = parseResponse(response);
    console.log('[DEBUG] Narration length:', narration.length);
    
    applyStateUpdates(session, stateUpdate);
    
    // Extract session number from session_id
    const sessionNumber = parseInt(session.session.session_id.split('-').pop());
    await saveSession(userId, sessionNumber, session);
    
    const chunks = splitMessage(narration);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
    
  } catch (error) {
    console.error('Error handling message:', error);
    await message.reply('Sorry, something went wrong. Please try again.');
  }
}

/**
 * Register slash commands with Discord
 */
async function registerSlashCommands() {
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

  const rest = new REST({ version: '10' }).setToken(discordToken);
  
  try {
    console.log('Registering slash commands...');
    
    const guilds = client.guilds.cache;
    
    for (const [guildId, guild] of guilds) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guildId),
        { body: commands }
      );
      console.log(`Registered commands to guild: ${guild.name} (${guildId})`);
    }
    
    console.log('Slash commands registered successfully');
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
}

/**
 * Initialize bot
 */
async function init() {
  try {
    console.log('Loading secrets from SSM...');
    discordToken = await getSecret('narrator-bot');
    kimiApiKey = await getSecret('kimi-credentials');
    
    console.log('Loading story data...');
    await loadStoryData();
    
    console.log('Logging in to Discord...');
    await client.login(discordToken);
    
  } catch (error) {
    console.error('Failed to initialize bot:', error);
    process.exit(1);
  }
}

// Event handlers
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`NarratorBot is online as ${readyClient.user.tag}`);
  await registerSlashCommands();
});

client.on(Events.MessageCreate, async (message) => {
  await handleMessage(message);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    console.log('[DEBUG] Interaction received:', interaction.type, interaction.customId || interaction.commandName);
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
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

// Start the bot
init();
