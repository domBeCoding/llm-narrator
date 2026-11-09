const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-1.14.0';
const JUNK_NOUL_THRESHOLD = 0.7;
const JEV_TIMEOUT_MS = 2500;

// One yes/no question. A high Noul means the message is junk. Criteria spell
// out the two sides so short real actions are not treated as mash.
const JUNK_QUESTION = {
  type: 'noul',
  instructions: 'Is this unintelligible junk (keyboard mashing, random characters, or nonsense with no intended meaning)?',
  criteria: {
    true: 'Keyboard mashing, random characters, or nonsense with no intended meaning.',
    false: 'A genuine attempt to play or talk to the narrator, including a healthcheck, continue, yes, and short real actions such as look, wait, or flask.',
  },
};

class JevClient {
  constructor({ apiKey = null, timeoutMs = JEV_TIMEOUT_MS, fetchImpl } = {}) {
    this.apiKey = apiKey || null;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async isJunk(message) {
    if (!this.apiKey) {
      console.warn('TypeSafe API key is missing. Letting the message through.');
      return false;
    }

    const fetchImpl = this.fetchImpl || globalThis.fetch;
    let response;
    try {
      response = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: JEV_MODEL,
          state: {
            note: 'This is a player message in an interactive story.',
            message,
          },
          questions: {
            is_junk: JUNK_QUESTION,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error && error.name ? error.name : 'Error';
      console.warn(`Jev junk check failed (${reason}). Letting the message through.`);
      return false;
    }

    if (!response || response.ok !== true) {
      const status = response && response.status ? response.status : 'error';
      console.warn(`Jev junk check returned HTTP ${status}. Letting the message through.`);
      return false;
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      console.warn('Jev junk check returned unreadable JSON. Letting the message through.');
      return false;
    }

    const noul = data && data.answers && data.answers.is_junk
      ? data.answers.is_junk.noul
      : undefined;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
      console.warn('Jev junk check returned no Noul. Letting the message through.');
      return false;
    }

    return noul > JUNK_NOUL_THRESHOLD;
  }
}

module.exports = {
  JevClient,
  JEV_ENDPOINT,
  JEV_MODEL,
  JUNK_NOUL_THRESHOLD,
  JEV_TIMEOUT_MS,
};
