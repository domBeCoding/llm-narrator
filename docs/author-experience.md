# Author Experience Plan

> How authors create stories for the LLM Narrator without writing technical config files.

---

## Goal

Authors should never have to write or edit JSON/YAML by hand. They paste their story and collaborate with an LLM-powered authoring assistant that extracts the mechanical structure and generates the underlying config.

---

## Target Author Profile

- Wants to write interactive fiction, not code.
- Has a story in mind with characters, locations, plot beats, and branching choices.
- Is comfortable answering questions about how the story should behave.
- Does not need to understand state management, flags, or validation rules.

---

## Author Workflow

### 1. Paste the Story

The author provides the narrative text of their story. This is the creative source of truth. It can be a full draft, an outline, or even a set of scene notes.

### 2. LLM-Powered Story Interview

The authoring assistant reads the story and asks targeted questions to extract the gameplay structure:

- "Can the reader enter the forbidden forest alone, or do they need help?"
- "Which characters can the reader form a close bond with?"
- "What are the possible endings, and what choices lead to each one?"
- "Are any story events mandatory, or can they be skipped?"
- "What should happen if the reader ignores the main crisis?"

The author answers in plain language. The assistant may ask follow-ups until the story structure is clear.

### 3. Draft Config Generation

From the story and interview answers, the assistant generates:

- `story-config.json` — flags, plot beats, paths, end conditions, ending variants
- `session-template.json` — starting character states, world state, reader state
- A structured `story.md` with author notes, if one does not already exist

These files follow the strict schema expected by the runtime.

### 4. Author Review in Plain Language

The author never reviews raw JSON. Instead, the assistant presents:

- A summary of characters and their arcs
- A map of locations and connections
- A list of key decision points and consequences
- A preview of possible endings

The author can request changes naturally:

- "Make the forest more dangerous."
- "Let Tomas become a romance option."
- "I want a hidden ending where the reader fails to save Elara."

The assistant updates the config and re-presents the summary.

### 5. Validation and Iteration

Before a story is playable, the runtime validates the generated config:

- End conditions must be reachable.
- Character state progressions must be consistent.
- Plot beats must have valid dependencies.
- Flags must be set somewhere in the story flow.

If validation fails, the assistant explains the issue to the author in plain terms and offers a fix.

---

## Runtime Remains Strict

The author-facing layer is forgiving and conversational, but the runtime underneath stays strict:

- State schemas are fixed.
- Validation rules are enforced during play.
- The LLM narrator cannot override generated rules during a session.

This separation lets the author stay creative while the runtime guarantees a consistent player experience.

---

## Open Questions

- Should the authoring assistant be a separate system prompt/role, or share logic with the narrator?
- How much of the interview can be inferred automatically from a well-written story, and how much needs explicit author input?
- Should authors be able to edit the generated config directly as an advanced option?
- How do we version author revisions and keep generated files in sync with the story text?

---

## Summary

The author writes stories. The LLM assistant turns stories into structured game configs. The runtime enforces those configs during play. Authors stay creative; players get a coherent experience.
