# LLM Narrator

## Product Concept

LLM Narrator is an interactive storytelling platform where an LLM acts as a narrator — similar to a Dungeon Master in Dungeons & Dragons — guiding a reader through a story from a **second-person perspective** ("You step into the apothecary...").

The reader is not a passive consumer. They **navigate** the story, **make decisions**, and **shape their experience** — but always within boundaries defined by the **author**.

## Core Principles

### 1. Author-Defined Boundaries

The author is the architect of the story world. They define:

- **What the reader can do** — the set of possible actions and interactions available at any point.
- **Character personalities** — the NPCs and characters the first-person reader encounters, each with defined traits, motivations, and behaviours.
- **Travelable locations** — the map of places the reader can go, and the connections between them.
- **Story structure** — the key plot beats, arcs, and outcomes that the narrative can reach.

### 2. Freedom Within Boundaries

Within the author's framework, the reader has **agency**:

- They can choose how to approach situations.
- They can interact with characters in their own style.
- They can explore locations in the order and manner they wish (within what the author permits).
- Their decisions influence how the story unfolds — tone, pacing, relationships, and which plot branches are triggered.

### 3. LLM as Narrator

The LLM serves as the **narrative engine**:

- It renders the story world in response to reader actions.
- It embodies characters consistently with author-defined personalities.
- It enforces the author's boundaries — gently steering the reader back if they attempt actions outside the scope of the story.
- It generates descriptive prose, dialogue, and consequences in real-time.

## Analogy

| D&D Dungeon Master | LLM Narrator |
| ------------------------ | ----------------------------------------- |
| Prepares a campaign | Author defines the story world |
| Roleplays NPCs | LLM embodies author-defined characters |
| Adjudicates rules | LLM enforces story boundaries |
| Reacts to player choices | LLM generates narrative responses |
| Keeps the story moving | LLM maintains pacing and plot progression |

## Project Goals

- Provide a framework where **authors** can define story worlds (characters, locations, plot structure, action boundaries).
- Provide an **interface** where **readers** experience the story in second-person, making decisions and exploring freely.
- Use an **LLM** to bridge the two — generating rich, dynamic narration that stays faithful to the author's design.

## Status

Prototype stage. The system prompt, state management design, story config format, and session state files are implemented. One story ("The Herbalist's Choice") has been playtested end-to-end.

The application layer is a Discord bot (`index.js` plus the classes in `src/`). It loads story data, manages session state files, calls the LLM for narration, parses the returned state update, and persists the result after every turn.

## Running

```bash
npm install
npm start
```

The bot reads two secrets from AWS SSM Parameter Store: `narrator-bot` (Discord token) and `kimi-credentials` (LLM API key).

## Testing

```bash
npm test
```

Tests use Node's built-in test runner and require no external services.
