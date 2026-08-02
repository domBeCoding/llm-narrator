# AGENTS.md — Narrator Game

This workspace is the game runtime. Your only job is to run interactive story sessions.

## Every Session Start

Before narrating, read these files in order:

1. `docs/system-prompt.md` — your core narrator instructions
2. `docs/state-management.md` — how state is structured and updated
3. `stories/the-herbalists-choice-config.json` — flags, plot beats, end conditions, ending variants
4. `stories/the-herbalists-choice.md` — the story world, characters, acts, author notes
5. `sessions/session-<channel-id>.json` — the current playthrough state for this channel

If the session file does not exist, copy `sessions/session-template.json` to `sessions/session-<channel-id>.json` and set:

- `session.session_id`: the Discord channel ID
- `session.started_at`: current ISO timestamp
- `session.last_action_at`: current ISO timestamp
- `session.status`: `"active"`

Then begin the story.

## Per-Turn Workflow

1. **Read the session file** for this channel.
2. **Read the story config** to check end conditions and available plot beats.
3. **Generate the narration** following the format in `docs/system-prompt.md`:
   - Story section
   - `========` divider
   - Summary prompt
   - 2–4 numbered choices + option to suggest your own
4. **Update the session file** with all state changes from this turn.
5. **Commit the session file** to the repo after every turn so the history is preserved.

## State Update Rules

- Only change fields that actually changed this turn.
- Do not add or remove fields from the session schema.
- Increment `session.turn_count` by 1.
- Update `session.last_action_at` and `session.last_llm_output`.
- Set flags to `true` when their corresponding event occurs. Flags never go back to `false`.
- Add plot beats to `story.plot_beats_hit` only when genuinely triggered.
- Update location visit tracking when the player travels.
- Append every action to `choice_history`.

## Ending the Story

When all `end_conditions.all_required` are satisfied, begin winding down. On the final turn, use the ending format from `docs/system-prompt.md`:

```
<closing scene>

========

The story ends here.

The End
```

Set `session.status` to `"completed"` and `session.ending_variant` to the matching variant id(s).

## Tool Scope

- Use `read`, `write`, and `edit` for files in this repo only.
- Use `exec` only for git commits inside this repo.
- Do not use `web_search`, `web_fetch`, or any external tools.
- Do not create numbered message files. Only create and update game session files.

## Git

Commit session state changes after every turn with a message like:

```
Turn 4: reader enters greymere_forest
```

Keep the session file history clean and auditable.
