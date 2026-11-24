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

  // Preamble (title, world, characters, story structure heading) plus the
  // requested act, then any trailing notes after the last act. Later acts are
  // left out. A missing act number, or a heading that is not in the file,
  // falls back to the full story and logs a warning. The notes are already in
  // that full file, so they are not appended again.
  getStoryContentForAct(storyId, actNumber) {
    const story = this.getStory(storyId);
    if (!story) {
      console.warn(`[story] story=${storyId} is not loaded; sending no story text`);
      return '';
    }
    const trimmed = storyContentForAct(story.content, actNumber);
    if (trimmed == null) {
      const shown = actNumber === undefined || actNumber === null || actNumber === ''
        ? 'missing'
        : String(actNumber);
      console.warn(`[story] story=${storyId} current_act=${shown} has no matching heading; sending the full story`);
      return story.content;
    }
    return trimmed;
  }
}

// Splits on lines that begin `### Act N`. Returns null when the act cannot
// be selected, so the caller falls back to the full file.
function storyContentForAct(content, actNumber) {
  const act = Number(actNumber);
  const headings = [];
  const actHeading = /^### Act (\d+)\b.*$/gm;
  let match;
  while ((match = actHeading.exec(content)) !== null) {
    headings.push({ number: Number(match[1]), index: match.index });
  }
  if (!Number.isInteger(act) || act < 1 || headings.length === 0) return null;

  const found = headings.findIndex(heading => heading.number === act);
  if (found === -1) return null;

  const preamble = content.slice(0, headings[0].index);
  const start = headings[found].index;
  const notesAt = topLevelHeadingAfter(content, headings[headings.length - 1].index);
  let end;
  if (found + 1 < headings.length) {
    end = headings[found + 1].index;
  } else {
    // The last act still stops at the next top-level `## ` heading. Trailing
    // notes, when the story has them, are appended below for every act.
    end = notesAt === -1 ? content.length : notesAt;
  }
  const actText = preamble + content.slice(start, end);
  if (notesAt === -1) return actText;
  return actText + content.slice(notesAt);
}

// Index of the first top-level `## ` heading after `fromIndex`, or -1 when
// the story has no trailing notes. `### Act` headings do not match.
function topLevelHeadingAfter(content, fromIndex) {
  const topLevel = /^## /gm;
  topLevel.lastIndex = fromIndex;
  const next = topLevel.exec(content);
  return next ? next.index : -1;
}

module.exports = StoryManager;
