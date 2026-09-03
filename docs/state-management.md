# State Management Design

> How the LLM Narrator system tracks, updates, and uses state beyond chat history context.

---

## The Problem

Right now, the LLM relies entirely on conversation history to maintain consistency. This works for short sessions but breaks down quickly:

- **Context limits**: Long stories exceed context windows. The LLM forgets early details.
- **Hallucination**: The LLM may contradict established facts (e.g., narrating Elara as alert when she was described as unconscious earlier).
- **No persistence**: If the session ends, everything is lost. There's no way to resume.
- **No validation**: Nothing checks whether the LLM's narration is consistent with the story rules.

The solution is a **structured state layer** that exists outside the LLM context, is updated each turn, and is injected into the LLM's prompt as ground truth.

---

## State Categories

### 1. Character State

Tracks the current condition and disposition of every NPC in the story.

```yaml
characters:
  elara:
    health: "critical" # healthy | minor_ill | critical | recovering | dead
    consciousness: "fading" # alert | drowsy | fading | unconscious
    location: "apothecary"
    disposition: "vulnerable" # current emotional/behavioral state
    revealed_secrets: [] # which of her secrets the reader knows
    current_activity: "bedridden, murmuring"
    relationship_to_reader: "mentor, deep bond"

  halden:
    health: "healthy"
    consciousness: "alert"
    location: "haldens_cottage"
    disposition: "hostile" # hostile | dismissive | grudging | helpful | warm
    revealed_secrets: [] # e.g., ["knows_the_forest", "knows_elara"]
    current_activity: "tending her garden"
    relationship_to_reader: "stranger"

  tomas:
    health: "healthy"
    consciousness: "alert"
    location: "village_square"
    disposition: "unaware" # unaware | worried | protective | brave | relieved
    revealed_secrets: []
    current_activity: "chopping wood"
    relationship_to_reader: "childhood friend, unspoken tension"

  corwin:
    health: "healthy"
    consciousness: "alert"
    location: "village_square"
    disposition: "neutral"
    revealed_secrets: []
    current_activity: "posting notices"
    relationship_to_reader: "distant authority figure"
```

**What this enables**: The LLM can't accidentally narrate Halden as friendly if her disposition is "hostile." It can't have Elara speaking coherently if her consciousness is "fading."

### 2. Reader/Player State

Tracks the reader's character: who they are, where they are, what they know, and what they're carrying.

```yaml
reader:
  name: "Wren"
  location: "apothecary"
  emotional_state: "alarmed" # content | curious | alarmed | determined | relieved
  inventory:
    - "basic herb kit"
    - "torn book page (Greymere Fever info)"
  knowledge: # things the reader's character has learned
    - "elara_is_sick"
    - "illness_matches_greymere_fever"
    - "cure_is_moonpetal"
    - "moonpetal_grows_in_greymere_forest"
  skills:
    - "herbalism: apprentice"
    - "basic_medicine"
  relationships:
    elara: "mentor, surrogate mother, deep bond"
    tomas: "childhood friend, unspoken tension"
    halden: "unknown, only rumors"
    corwin: "distant authority figure"
```

**What this enables**: The LLM knows what the reader knows. It won't reference Moonpetal before the reader has discovered it. It won't let the reader use a skill they don't have. It tracks emotional growth.

### 3. Story Progression State

Tracks where the reader is in the story structure and what's happened so far.

```yaml
story:
  current_act: 1
  current_scene: "Morning in the Apothecary"
  act_progress: "early" # early | mid | late | complete
  time_in_story: "Day 1, early morning"
  time_pressure: "moderate" # none | low | moderate | high | critical

  plot_beats_hit:
    - "elara_found_sick"
    - "greymere_fever_identified"

  plot_beats_available:
    - "discover_moonpetal_cure"
    - "decide_on_path"

  plot_beats_locked: # beats that can't trigger yet
    - "enter_forest" # requires: decide_on_path
    - "halden_encounter" # requires: travel_to_haldens_cottage
    - "corwin_refusal" # requires: appeal_to_corwin
    - "elara_recovery" # requires: obtain_moonpetal

  paths_attempted: []
  paths_completed: []

  flags: # binary story toggles
    reader_found_torn_page: true
    reader_checked_elara: true
    reader_left_apothecary: false
    tomas_involved: false
    halden_encountered: false
    corwin_encountered: false
    forest_entered: false
    moonpetal_obtained: false
```

