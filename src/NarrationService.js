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

const KIMI_ENDPOINT = 'https://api.kimi.com/coding/v1/messages';
const KIMI_SYSTEM = 'You are the Narrator, a Dungeon Master for interactive storytelling.';
const REQUEST_TIMEOUT_MS = 60000;

class NarrationService {
  constructor(storyManager, apiKey, options = {}) {
    this.storyManager = storyManager;
    this.apiKey = apiKey;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * Issues a single request to Kimi, aborting if it exceeds the timeout.
   */
  async _request(messages, system, { label }) {
    let response;
    try {
      response = await fetch(KIMI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'kimi-k2',
          system: system,
          messages: messages,
          tools: TOOLS,
          temperature: 0.7,
          max_tokens: 4000
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new Error(`Kimi API timeout after ${this.timeoutMs}ms (${label})`);
      }
      throw error;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Kimi API error${label === 'initial' ? '' : ' on tool continuation'}: ${response.status} - ${error}`);
    }

    return response.json();
  }

  buildPrompt(session, userAction) {
    const story = this.storyManager.getStory(session.session.story_id);
    const stateSummary = JSON.stringify(session, null, 2);

    let concludingDirective = '';
    if (session.session.status === 'concluding') {
      const template = this.storyManager.getConcludingDirective() || '';
      concludingDirective = '\n\n---\n\n' + template;
    }

    const systemContext = `${KIMI_SYSTEM}\n\n${this.storyManager.getSystemPrompt()}\n\n---\n\n## Story Context\n\n${story.content}\n\n---\n\n## Story Config (Mechanical Rules)\n\n\`\`\`json\n${JSON.stringify(story.config, null, 2)}\n\`\`\``;

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

  async callKimi(prompt, session) {
    const { systemContext, userMessage } = prompt;
    const history = session.conversation_history || [];
    const messages = [
      ...history.map(entry => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: userMessage }
    ];

    let data = await this._request(messages, systemContext, { label: 'initial' });
    console.log('[DEBUG] Kimi response received, stop_reason:', data.stop_reason);

    // Handle tool calls
    while (data.stop_reason === 'tool_use') {
      const toolUseBlock = data.content.find(block => block.type === 'tool_use');

      if (!toolUseBlock) {
        console.error('[ERROR] Tool use indicated but no tool_use block found');
        break;
      }

      console.log(`[DEBUG] Tool call: ${toolUseBlock.name}`, toolUseBlock.input);

      let toolResult;
      if (toolUseBlock.name === 'get_last_narration') {
        toolResult = session.session.last_llm_output || 'No previous narration found.';
        console.log('[DEBUG] Returning last narration, length:', toolResult.length);
      } else {
        toolResult = `Unknown tool: ${toolUseBlock.name}`;
      }

      messages.push({
        role: 'assistant',
        content: data.content
      });

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

      data = await this._request(messages, systemContext, { label: 'tool continuation' });
      console.log('[DEBUG] Kimi continuation response, stop_reason:', data.stop_reason);
    }

    if (data.content && Array.isArray(data.content) && data.content.length > 0) {
      const textBlock = data.content.find(block => block.type === 'text');
      if (textBlock) {
        return textBlock.text;
      }
    }

    console.error('[ERROR] No text block in Kimi response');
    throw new Error('No text response from Kimi');
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
