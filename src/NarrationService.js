const KimiClient = require('./llm/KimiClient');
const { validateStateUpdate } = require('./StateValidator');

const NARRATOR_SYSTEM = 'You are the Narrator, a Dungeon Master for interactive storytelling.';
const REQUEST_TIMEOUT_MS = 60000;
const JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/;

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
    // Tolerates Windows line endings and trailing spaces after the fence.
    const jsonMatch = response.match(JSON_BLOCK);

    let narration = response;
    let stateUpdate = null;

    if (jsonMatch) {
      try {
        stateUpdate = JSON.parse(jsonMatch[1]);
        narration = response.replace(JSON_BLOCK, '').trim();
      } catch (e) {
        console.error('Failed to parse state update JSON:', e);
      }
    }

    narration = narration.replace(/\[State updated\]/gi, '').trim();
    narration = narration.replace(/\[Thinking\]/gi, '').trim();
    narration = narration.replace(/\[.*?updated.*?\]/gi, '').trim();

    return { narration, stateUpdate };
  }

  getStoryConfig(session) {
    const story = this.storyManager && typeof this.storyManager.getStory === 'function'
      ? this.storyManager.getStory(session.session.story_id)
      : null;
    return story ? story.config : null;
  }

  // Every change the AI proposes is validated against the story config before
  // it touches the session. Rejected changes are logged and never saved.
  applyStateUpdates(session, stateUpdate, narration, userAction) {
    session.session.turn_count += 1;
    session.session.last_action_at = new Date().toISOString();
    session.session.last_llm_output = narration;

    if (userAction) {
      session.conversation_history = session.conversation_history || [];
      session.conversation_history.push({ role: 'user', content: userAction });
      session.conversation_history.push({ role: 'assistant', content: narration });
    }

    const { update, rejected } = validateStateUpdate(session, stateUpdate, this.getStoryConfig(session));
    this.logRejected(session, rejected);

    this.appendChoiceHistory(session, update);

    if (!update) return { rejected };

    if (update.characters) {
      for (const [charName, updates] of Object.entries(update.characters)) {
        Object.assign(session.characters[charName], updates);
      }
    }

    if (update.reader) {
      Object.assign(session.reader, update.reader);
    }

    if (update.story) {
      const { plot_beats_hit: beats, flags, ...fields } = update.story;
      if (beats) {
        session.story.plot_beats_hit = session.story.plot_beats_hit || [];
        session.story.plot_beats_hit.push(...beats);
      }
      if (flags) {
        session.story.flags = session.story.flags || {};
        Object.assign(session.story.flags, flags);
      }
      Object.assign(session.story, fields);
    }

    if (update.world) {
      if (update.world.locations) {
        for (const [locName, updates] of Object.entries(update.world.locations)) {
          Object.assign(session.world.locations[locName], updates);
        }
      }
      if (update.world.village_awareness) {
        Object.assign(session.world.village_awareness, update.world.village_awareness);
      }
    }

    return { rejected };
  }

  // Logs what was dropped and why. Only the AI's proposed values are logged
  // (shortened); nothing from the environment or credentials.
  logRejected(session, rejected) {
    if (!rejected || rejected.length === 0) return;
    const sessionId = session.session && session.session.session_id;
    for (const item of rejected) {
      console.warn(`[state-validation] session=${sessionId} turn=${session.session.turn_count} rejected ${item.path}=${item.value}: ${item.reason}`);
    }
  }

  // The prompt asks for `choice_history`; older replies and the design doc use
  // `choice_log`. Accept either, as a single entry or a list of entries. The
  // turn number always comes from the code, never from the model.
  appendChoiceHistory(session, stateUpdate) {
    session.choice_history = session.choice_history || [];
    const choiceData = stateUpdate && (stateUpdate.choice_history ?? stateUpdate.choice_log);
    const entries = (Array.isArray(choiceData) ? choiceData : [choiceData])
      .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry));

    // Only record a choice when the AI reported one. Small talk such as "hi"
    // is not a choice and leaves no entry.
    for (const entry of entries) {
      session.choice_history.push({ ...entry, turn: session.session.turn_count });
    }
  }
}

module.exports = NarrationService;
