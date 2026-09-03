const fs = require('fs').promises;
const path = require('path');

class StoryManager {
  constructor(storiesDir, promptsDir) {
    this.storiesDir = storiesDir;
    this.promptsDir = promptsDir;
    this.stories = new Map();
    this.systemPrompt = null;
    this.concludingDirective = null;
  }

  async loadStoryData() {
    try {
      this.systemPrompt = await fs.readFile(path.join(this.promptsDir, 'system-prompt.md'), 'utf8');
      this.concludingDirective = await fs.readFile(path.join(this.promptsDir, 'concluding-directive.md'), 'utf8');

      const files = await fs.readdir(this.storiesDir);
      const configFiles = files.filter(f => f.endsWith('-config.json'));

      for (const configFile of configFiles) {
        const storyId = configFile.replace('-config.json', '');
        const config = JSON.parse(await fs.readFile(path.join(this.storiesDir, configFile), 'utf8'));
        const content = await fs.readFile(path.join(this.storiesDir, `${storyId}.md`), 'utf8');

        this.stories.set(storyId, {
          id: storyId,
          title: config.title,
          description: config.description,
          genre: config.genre,
          tone: config.tone,
          estimatedPlayTime: config.estimated_play_time,
          openingAction: config.opening_action || null,
          config: config,
          content: content
        });

        console.log(`Loaded story: ${config.title} (${storyId})`);
      }

      console.log(`Loaded ${this.stories.size} story(ies)`);
    } catch (error) {
      console.error('Failed to load story data:', error);
      throw error;
    }
  }

  getStory(storyId) {
    return this.stories.get(storyId);
  }

  getAllStories() {
    return this.stories;
  }

  getSystemPrompt() {
    return this.systemPrompt;
  }

  getConcludingDirective() {
    return this.concludingDirective;
  }
}

module.exports = StoryManager;
