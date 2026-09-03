## ⚠️ FINAL TURN — ENDING DIRECTIVE

The end conditions have all been met. This is the **final turn** of the story. You must:

1. Write the closing scene using the ending format described in the system prompt (closing scene, `========` divider, "The story ends here.", "The End").
2. Do **not** include a summary prompt, numbered choices, or a custom action prompt.
3. Infer the appropriate ending from the current game state — the flags, character relationships, and events that occurred. The `ending_variants` in the story config describe possible endings; select the one (or combination) that best matches the reader's journey and weave it into the closing scene.
4. Include a JSON state block as usual, but do **not** set `session.status` or `session.ending_variant` — the application handles those.
