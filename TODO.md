# TODO

## Concluding state spanning multiple turns

Currently the concluding state lasts exactly one turn: the bot sets `status = 'concluding'`, the LLM writes the closing scene, and the bot immediately sets `status = 'completed'`.

**Future enhancement:** Support multi-turn conclusions — stories with multiple pages of epilogue. The number of turns a conclusion can span should be configurable per story in the story config (e.g., `concluding_turns: 3`). The bot would decrement a counter each concluding turn and only transition to `completed` when it reaches zero.
