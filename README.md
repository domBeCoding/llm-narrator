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

When `DISCORD_TOKEN` is set it is used as the Discord token, and when `LLM_API_KEY` is set it is used as the LLM key. SSM is only asked for a secret that is not already in the environment. If both of those are set and `TYPESAFE_API_KEY` is set too, the bot does not create an SSM client.

Junk filtering also uses a TypeSafe API key for Jev. The bot reads `TYPESAFE_API_KEY` from the environment when it is set, and otherwise loads the SSM parameter named by `TYPESAFE_CREDENTIALS_SECRET`, or `typesafe-api-key` when that is unset. If the key is missing, the bot still starts and player messages are allowed through to the narrator. Add the key to SSM separately. Do not commit it.

## Hosting on Fly.io (testing)

Fly.io hosts the bot for testing only. Run one machine and stop it when nobody is testing. The machine makes outbound connections only. It does not serve HTTP. No secrets belong in the repo or in `fly.toml`.

**Warning:** only one running copy may use the Discord token. Stop the EC2 bot before you start this machine. If both are online, Discord disconnects one of them.

### One-off setup

`fly.toml` in this repo is the app config. If `fly launch` offers to overwrite it, keep the copy from this repo. Create the app without deploying, then create the volume and set the secrets. Replace the `...` placeholders with the real values in your shell. Do not commit them.

```bash
fly launch --no-deploy
# or: fly apps create narra-bot

fly volumes create narra_sessions --region lhr --size 1

fly secrets set DISCORD_TOKEN=... LLM_API_KEY=... TYPESAFE_API_KEY=...
```

The volume is mounted at `/data`. `SESSIONS_DIR` is `/data/sessions`, and the bot creates that directory when it starts.

The image does not include the `sessions` folder. A new volume therefore has no `session-template.json`. Copy that file onto the volume before anyone starts a new game, because new games are created from it.

### Deploy

```bash
fly deploy
```

### Stop and start

Stop the machine when you are not testing:

```bash
fly machine stop
fly machine start
```

Or scale the app down to no machines:

```bash
fly scale count 0
```

After `fly scale count 0`, start a machine again with `fly scale count 1` or `fly machine start`.

### Cost

These costs are approximate. The machine is about $0.0058 an hour while it is running, and the 1GB volume is about $0.15 a month even when the machine is stopped.

## Testing

```bash
npm test
```

Tests use Node's built-in test runner and require no external services.
