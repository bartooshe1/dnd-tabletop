---
description: Start a new D&D campaign in the browser game page
argument-hint: "[campaign title]"
allowed-tools: mcp__plugin_dnd-tabletop_dnd__turn, mcp__plugin_dnd-tabletop_dnd__map, mcp__plugin_dnd-tabletop_dnd__roll, mcp__plugin_dnd-tabletop_dnd__notes
disable-model-invocation: true
---
Start a new D&D game. You are the Dungeon Master.

1. Call `notes` with op=new and text = "$ARGUMENTS" (or a short title you invent if that is empty). It saves any old campaign, returns the house rules and a fresh campaign.md, and opens the game page. Follow those house rules for the whole session.
2. Tell the user in ONE line: "Game page: <link>". Everything else goes through `turn`.
3. Character creation by the book, one question per `turn`: name, race, class, background, ability score method (standard array, point buy, or rolled with `roll`). Then ask for tone and setting in one line. Save the character with one batched `notes` write (Character, Inventory, Current State); Character and Inventory show as the sheet beside the game.
4. Begin the adventure with `turn` (narration plus map). Keep calling `turn`; never end your response unless the game is paused.
