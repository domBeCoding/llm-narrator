const KimiClient = require('./llm/KimiClient');
const { validateStateUpdate } = require('./StateValidator');

const NARRATOR_SYSTEM = 'You are the Narrator, a Dungeon Master for interactive storytelling.';
const REQUEST_TIMEOUT_MS = 60000;
// The language tag matches in any case. Windows line endings and spaces after
// the tag are tolerated.
const JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i;

// Closes every user message. It is the same text every turn, so the prompt
// stays cacheable; the AI, not the code, decides which case the message is.
const TURN_INSTRUCTION = 'If the reader\'s action is a story action, reply in the format the system prompt sets out: the story, the divider, the summary prompt and the choices, then a JSON block with the state updates. If an ending directive appears above, follow its format for the story action instead. If the message is a healthcheck or needs clarification, follow the Error Handling rules in the system prompt: reply in character with no choices and no JSON block. If the reader asks to resume after a healthcheck, call `get_last_narration` and present the narration it returns exactly as it is, with no JSON block.';

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
    this.llmClient = options.llmClient || new ClientClass(apiKey, {
      timeoutMs: this.timeoutMs,
      retryDelayMs: options.retryDelayMs,
      sleep: options.sleep,
    });
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
    const stateSummary = JSON.stringify(this.stateForPrompt(session), null, 2);

    let concludingDirective = '';
    if (session.session.status === 'concluding') {
      const template = this.storyManager.getConcludingDirective() || '';
      const chosen = this.chosenEndingText(session);
      const filled = template.includes('{chosen_endings}')
        ? template.split('{chosen_endings}').join(chosen)
        : `${template}\n\n${chosen}`;
      concludingDirective = '\n\n---\n\n' + filled;
    }

    const systemContext = `${NARRATOR_SYSTEM}\n\n${this.storyManager.getSystemPrompt()}\n\n---\n\n## Story Context\n\n${story.content}\n\n---\n\n## Story Config (Mechanical Rules)\n\n\`\`\`json\n${JSON.stringify(story.config, null, 2)}\n\`\`\``;

    const userMessage = `## Current Session State\n\n\`\`\`json\n${stateSummary}\n\`\`\`\n\n---\n\n## Reader's Action\n\n${userAction}${concludingDirective}\n\n---\n\n${TURN_INSTRUCTION}`;

    return { systemContext, userMessage };
  }

  // The session state as the AI sees it in the final user message. Earlier
  // turns are already sent once as chat messages, so conversation_history is
  // left out here, and so is last_llm_output, which repeats the last of them
  // (get_last_narration reads it from the session itself). Works on a copy so
  // the saved session keeps both.
  stateForPrompt(session) {
    const { conversation_history, ...state } = session;
    if (!state.session) return state;
    const { last_llm_output, ...meta } = state.session;
    return { ...state, session: meta };
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

  // Every variant whose conditions all match, in config order. The same rule
  // as the playthrough tests: a variant matches only when every condition's
  // flag has the required value. There is no precedence list.
  matchEndingVariants(session, config) {
    const variants = config && Array.isArray(config.ending_variants) ? config.ending_variants : [];
    const flags = session && session.story && session.story.flags ? session.story.flags : {};
    return variants
      .filter(variant => variant && Array.isArray(variant.conditions)
        && variant.conditions.every(cond => flags[cond.flag] === cond.value))
      .map(variant => variant.id);
  }

  // Called once, when the story first moves from active to concluding.
  // Saves every match, or leaves null and warns when nothing matches.
  // The concluding turn keeps whatever this wrote.
  recordEnding(session, config) {
    const matched = this.matchEndingVariants(session, config);
    if (matched.length === 0) {
      session.session.ending_variant = null;
      const sessionId = session.session && session.session.session_id;
      console.warn(`[ending] session=${sessionId} no ending variant matched the current flags`);
      return null;
    }
    session.session.ending_variant = matched;
    return matched;
  }

  recordedEndingIds(session) {
    const value = session.session && session.session.ending_variant;
    return Array.isArray(value) ? value : [];
  }

  // Names the endings already stored on the session, with their config
  // descriptions, so the model weaves that ending instead of choosing one.
  chosenEndingText(session) {
    const ids = this.recordedEndingIds(session);
    if (ids.length === 0) {
      return 'No ending variant matched the current flags. Write the closing scene from the current state. Do not choose an ending yourself.';
    }
    const story = this.storyManager.getStory(session.session.story_id);
    const variants = story && story.config && Array.isArray(story.config.ending_variants)
      ? story.config.ending_variants
      : [];
    const byId = new Map(variants.filter(variant => variant && variant.id).map(variant => [variant.id, variant]));
    const lines = ids.map(id => {
      const variant = byId.get(id);
      const description = variant && typeof variant.description === 'string' ? variant.description : '';
      return description ? `- \`${id}\`: ${description}` : `- \`${id}\``;
    });
    return ['Recorded ending:', ...lines].join('\n');
  }

  async callLLM(prompt, session) {
    return this.llmClient.call(prompt, session);
  }

  parseResponse(response) {
    const jsonMatch = response.match(JSON_BLOCK);

    let narration = response;
    let stateUpdate = null;

    if (jsonMatch) {
      // Remove the block before parsing so broken JSON never reaches the
      // player. Unusable JSON leaves stateUpdate null.
      narration = response.replace(JSON_BLOCK, '').trim();
      try {
        stateUpdate = JSON.parse(jsonMatch[1]);
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
    session.session.last_action_at = new Date().toISOString();
    // Only a story turn counts as a turn and replaces the scene
    // get_last_narration gives back. The system prompt has the AI send a state
    // block with every story turn and none with a clarification, healthcheck
    // or resume reply, so a reply without one keeps the count and the earlier
    // scene.
    if (stateUpdate) {
      session.session.turn_count += 1;
      session.session.last_llm_output = narration;
    }

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
