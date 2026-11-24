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

// A turn is a user message plus the following assistant message, counted from
// the start of the saved history. Up to PROMPT_HISTORY_TURNS + PROMPT_HISTORY_STEP
// turns (16) the prompt gets every message word for word. Above that, the cut
// advances by PROMPT_HISTORY_STEP turns, so the cached prefix stays put until
// the next step: drop the first
// floor((turns - PROMPT_HISTORY_TURNS) / PROMPT_HISTORY_STEP) * PROMPT_HISTORY_STEP
// turns. The saved conversation_history is never shortened.
const PROMPT_HISTORY_TURNS = 8;
const PROMPT_HISTORY_STEP = 8;
const RECAP_LABEL = 'Recap of earlier turns, not a new reader action.';
const RECAP_STATE_LINE = 'Current flags, plot beats and secrets are in the Current Session State below.';
// The narration line is `Turn N narration:` plus this excerpt. 200 is the
// maximum, and the three dots of a clip count toward it.
const NARRATION_EXCERPT_MAX = 200;
const NARRATION_ELLIPSIS = '...';
// The first sentence runs through the first `.`, `!` or `?`. The period in
// Mr., Mrs., Ms., Dr. and St. does not end it, in any letter case, and only
// when that title is a whole word. A closing quote or bracket straight after
// that mark is kept: straight and curly quotes, ) and ]. With no mark, the
// whole text is used. The `i` flag is for the titles: the rest has no letters.
const FIRST_SENTENCE = /^[\s\S]+?(?:(?:(?<!\b(?:Mr|Mrs|Ms|Dr|St))\.)|[!?])[.!?]*["'\u201C\u201D\u2018\u2019)\]]*(?=\s|$)/i;

// A flag that is absent or undefined counts as false, so an old save that
// never stored the key still meets a condition expecting false. A condition
// expecting true still fails when the key is missing.
function flagMatches(flags, name, expected) {
  if (!flags || flags[name] === undefined) return expected === false;
  return flags[name] === expected;
}

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
    // Optional clock for tests. A function or a millisecond timestamp.
    // Absent means Date.now, read when the prompt is built.
    this.now = options.now;
  }

  get apiKey() {
    return this.llmClient ? this.llmClient.apiKey : undefined;
  }

  set apiKey(value) {
    if (this.llmClient) {
      this.llmClient.apiKey = value;
    }
  }

  buildPrompt(session, userAction, options) {
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

    const actNumber = session.story && session.story.current_act;
    const storyText = typeof this.storyManager.getStoryContentForAct === 'function'
      ? this.storyManager.getStoryContentForAct(session.session.story_id, actNumber)
      : story.content;

    const systemContext = `${NARRATOR_SYSTEM}\n\n${this.storyManager.getSystemPrompt()}\n\n---\n\n## Story Context\n\n${storyText}\n\n---\n\n## Story Config (Mechanical Rules)\n\n\`\`\`json\n${JSON.stringify(story.config, null, 2)}\n\`\`\``;

    // Only the current user message. History, the recap and the system
    // message stay as they are, and so does TURN_INSTRUCTION.
    const nowSource = options && options.now != null ? options.now : this.now;
    const minutesLine = minutesSinceLastActionLine(session, resolveNowMs(nowSource));
    const readerAction = minutesLine == null ? userAction : `${userAction}\n${minutesLine}`;

    const userMessage = `## Current Session State\n\n\`\`\`json\n${stateSummary}\n\`\`\`\n\n---\n\n## Reader's Action\n\n${readerAction}${concludingDirective}\n\n---\n\n${TURN_INSTRUCTION}`;

    return { systemContext, userMessage, history: this.historyForPrompt(session) };
  }

  // Messages to send before the current reader action. Copies only: the saved
  // history and its entries stay as they are. Histories of 16 turns or fewer
  // are sent whole. Longer ones drop a step of whole turns and attach one
  // recap. If the first kept message is from the user, the recap is written
  // into that message so two user messages are not sent in a row. If it is
  // from the assistant, the recap stays its own user message.
  historyForPrompt(session) {
    const history = session && Array.isArray(session.conversation_history)
      ? session.conversation_history
      : [];
    const messages = history.map(messageForPrompt);
    const turns = indexTurns(messages);
    const cut = turnsToCut(turns.length);
    if (cut === 0) return messages;

    const dropped = new Set();
    for (let t = 0; t < cut; t++) {
      for (let i = turns[t].start; i < turns[t].end; i++) dropped.add(i);
    }
    const kept = [];
    for (let i = 0; i < messages.length; i++) {
      if (!dropped.has(i)) kept.push(messages[i]);
    }

    const recap = recapEarlierTurns(session, cut);
    if (kept.length > 0 && kept[0].role === 'user') {
      kept[0] = {
        role: 'user',
        content: `${recap}\n\n---\n\n${kept[0].content}`,
      };
      return kept;
    }
    return [{ role: 'user', content: recap }, ...kept];
  }

  // The session state as the AI sees it in the final user message. Earlier
  // turns are already sent once as chat messages, so conversation_history is
  // left out here, and so is last_llm_output, which repeats the last of them
  // (get_last_narration reads it from the session itself). Cut turns are in
  // the recap and recent turns are in the history, so choice_history in this
  // copy keeps only the last PROMPT_HISTORY_TURNS entries. The saved session
  // is not changed, and nothing else in the state is either.
  stateForPrompt(session) {
    const { conversation_history, ...state } = session;
    if (Array.isArray(state.choice_history) && state.choice_history.length > PROMPT_HISTORY_TURNS) {
      state.choice_history = state.choice_history.slice(-PROMPT_HISTORY_TURNS);
    }
    if (!state.session) return state;
    const { last_llm_output, ...meta } = state.session;
    return { ...state, session: meta };
  }

  // all_required must all match. hold_while, when present, is a list of
  // groups in the same shape. If every condition in any group matches, the
  // story is not over yet. A config with no hold_while ends as before.
  evaluateEndConditions(session, config) {
    if (!config || !config.end_conditions || !config.end_conditions.all_required) {
      return false;
    }
    const met = (cond) => {
      if (cond.flag) {
        return flagMatches(session.story.flags, cond.flag, cond.value);
      }
      if (cond.character) {
        return session.characters[cond.character] &&
          session.characters[cond.character][cond.field] === cond.value;
      }
      return false;
    };
    if (!config.end_conditions.all_required.every(met)) return false;
    const holdWhile = config.end_conditions.hold_while;
    if (Array.isArray(holdWhile) && holdWhile.some(group => Array.isArray(group) && group.length > 0 && group.every(met))) {
      return false;
    }
    return true;
  }

  // Every variant whose conditions all match, in config order. The same rule
  // as the playthrough tests: a variant matches only when every condition's
  // flag has the required value. A missing flag counts as false. There is no
  // precedence list.
  matchEndingVariants(session, config) {
    const variants = config && Array.isArray(config.ending_variants) ? config.ending_variants : [];
    const flags = session && session.story && session.story.flags ? session.story.flags : {};
    return variants
      .filter(variant => variant && Array.isArray(variant.conditions)
        && variant.conditions.every(cond => flagMatches(flags, cond.flag, cond.value)))
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

// Whole minutes from the previous last_action_at to now. That field is still
// the previous message's time here: applyStateUpdates stamps it before this
// turn is applied. A missing or invalid timestamp leaves the line out.
function minutesSinceLastActionLine(session, nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
  const raw = session && session.session ? session.session.last_action_at : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const then = Date.parse(raw);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.floor((nowMs - then) / 60000);
  if (!Number.isFinite(minutes)) return null;
  return `Minutes since the last action: ${minutes < 0 ? 0 : minutes}`;
}

function resolveNowMs(now) {
  if (now == null) return Date.now();
  try {
    const value = typeof now === 'function' ? now() : now;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  } catch {
    return null;
  }
}

function messageForPrompt(entry) {
  return { role: entry.role, content: entry.content };
}

// Whole turns only. A user message with no following assistant reply, or any
// other unpaired message, is not a turn and is left where it is.
function indexTurns(messages) {
  const turns = [];
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role === 'user' && i + 1 < messages.length && messages[i + 1].role === 'assistant') {
      turns.push({ start: i, end: i + 2 });
      i += 2;
    } else {
      i += 1;
    }
  }
  return turns;
}

