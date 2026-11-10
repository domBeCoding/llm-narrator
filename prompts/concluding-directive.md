## ⚠️ FINAL TURN — ENDING DIRECTIVE

The end conditions have all been met. This is the **final turn** of the story. The application has already recorded the ending. You must:

1. Write the closing scene using the ending format described in the system prompt (closing scene, `========` divider, "The story ends here.", "The End").
2. Do **not** include a summary prompt, numbered choices, or a custom action prompt.
3. Follow the recorded ending below. Weave every named variant into the closing scene. If no variant matched, write the closing scene from the current state. Do not choose or infer an ending yourself.
4. Include a JSON state block as usual, but do **not** set `session.status` or `session.ending_variant` — the application handles those.

{chosen_endings}

This applies to a story action only. If the reader's message is a healthcheck or needs clarification (see Error Handling in the system prompt), do not write the ending yet: reply as you normally would, in character and with no JSON state block, and keep the ending for their next real action. If they ask to resume, call `get_last_narration` as usual.
