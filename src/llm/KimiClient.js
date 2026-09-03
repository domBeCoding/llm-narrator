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
const REQUEST_TIMEOUT_MS = 60000;

class KimiClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

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

  async call(prompt, session) {
    const { systemContext, userMessage } = prompt;
    const history = session.conversation_history || [];
    const messages = [
      ...history.map(entry => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: userMessage }
    ];

    let data = await this._request(messages, systemContext, { label: 'initial' });
    console.log('[DEBUG] Kimi response received, stop_reason:', data.stop_reason);

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
}

module.exports = KimiClient;