function turnsToCut(turnCount) {
  if (turnCount <= PROMPT_HISTORY_TURNS + PROMPT_HISTORY_STEP) return 0;
  return Math.floor((turnCount - PROMPT_HISTORY_TURNS) / PROMPT_HISTORY_STEP) * PROMPT_HISTORY_STEP;
}

// Copy a state value into the recap. Only strings and numbers, so the recap
// cannot invent a description of anything else.
function asStateText(value) {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function choiceLine(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const turn = asStateText(entry.turn);
  const action = asStateText(entry.action);
  const consequence = asStateText(entry.consequence);
  let event = null;
  if (action !== null && consequence !== null) event = `${action} -> ${consequence}`;
  else if (action !== null) event = action;
  else if (consequence !== null) event = consequence;
  if (turn !== null && event !== null) return `Turn ${turn}: ${event}`;
  if (turn !== null) return `Turn ${turn}`;
  return event;
}

// Choices for turns that are still in the prompt stay out of the recap, so a
// new turn does not rewrite the cached prefix. Entries with no turn number
// have nowhere else to go, so they stay in the recap.
function choiceLines(session, cutTurns) {
  const entries = session && Array.isArray(session.choice_history) ? session.choice_history : [];
  const lines = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.turn === 'number' && entry.turn > cutTurns) continue;
    const line = choiceLine(entry);
    if (line !== null) lines.push(line);
  }
  return lines;
}

