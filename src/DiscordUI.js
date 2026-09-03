const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

class DiscordUI {
  constructor(storyManager, sessionManager) {
    this.storyManager = storyManager;
    this.sessionManager = sessionManager;
  }

  splitMessage(text, maxLength = 2000) {
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

  buildStorySelectionUI() {
    const embed = new EmbedBuilder()
      .setTitle('🎮 Welcome to NarratorBot')
      .setDescription('Choose a story to begin your adventure:')
      .setColor(0x5865F2);

    const rows = [];
    let currentRow = new ActionRowBuilder();
    let buttonCount = 0;

    for (const [storyId, story] of this.storyManager.getAllStories()) {
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

  async buildSessionSelectionUI(userId) {
    const sessions = await this.sessionManager.getUserSessions(userId);

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

    for (const session of sessions.slice(0, 10)) {
      const story = this.storyManager.getStory(session.storyId);
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
}

module.exports = DiscordUI;
