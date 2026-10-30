// Checks the state changes the AI proposes each turn against the story config
// (stories/<story>-config.json) and the current session before anything is
// saved. The AI proposes; the code decides.
//
// Granularity: each change is checked on its own. A bad change is dropped and
// reported; the valid changes from the same reply are kept. Only a block that
// is not a JSON object at all is rejected as a whole. One wrongly worded field
// should not throw away the rest of a turn (for example losing
// `moonpetal_obtained: true` because a mood was misspelt).
//
// Rules only apply when the story config defines them (flags, plot_beats,
// locations, characters, state_rules). The session's existing shape is always
// enforced: the AI can change values but not add fields.

const MAX_STRING_LENGTH = 500;
const MAX_LIST_LENGTH = 50;

const CHARACTER_LIST_FIELDS = new Set(['revealed_secrets']);
const READER_APPEND_ONLY_LISTS = new Set(['knowledge']);
const READER_REPLACE_LISTS = new Set(['inventory', 'skills']);
const READER_CODE_OWNED = new Set(['name']);
const STORY_FIELDS = new Set(['plot_beats_hit', 'flags', 'current_act', 'current_scene', 'act_progress']);
const LOCATION_FIELDS = {
  status: 'string',
  notable_changes: 'string',
  visited: 'boolean',
  visit_count: 'integer',
  last_visited: 'string',
};
const TOP_LEVEL_KEYS = new Set(['reader', 'characters', 'story', 'world', 'choice_history', 'choice_log']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function checkString(value) {
  if (typeof value !== 'string') return 'must be text';
  if (value.trim() === '') return 'must not be empty';
  if (value.length > MAX_STRING_LENGTH) return `must be at most ${MAX_STRING_LENGTH} characters`;
  return null;
}

function checkStringList(value) {
  if (!Array.isArray(value)) return 'must be a list of text values';
  if (value.length > MAX_LIST_LENGTH) return `must have at most ${MAX_LIST_LENGTH} items`;
  for (const item of value) {
    const problem = checkString(item);
    if (problem) return `every item ${problem}`;
  }
  return null;
}

function checkAllowed(value, allowed) {
  if (!Array.isArray(allowed)) return null;
  if (!allowed.includes(value)) return `must be one of: ${allowed.join(', ')}`;
  return null;
}

// Scalar fields keep the type they already have in the session. A field that
// is currently null (for example last_visited) accepts text.
function checkSameType(existing, value) {
  if (existing === null || existing === undefined) return checkString(value);
  if (typeof existing === 'string') return checkString(value);
  if (typeof value !== typeof existing) return `must be a ${typeof existing}`;
  return null;
}

function union(existing, additions) {
  const result = Array.isArray(existing) ? [...existing] : [];
  for (const item of additions) {
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

function actNumbers(config) {
  if (!config || !isPlainObject(config.plot_beats)) return null;
  const acts = Object.keys(config.plot_beats)
    .map(key => Number((key.match(/^act_(\d+)$/) || [])[1]))
    .filter(Number.isInteger);
  return acts.length ? acts : null;
}

function beatAct(config, beat) {
  for (const [key, beats] of Object.entries(config.plot_beats)) {
    if (Array.isArray(beats) && beats.includes(beat)) {
      const n = Number((key.match(/^act_(\d+)$/) || [])[1]);
      return Number.isInteger(n) ? n : null;
    }
  }
  return undefined;
}

class Collector {
  constructor() {
    this.rejected = [];
  }

  reject(path, value, reason) {
    this.rejected.push({ path, value: describe(value), reason });
  }
}

// Accept both shapes: top level (what the prompt asks for) and the
// `{ "state_update": { ... } }` wrapper shown in older design docs.
function unwrap(stateUpdate, out) {
  if (isPlainObject(stateUpdate) && isPlainObject(stateUpdate.state_update)) {
    for (const key of Object.keys(stateUpdate)) {
      if (key !== 'state_update') out.reject(key, stateUpdate[key], 'ignored outside the state_update wrapper');
    }
    return stateUpdate.state_update;
  }
  return stateUpdate;
}

function validateCharacters(session, input, config, out) {
  const result = {};
  const rules = (config && config.state_rules && config.state_rules.character_fields) || {};
  const knownCharacters = config && Array.isArray(config.characters) ? config.characters : null;
  const knownLocations = config && Array.isArray(config.locations) ? config.locations : null;

  for (const [name, updates] of Object.entries(input)) {
    const path = `characters.${name}`;
    const current = session.characters && session.characters[name];
    if (!current || (knownCharacters && !knownCharacters.includes(name))) {
      out.reject(path, updates, 'unknown character');
      continue;
    }
    if (!isPlainObject(updates)) {
      out.reject(path, updates, 'must be an object of field changes');
      continue;
    }
    const clean = {};
    for (const [field, value] of Object.entries(updates)) {
      const fieldPath = `${path}.${field}`;
      if (!(field in current)) {
        out.reject(fieldPath, value, 'unknown field; the state schema is fixed');
        continue;
      }
      if (CHARACTER_LIST_FIELDS.has(field)) {
        const problem = checkStringList(value);
        if (problem) {
          out.reject(fieldPath, value, problem);
          continue;
        }
        // Secrets cannot be un-revealed: merge, never shrink.
        clean[field] = union(current[field], value);
        continue;
      }
      let problem = checkSameType(current[field], value);
      if (!problem && field === 'location' && knownLocations) problem = checkAllowed(value, knownLocations);
      if (!problem && rules[field]) problem = checkAllowed(value, rules[field]);
      if (problem) {
        out.reject(fieldPath, value, problem);
        continue;
      }
      clean[field] = value;
    }
    if (Object.keys(clean).length) result[name] = clean;
  }
  return result;
}

function validateReader(session, input, config, out) {
  const clean = {};
  const current = session.reader || {};
  const knownLocations = config && Array.isArray(config.locations) ? config.locations : null;

  for (const [field, value] of Object.entries(input)) {
    const path = `reader.${field}`;
    if (READER_CODE_OWNED.has(field)) {
      out.reject(path, value, 'set by the application, not the AI');
      continue;
    }
    if (!(field in current)) {
      out.reject(path, value, 'unknown field; the state schema is fixed');
      continue;
    }
    if (READER_APPEND_ONLY_LISTS.has(field) || READER_REPLACE_LISTS.has(field)) {
      const problem = checkStringList(value);
      if (problem) {
        out.reject(path, value, problem);
        continue;
      }
      // Knowledge only grows; inventory and skills are the full new list.
      clean[field] = READER_APPEND_ONLY_LISTS.has(field) ? union(current[field], value) : [...value];
      continue;
    }
    if (field === 'relationships') {
      if (!isPlainObject(value)) {
        out.reject(path, value, 'must be an object of relationship descriptions');
        continue;
      }
      const merged = {};
      for (const [who, text] of Object.entries(value)) {
        const existing = isPlainObject(current.relationships) ? current.relationships : {};
        if (!(who in existing)) {
          out.reject(`${path}.${who}`, text, 'unknown relationship');
          continue;
        }
        const problem = checkString(text);
        if (problem) {
          out.reject(`${path}.${who}`, text, problem);
          continue;
        }
        merged[who] = text;
      }
      if (Object.keys(merged).length) clean.relationships = { ...current.relationships, ...merged };
      continue;
    }
    let problem = checkSameType(current[field], value);
    if (!problem && field === 'location' && knownLocations) problem = checkAllowed(value, knownLocations);
    if (problem) {
      out.reject(path, value, problem);
      continue;
    }
    clean[field] = value;
  }
  return clean;
}

function validateStory(session, input, config, out) {
  const clean = {};
  const current = session.story || {};
  const rules = (config && config.state_rules) || {};

  for (const field of Object.keys(input)) {
    if (!STORY_FIELDS.has(field)) out.reject(`story.${field}`, input[field], 'not something the AI can change');
  }

  // Act first, so plot beats can be checked against the act after this turn.
  // Beats from the next act are accepted too: scenes in one act can trigger a
  // beat the config files under the next act (for example meeting Corwin in
  // the village square during act 1). The act itself is not moved forward by a
  // beat, because the config has no act exit conditions for the code to check.
  let resultingAct = current.current_act;
  if (input.current_act !== undefined) {
    const value = input.current_act;
    const acts = actNumbers(config);
    let problem = null;
    if (!Number.isInteger(value)) problem = 'must be a whole number';
    else if (acts && !acts.includes(value)) problem = `must be one of: ${acts.join(', ')}`;
    else if (Number.isInteger(current.current_act) && value < current.current_act) problem = 'acts only move forward';
    else if (Number.isInteger(current.current_act) && value > current.current_act + 1) problem = 'acts move forward one at a time';
    if (problem) out.reject('story.current_act', value, problem);
    else {
      clean.current_act = value;
      resultingAct = value;
    }
  }

  if (input.current_scene !== undefined) {
    const problem = checkString(input.current_scene);
    if (problem) out.reject('story.current_scene', input.current_scene, problem);
    else clean.current_scene = input.current_scene;
  }

  if (input.act_progress !== undefined) {
    const problem = checkString(input.act_progress) || checkAllowed(input.act_progress, rules.act_progress);
    if (problem) out.reject('story.act_progress', input.act_progress, problem);
    else clean.act_progress = input.act_progress;
  }

  if (input.flags !== undefined) {
    if (!isPlainObject(input.flags)) {
      out.reject('story.flags', input.flags, 'must be an object of flag changes');
    } else {
      const knownFlags = config && isPlainObject(config.flags)
        ? Object.keys(config.flags)
        : Object.keys(current.flags || {});
      const flags = {};
      for (const [flag, value] of Object.entries(input.flags)) {
        const path = `story.flags.${flag}`;
        if (!knownFlags.includes(flag)) out.reject(path, value, 'unknown flag');
        else if (typeof value !== 'boolean') out.reject(path, value, 'must be true or false');
        else if (current.flags && current.flags[flag] === true && value === false) out.reject(path, value, 'flags are one-way and cannot go back to false');
        else if (current.flags && current.flags[flag] === value) continue; // no change
        else flags[flag] = value;
      }
      if (Object.keys(flags).length) clean.flags = flags;
    }
  }

  if (input.plot_beats_hit !== undefined) {
    const beats = Array.isArray(input.plot_beats_hit) ? input.plot_beats_hit : [input.plot_beats_hit];
    const hit = Array.isArray(current.plot_beats_hit) ? current.plot_beats_hit : [];
    const accepted = [];
    const hasBeats = config && isPlainObject(config.plot_beats);
    for (const beat of beats) {
      const path = 'story.plot_beats_hit';
      const problem = checkString(beat);
      if (problem) {
        out.reject(path, beat, `beat ${problem}`);
        continue;
      }
      if (hit.includes(beat) || accepted.includes(beat)) continue; // already recorded, not an error
      if (hasBeats) {
        const act = beatAct(config, beat);
        if (act === undefined) {
          out.reject(path, beat, 'unknown plot beat');
          continue;
        }
        if (Number.isInteger(act) && Number.isInteger(resultingAct) && act > resultingAct + 1) {
          out.reject(path, beat, `belongs to act ${act} but the story is in act ${resultingAct}; only beats up to the next act are accepted`);
          continue;
        }
      }
      accepted.push(beat);
    }
    if (accepted.length) clean.plot_beats_hit = accepted;
  }

  return clean;
}

function validateWorld(session, input, config, out) {
  const clean = {};
  const world = session.world || {};
  const knownLocations = config && Array.isArray(config.locations) ? config.locations : null;
  const awarenessRules = (config && config.state_rules && config.state_rules.village_awareness) || {};

  for (const key of Object.keys(input)) {
    if (key !== 'locations' && key !== 'village_awareness') out.reject(`world.${key}`, input[key], 'not something the AI can change');
  }

  if (input.locations !== undefined) {
    if (!isPlainObject(input.locations)) {
      out.reject('world.locations', input.locations, 'must be an object of location changes');
    } else {
      const locations = {};
      for (const [name, updates] of Object.entries(input.locations)) {
        const path = `world.locations.${name}`;
        const current = world.locations && world.locations[name];
        if (!current || (knownLocations && !knownLocations.includes(name))) {
          out.reject(path, updates, 'unknown location');
          continue;
        }
        if (!isPlainObject(updates)) {
          out.reject(path, updates, 'must be an object of field changes');
          continue;
        }
        const fields = {};
        for (const [field, value] of Object.entries(updates)) {
          const fieldPath = `${path}.${field}`;
          const kind = LOCATION_FIELDS[field];
          let problem = null;
          if (!kind || !(field in current)) problem = 'unknown field; the state schema is fixed';
          else if (kind === 'boolean' && typeof value !== 'boolean') problem = 'must be true or false';
          else if (kind === 'integer' && (!Number.isInteger(value) || value < 0)) problem = 'must be a whole number, 0 or more';
          else if (kind === 'string') problem = checkString(value);
          if (!problem && field === 'visited' && current.visited === true && value === false) problem = 'a visited place cannot become unvisited';
          if (!problem && field === 'visit_count' && Number.isInteger(current.visit_count) && value < current.visit_count) problem = 'visit count cannot go down';
          if (problem) out.reject(fieldPath, value, problem);
          else fields[field] = value;
        }
        if (Object.keys(fields).length) locations[name] = fields;
      }
      if (Object.keys(locations).length) clean.locations = locations;
    }
  }

  if (input.village_awareness !== undefined) {
    if (!isPlainObject(input.village_awareness)) {
      out.reject('world.village_awareness', input.village_awareness, 'must be an object of awareness changes');
    } else {
      const current = isPlainObject(world.village_awareness) ? world.village_awareness : {};
      const awareness = {};
      for (const [field, value] of Object.entries(input.village_awareness)) {
        const path = `world.village_awareness.${field}`;
        const problem = !(field in current)
          ? 'unknown field; the state schema is fixed'
          : (checkString(value) || checkAllowed(value, awarenessRules[field]));
        if (problem) out.reject(path, value, problem);
        else awareness[field] = value;
      }
      if (Object.keys(awareness).length) clean.village_awareness = awareness;
    }
  }

  return clean;
}

function validateChoices(input, key, out) {
  const entries = Array.isArray(input) ? input : [input];
  const clean = [];
  for (const entry of entries) {
    const path = key;
    if (!isPlainObject(entry)) {
      out.reject(path, entry, 'each entry must be an object');
      continue;
    }
    const problem = checkString(entry.action) || checkString(entry.consequence);
    if (problem) {
      out.reject(path, entry, `action and consequence are required and ${problem}`);
      continue;
    }
    const kept = { action: entry.action, consequence: entry.consequence };
    const changes = entry.key_state_changes ?? entry.state_changes;
    if (changes !== undefined) {
      const listProblem = checkStringList(changes);
      if (listProblem) out.reject(`${path}.key_state_changes`, changes, listProblem);
      else kept.key_state_changes = [...changes];
    }
    clean.push(kept);
  }
  return clean;
}

/**
 * Validate a parsed state update.
 * Returns { update, rejected } where `update` holds only accepted changes,
 * already in the form to be applied (lists merged where they only grow), and
 * `rejected` lists each dropped change with its path, a short copy of the
 * value and the reason.
 */
function validateStateUpdate(session, stateUpdate, config) {
  const out = new Collector();
  if (stateUpdate === null || stateUpdate === undefined) return { update: null, rejected: [] };

  const raw = unwrap(stateUpdate, out);
  if (!isPlainObject(raw)) {
    out.reject('(block)', raw, 'the state block must be a JSON object; whole block ignored');
    return { update: null, rejected: out.rejected };
  }

  const update = {};
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      out.reject(key, raw[key], key === 'session' ? 'set by the application, not the AI' : 'not something the AI can change');
    }
  }

  const sections = [
    ['characters', validateCharacters],
    ['reader', validateReader],
    ['story', validateStory],
    ['world', validateWorld],
  ];
  for (const [key, fn] of sections) {
    if (raw[key] === undefined) continue;
    if (!isPlainObject(raw[key])) {
      out.reject(key, raw[key], 'must be an object');
      continue;
    }
    const clean = fn(session, raw[key], config, out);
    if (Object.keys(clean).length) update[key] = clean;
  }

  const choiceKey = raw.choice_history !== undefined ? 'choice_history' : (raw.choice_log !== undefined ? 'choice_log' : null);
  if (choiceKey) {
    if (raw.choice_history !== undefined && raw.choice_log !== undefined) {
      out.reject('choice_log', raw.choice_log, 'ignored because choice_history was also given');
    }
    const choices = validateChoices(raw[choiceKey], choiceKey, out);
    if (choices.length) update.choice_history = choices;
  }

  return { update, rejected: out.rejected };
}

module.exports = { validateStateUpdate, MAX_STRING_LENGTH };
