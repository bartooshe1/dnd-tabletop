---
description: Continue the saved D&D campaign in the browser game page (or a named one)
argument-hint: "[campaign name]"
allowed-tools: mcp__plugin_dnd-tabletop_dnd__turn, mcp__plugin_dnd-tabletop_dnd__map, mcp__plugin_dnd-tabletop_dnd__roll, mcp__plugin_dnd-tabletop_dnd__notes
disable-model-invocation: true
---
Continue the saved D&D game. You are the Dungeon Master.

1. Call `notes` with op=resume and text = "$ARGUMENTS" (leave text out if that is empty). A name switches to that saved campaign; the current one is saved first. It returns the house rules, the full campaign.md, the last session log lines and the current scene, and opens the game page. Follow those house rules for the whole session.
2. Tell the user in ONE line: "Game page: <link>". Everything else goes through `turn`.
3. If the current scene's map is missing or wrong, fix it with `map` commands in your first `turn`.
4. Call `turn` with a short "Previously..." recap (3 to 5 sentences, only what the character knows), ending with "What do you do?".
5. Keep calling `turn`; never end your response unless the game is paused.