**What this enables**: The system knows which act the reader is in, which plot beats have fired, and which are available. It can gate progression (e.g., Act 2 can't start until the reader has discovered the Moonpetal cure). It prevents the LLM from narrating events out of order.

### 4. World State

Tracks the state of the world itself: things that are happening independent of the reader.

```yaml
world:
  locations:
    apothecary:
      status: "open"
      notable_changes: "Elara is bedridden"
      visited: true
      visit_count: 1
      last_visited: "Day 1, early morning"
    village_square:
      status: "busy"
      notable_changes: "market day, villagers gossiping about poor harvest"
      visited: false
      visit_count: 0
      last_visited: null
    greymere_forest:
      status: "forbidden"
      notable_changes: "none"
      visited: false
      visit_count: 0
      last_visited: null
    haldens_cottage:
      status: "occupied"
      notable_changes: "none"
      visited: false
      visit_count: 0
      last_visited: null

  village_awareness:
    elara_illness: "low" # low | spreading | widely_known
    forest_activity: "none" # none | someone_entered | search_party

  weather: "overcast, cool autumn morning"

  ambient_events: # things happening in the background
    - "harvest continues despite poor yield"
    - "villagers are anxious about winter"
```

**What this enables**: The world feels alive. When the reader enters the village square, the LLM knows what's happening there. If the reader tells villagers about Elara's illness, `village_awareness.elara_illness` can increase. The world reacts to the reader's choices.

### 5. Choice History / Decision Log

Tracks every meaningful choice the reader has made. This is the "narrative memory."

```yaml
choice_history:
  - turn: 1
    action: "examine Elara's symptoms"
    consequence: "identified fever, no match to common ailments"
    state_changes:
      - "reader.knowledge += elara_is_sick"

  - turn: 2
    action: "search apothecary for remedies"
    consequence: "found torn page describing Greymere Fever"
    state_changes:
      - "reader.inventory += torn_book_page"
      - "reader.knowledge += illness_matches_greymere_fever"
      - "story.flags.reader_found_torn_page = true"

  - turn: 3
    action: "check Elara's private journal"
    consequence: "felt guilty, but found a reference to Moonpetal"
    state_changes:
      - "reader.knowledge += cure_is_moonpetal"
      - "story.plot_beats_hit += discover_moonpetal_cure"
```

**What this enables**: The system can reference past choices in narration ("You remember the torn page you found..."). It can compute which ending variant the reader is heading toward. It provides an audit trail for debugging.

### 6. Conversation/Meta State

Tracks session-level information.

```yaml
session:
  session_id: "session-001"
  user_id: "user-001"
  story_id: "the-herbalists-choice"
  reader_name: "Wren"
  status: "active" # active | concluding | completed
  turn_count: 3
  started_at: "2026-07-25T12:00:00Z"
  last_action_at: "2026-07-25T12:15:00Z"
  last_llm_output: null # full verbatim narration from the last turn
  ending_variant: null # null | halden_reconciled | tomas_helped | solo_path | corwin_involved

conversation_history: [] # array of {role, content} pairs — reader actions and LLM narrations
```

---

## How State Flows Each Turn

### Current Turn Cycle

The application layer (the Discord bot) owns state; the LLM only narrates and reports changes.

```
┌─────────────────────────────────────────────────────────┐
│  TURN CYCLE                                             │
│                                                         │
│  1. Reader submits action                               │
│                                                         │
│  2. Bot loads the session state file                    │
│                                                         │
│  3. Bot builds the prompt:                              │
│     - System prompt (role, rules)                       │
│     - Current session state                             │
│     - Story context (story.md)                          │
│     - Story config (flags, end conditions, variants)    │
│     - Reader's action for this turn                     │
│                                                         │
│  4. LLM returns narration + a fenced JSON state block   │
│                                                         │
│  5. Bot parses the narration and the state block         │
│                                                         │
│  6. Bot applies the state changes and records            │
│     turn_count, last_action_at and last_llm_output       │
│                                                         │
│  7. Bot saves the session file                          │
│                                                         │
│  8. Bot sends the narration to the reader               │
│                                                         │
│  9. Repeat                                              │
└─────────────────────────────────────────────────────────┘
```

### Session Status Lifecycle

The session `status` field transitions through three states, managed entirely by the application:

| Status | Meaning | Who sets it | Reader experience |
|---|---|---|---|
| `active` | Story in progress | Set at session creation | Normal turns with choices |
| `concluding` | All end conditions met; next turn is the ending | Set by bot after `evaluateEndConditions` passes | One more action, then the closing scene |
| `completed` | Story is over; further play is blocked | Set by bot after the concluding turn | "Use `/restart` to play again" |

**How the transition works:**

1. After every turn, the bot calls `evaluateEndConditions(session, config)` which checks all `end_conditions.all_required` predicates against the current state.
2. If all pass and the session is `active`, the bot sets `status = 'concluding'`.
3. On the next turn, the bot sees `status === 'concluding'` and injects a **FINAL TURN — ENDING DIRECTIVE** into the LLM prompt. The directive tells the LLM to infer the appropriate ending from the current game state flags and the `ending_variants` descriptions in the story config.
4. After the concluding turn, the bot sets `status = 'completed'`. Further messages are rejected.

The LLM never sets `status` — that is a deterministic application-level decision. The LLM infers which ending variant fits based on the flags and character state visible in the prompt.

### Target Turn Cycle (with validation)

Validation of the model's proposed changes is not yet implemented. The intended shape:

```
┌─────────────────────────────────────────────────────────┐
│  VALIDATED TURN CYCLE                                   │
│                                                         │
│  1. Reader submits action                               │
│                                                         │
│  2. System loads current state from storage             │
│                                                         │
│  3. System builds LLM prompt:                           │
│     - System prompt (role, rules)                       │
│     - Static world data (characters, locations, tone)  │
│     - Story config (flags, end conditions, variants)    │
│     - Current runtime state (all 6 categories above)    │
│     - Current act info (scenes, beats, available actions)│
│     - Conversation history (or summarized history)      │
│     - Reader's action for this turn                     │
│                                                         │
│  4. LLM generates response:                             │
│     - Narration prose                                   │
│     - Suggested actions                                 │
│     - Structured state update (see below)               │
│                                                         │
│  5. System parses state update from LLM response          │
│                                                         │
│  6. System validates state update:                        │
│     - Are the changes allowed by story rules?           │
│     - Do they contradict existing state?                  │
│     - Are secret reveals gated properly?                  │
│                                                         │
│  7. System applies validated changes to state             │
│                                                         │
│  8. System saves updated state to storage               │
│                                                         │
│  9. System sends narration + suggested actions to reader  │
│                                                         │
│  10. Repeat                                             │
└─────────────────────────────────────────────────────────┘
```

---

## How State Changes Are Applied

The LLM outputs **two parts** in each response:

#### Part 1: Narration (what the reader sees)

The DM-style narration and suggested actions, as defined in the system prompt.

#### Part 2: State Update (hidden from reader, parsed by system)

A structured block the system parses to update state. Format:

```json
{
  "state_update": {
    "characters": {
      "elara": {
        "health": "critical",
        "consciousness": "unconscious"
      }
    },
    "reader": {
      "knowledge": ["elara_is_sick"],
      "emotional_state": "alarmed"
    },
    "story": {
      "plot_beats_hit": ["elara_found_sick"],
      "flags": {
        "reader_checked_elara": true
      }
    },
    "choice_log": {
      "action": "check on Elara",
      "consequence": "found her feverish and barely conscious",
      "key_state_changes": [
        "elara.health=critical",
        "elara.consciousness=barely"
      ]
    }
  }
}
```

The system strips this block from the response before showing narration to the reader.

### Why This Approach (Production)

- **LLM proposes, system disposes**: The LLM is best at understanding what _narratively_ happened. The system is best at validating whether that's _allowed_. This split plays to each component's strengths.
- **Auditable**: Every state change is logged with the action that triggered it.
- **Recoverable**: If the LLM makes a bad state proposal, the system can reject it and either re-prompt the LLM or apply a minimal safe update.

---

## Validation Rules

The system should validate LLM-proposed state changes against these rules:

1. **Secret gating**: A character's secret can only be added to `revealed_secrets` if the corresponding story flag or plot beat permits it. E.g., Halden's "knows_elara" secret can only be revealed if `halden_encountered` is true AND her disposition is at least "grudging."

2. **Health progression**: Character health changes should follow allowed transitions. Elara can go `healthy → critical → deteriorating → recovering`, but not `critical → healthy` (that would skip the cure).

3. **Location consistency**: A character can't be in two places. If the reader is at the apothecary, they can't interact with Halden unless they've traveled to her cottage first.

4. **Knowledge gating**: The reader's `knowledge` list should only grow, never shrink (within a session). You can't un-learn something.

5. **Plot beat ordering**: Plot beats have dependencies. `elara_recovery` can't fire before `moonpetal_obtained`. The system should reject attempts to fire dependent beats before their prerequisites.

6. **Act transitions**: Act advancement should only happen when the current act's exit conditions are met (defined per-act in the story file).

---

## State Storage

For the prototype, state is stored as a **single JSON file per session**:

```
llm-narrator/
└── sessions/
    ├── session-001.json      ← active/completed session
    └── session-template.json ← starting state for new playthroughs
```

This file is loaded at the start of each turn, updated, and saved. Simple, human-readable, and easy to debug.

For a production system, this would move to a database (document store like MongoDB, or a relational DB with a schema for each state category).

### Story Files

Stories are split across two files:

```
llm-narrator/
└── stories/
    ├── the-herbalists-choice.md     ← narrative: world, characters, acts, author notes
    └── the-herbalists-choice-config.json ← mechanical: flags, plot beats, paths, end conditions, ending variants
```

The story MD file is the author's narrative design — read by the LLM for context. The story config JSON is the mechanical rulebook — read by the system for state validation, end condition checking, and ending variant selection. Both are static and read-only during a session.

---

## Summary of State Categories

| Category | What It Tracks | Why It Matters |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| **Character State** | NPC health, disposition, location, secrets, relationships | Keeps characters consistent; prevents contradictions |
| **Reader State** | Reader's location, inventory, knowledge, skills, emotions | Tracks what the reader knows and can do; gates actions |
| **Story Progression** | Current act, scene, plot beats, paths, flags | Controls narrative flow; prevents out-of-order events |
| **World State** | Location statuses, village awareness, weather, ambient events | Makes the world feel alive and reactive |
| **Choice History** | Log of every action and its consequences | Narrative memory; determines ending variant; debugging |
| **Session/Meta** | Turn count, timestamps, story ID, session status | Persistence, resumption, analytics |

---

## Open Implementation Questions

1. **Should state updates be a separate LLM call or part of the narration response?**
   - Separate call: cleaner separation, but doubles API costs and latency.
   - Combined: faster, cheaper, but the LLM has to do two things at once (narrate + structured output).
   - Recommendation: start with combined (structured block after narration), move to separate if quality suffers.

2. **How much state should be injected into context each turn?**
   - Full state: most reliable, but consumes context window.
   - Delta only (what changed since last turn): lighter, but the LLM might miss context.
   - Recommendation: inject full state for short stories; implement summarization for longer ones.

3. **Should the system use a separate "classifier" LLM call to detect the reader's intent before narration?**
   - This would let the system update state deterministically (e.g., "reader said 'go to Halden's cottage' → set reader.location = haldens_cottage") before the narration LLM even runs.
   - More reliable state management, but adds complexity and latency.
   - Recommendation: worth prototyping once the basic state loop works.

4. **How to handle state when the reader does something unexpected?**
   - If the reader's action doesn't map to any known state change, the system should still log it in choice history with a "no state change" note, and let the LLM narrate a response.

---

## Character State Progression — Phase Naming Convention

Character state progression in the story config file uses a standardized **phases array** format. Every character follows the same structure regardless of their role or arc complexity.

### Structure

```json
"character_state_progression": {
  "character_name": {
    "phases": [
      {
        "name": "phase_name",
        "conditions": { ... },
        "state": { "field": "value" }
      }
    ]
  }
}
```

- **`name`**: The phase identifier (see naming convention below)
- **`conditions`**: When this phase applies. Can reference flags (`{"flag": "halden_encountered", "value": true}`), story state (`{"story.current_act": 2}`), or a combination
- **`state`**: The expected character state fields during this phase (e.g., `health`, `disposition`, `emotional_state`)

### Phase Naming Convention

All characters use the same set of phase names, applied in order:

| Phase Name | Description |
| ------------------ | -------------------------------------------------------------------------------- |
| `before_encounter` | The character's state before the reader has any meaningful interaction with them |
| `first_encounter` | The character's state during their first significant interaction with the reader |
| `second_encounter` | The character's state during their second meaningful interaction |
| `third_encounter` | The character's state during their third meaningful interaction (if applicable) |
| `final_encounter` | The character's state at story resolution / ending |

Not all characters need all phases. A character with a simple arc might only have `before_encounter`, `first_encounter`, and `final_encounter`. A character with a complex arc might use all five.

### Rules

- Phases are **ordered** — they represent progression. A character does not go backward (e.g., from `final_encounter` back to `before_encounter`).
- Conditions are **evaluated against the current session state** each turn. The system checks which phase's conditions are met and uses the corresponding state as a reference for expected character behavior.
- Multiple conditions in a single phase must **all** be met for that phase to apply.
- The `state` fields only need to include what's **relevant to this character's arc**. Not all session state fields are required.
- Characters not yet encountered by the reader stay in `before_encounter` until their first interaction triggers a flag.
