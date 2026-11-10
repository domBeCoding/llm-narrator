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
// Stop after this many tool rounds so a stuck model cannot loop forever.
// A round is one tool_use reply, the tool running, and one continuation request.
const MAX_TOOL_ROUNDS = 3;
// One extra attempt for a timeout, a dropped connection, HTTP 429 or HTTP 5xx.
// The wait is not a tool round, and it never counts towards MAX_TOOL_ROUNDS.
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_AFTER_MS = 5000;

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTimeoutError(error) {
  return error.name === 'TimeoutError' || error.name === 'AbortError';
}

// Retry-After is a delay in seconds. Anything that is not a whole number of
// seconds (including a date) keeps the default wait. The wait is capped at 5s.
function retryAfterDelayMs(response, fallbackMs) {
  const headers = response && response.headers;
  if (!headers || typeof headers.get !== 'function') return fallbackMs;
  const raw = headers.get('retry-after');
  if (raw == null) return fallbackMs;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return fallbackMs;
  return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
}

class KimiClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async _request(messages, system, { label }) {
    const first = await this._send(messages, system);
    if (first.success) return first.data;
    if (!this._isRetryable(first)) throw this._failureError(first, label);

    const reason = first.error
      ? (isTimeoutError(first.error) ? 'timeout' : 'network error')
      : `HTTP ${first.status}`;
    console.warn(`[WARN] Retrying Kimi ${label} request once (${reason})`);
    await this.sleep(first.response ? retryAfterDelayMs(first.response, this.retryDelayMs) : this.retryDelayMs);

    const second = await this._send(messages, system);
    if (second.success) return second.data;
    throw this._failureError(second, label);
  }

  async _send(messages, system) {
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
      return { success: false, error };
    }

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, response, status: response.status, errorText };
    }

    return { success: true, data: await response.json() };
  }

  _isRetryable(result) {
    if (result.error) return true;
    return result.status === 429 || (result.status >= 500 && result.status <= 599);
  }

  _failureError(result, label) {
    if (result.error) {
      if (isTimeoutError(result.error)) {
        return new Error(`Kimi API timeout after ${this.timeoutMs}ms (${label})`);
      }
      return result.error;
    }
    const where = label === 'initial' ? '' : ' on tool continuation';
    return new Error(`Kimi API error${where}: ${result.status} - ${result.errorText}`);
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

    let toolRounds = 0;
    while (data.stop_reason === 'tool_use') {
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        console.warn(`[WARN] Tool use loop hit the ${MAX_TOOL_ROUNDS}-round cap`);
        const saved = session.session.last_llm_output;
        if (saved) {
          return saved;
        }
        throw new Error(`Tool use loop hit the ${MAX_TOOL_ROUNDS}-round cap and there is no saved scene`);
      }

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

      toolRounds += 1;
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
