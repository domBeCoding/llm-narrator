const KimiClient = require('./llm/KimiClient');

const NARRATOR_SYSTEM = 'You are the Narrator, a Dungeon Master for interactive storytelling.';
const REQUEST_TIMEOUT_MS = 60000;

const PROVIDERS = {
  kimi: KimiClient,
};

class NarrationService {
  constructor(storyManager, apiKey, options = {}) {
    this.storyManager = storyManager;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const provider = options.provider || 'kimi';
    const ClientClass = PROVIDERS[provider];
    if (!ClientClass) {
      throw new Error(`Unknown LLM provider: ${provider}`);
    }
    this.llmClient = options.llmClient || new ClientClass(apiKey, { timeoutMs: this.timeoutMs });
  }

  get apiKey() {
    return this.llmClient ? this.llmClient.apiKey : undefined;
  }

  set apiKey(value) {
    if (this.llmClient) {
      this.llmClient.apiKey = value;
    }
  }

  buildPrompt(session, userAction) {
    const story = this.storyManager.getStory(session.session.story_id);
    const stateSummary = JSON.stringify(session, null, 2);

    let concludingDirective = '';
    if (session.session.status === 'concluding') {
      const template = this.storyManager.getConcludingDirective() || '';
      concludingDirective = '\n\n---\n\n' + template;
    }

    const systemContext = `${NARRATOR_SYSTEM}\n\n${this.storyManager.getSystemPrompt()}\n\n---\n\n## Story Context\n\n${story.content}\n\n---\n\n## Story Config (Mechanical Rules)\n\n\`\`\`json\n${JSON.stringify(story.config, null, 2)}\n\`\`\``;

    const userMessage = `## Current Session State\n\n\`\`\`json\n${stateSummary}\n\`\`\`\n\n---\n\n## Reader's Action\n\n${userAction}${concludingDirective}\n\n---\n\nGenerate the narration response following the format specified in the system prompt. Include the story, divider, summary prompt, and choices. After the narration, include a JSON block with state updates.`;

    return { systemContext, userMessage };
  }

  evaluateEndConditions(session, config) {
    if (!config || !config.end_conditions || !config.end_conditions.all_required) {
      return false;
    }
    return config.end_conditions.all_required.every(cond => {
      if (cond.flag) {
        return session.story.flags[cond.flag] === cond.value;
      }
      if (cond.character) {
        return session.characters[cond.character] &&
          session.characters[cond.character][cond.field] === cond.value;
      }
      return false;
    });
  }

  async callLLM(prompt, session) {
    return this.llmClient.call(prompt, session);
  }

  parseResponse(response) {
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

  applyStateUpdates(session, stateUpdate, narration, userAction) {
    session.session.turn_count += 1;
    session.session.last_action_at = new Date().toISOString();
    session.session.last_llm_output = narration;

    if (userAction) {
      session.conversation_history = session.conversation_history || [];
      session.conversation_history.push({ role: 'user', content: userAction });
      session.conversation_history.push({ role: 'assistant', content: narration });
    }

    if (!stateUpdate) return;

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
  }
}

module.exports = NarrationService;