// Turn number written by choiceLine, or null when the line has none.
function choiceTurnNumber(line) {
  const match = /^Turn (\d+)(?:: |$)/.exec(line);
  if (!match) return null;
  const turn = Number(match[1]);
  return Number.isInteger(turn) ? turn : null;
}

// Same stripping as parseResponse. Saved history usually already stores the
// narration with the state block removed. A reply that still contains a
// fenced JSON block, or the bracket markers parseResponse drops, is cleaned
// again here so the excerpt cannot pick up that state update.
function narrationText(content) {
  if (typeof content !== 'string') return '';
  let text = content.replace(JSON_BLOCK, '').trim();
  text = text.replace(/\[State updated\]/gi, '').trim();
  text = text.replace(/\[Thinking\]/gi, '').trim();
  text = text.replace(/\[.*?updated.*?\]/gi, '').trim();
  return text;
}

// First sentence of a cut turn's saved assistant reply. Empty once the state
// block is gone means there is no narration line.
function narrationExcerpt(content) {
  const text = narrationText(content);
  if (text === '') return null;
  const matched = text.match(FIRST_SENTENCE);
  const sentence = (matched ? matched[0] : text).trim();
  if (sentence === '') return null;
  // Count by code point, as tidyReaderName does, so a character on the cut
  // is kept or dropped whole. The ellipsis counts toward the 200. Do not
  // trim after the cut: this is an excerpt, not a name.
  const points = Array.from(sentence);
  if (points.length <= NARRATION_EXCERPT_MAX) return sentence;
  return points.slice(0, NARRATION_EXCERPT_MAX - NARRATION_ELLIPSIS.length).join('') + NARRATION_ELLIPSIS;
}

// Narration lines for cut turns 1..cutTurns, keyed by that turn number.
// indexTurns counts reader-and-reply pairs, which is the same numbering the
// choice lines use.
function narrationLinesByTurn(session, cutTurns) {
  const history = session && Array.isArray(session.conversation_history)
    ? session.conversation_history
    : [];
  const turns = indexTurns(history);
  const byTurn = new Map();
  const limit = Math.min(cutTurns, turns.length);
  for (let index = 0; index < limit; index++) {
    const message = history[turns[index].start + 1];
    const excerpt = narrationExcerpt(message && message.content);
    if (excerpt === null) continue;
    const turn = index + 1;
    byTurn.set(turn, `Turn ${turn} narration: ${excerpt}`);
  }
  return byTurn;
}

// One block per cut turn, in turn order: the choice line for that turn, when
// there is one, then `Turn N narration:` and the excerpt under it. A cut turn
// with no choice still gets the narration line. A choice with no turn number
// stays, placed after the numbered turn it follows in choice_history (or at
// the top, if it precedes every numbered turn). Flags, plot beats and secrets
// stay out. They already travel in the session state, and copying them would
// change this prefix whenever they change. The text depends only on the cut.
function recapEarlierTurns(session, cutTurns) {
  const choicesByTurn = new Map();
  const unnumberedAfter = new Map();
  unnumberedAfter.set(0, []);
  let lastTurn = 0;
  for (const line of choiceLines(session, cutTurns)) {
    const turn = choiceTurnNumber(line);
    if (turn !== null && turn >= 1 && turn <= cutTurns) {
      if (!choicesByTurn.has(turn)) choicesByTurn.set(turn, []);
      choicesByTurn.get(turn).push(line);
      lastTurn = turn;
    } else {
      if (!unnumberedAfter.has(lastTurn)) unnumberedAfter.set(lastTurn, []);
      unnumberedAfter.get(lastTurn).push(line);
    }
  }

  const narrationByTurn = narrationLinesByTurn(session, cutTurns);
  const lines = [];
  for (const line of unnumberedAfter.get(0)) lines.push(line);
  for (let turn = 1; turn <= cutTurns; turn++) {
    for (const line of choicesByTurn.get(turn) || []) lines.push(line);
    const narration = narrationByTurn.get(turn);
    if (narration) lines.push(narration);
    for (const line of unnumberedAfter.get(turn) || []) lines.push(line);
  }
  const body = lines.length ? `${lines.join('\n')}\n\n` : '';
  return `${RECAP_LABEL}\n\n${body}${RECAP_STATE_LINE}`;
}

module.exports = NarrationService;
module.exports.PROMPT_HISTORY_TURNS = PROMPT_HISTORY_TURNS;
module.exports.PROMPT_HISTORY_STEP = PROMPT_HISTORY_STEP;
