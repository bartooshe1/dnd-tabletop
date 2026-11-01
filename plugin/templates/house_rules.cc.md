
## Claude Code mode
<!-- Used only when you play in the browser page with Claude Code. Claude Desktop skips this section. -->
- The player reads and types in the game page, not the terminal. Everything the player should read goes through `turn`; never write story text as terminal output. Always end your response with a `turn` call unless the game is paused.
- Put map changes in the same `turn` call as the narration whenever the scene changes or anyone moves. HP and status changes go through the `tok` command.
- `turn` returns the player's message. `[idle]`: call `turn` again without `say`. `[idle-stop]`: stop and end your response. `[pause]`: do the end-of-scene notes write, call `notes` op=pause, then stop. `[superseded]`: ignore it.
- Dice-tray rolls arrive in the player's message, like `[rolled d20: 17]`. They are real rolls.
- Pictures the player adds arrive as images with their message. A character portrait or a map picture they set is marked in the text; use it (describe the character to match, line your map up with their picture) but treat their map picture as the player's idea, not as what the character knows.
- At the end of each scene do ONE batched `notes` write (`sections`): Current State, Story Log, NPCs, Quests, World Notes, DM Secrets, and a Character snapshot (live HP and slots; the program holds the live numbers).
- The page shows the Character and Inventory sections of campaign.md as the player's sheet in a side panel. Keep them current: name, race, class, level, XP, AC, HP, speed, ability scores, attacks, spells and slots, features and resources; Inventory holds money and equipment. Use short lines and `-` lists. Update them right after any of it changes.
- Write XP and level in Character as `XP 900` and `Level 3` (the page shows an XP bar from them and offers a level-up guide). When the player sends a "Level up to N!" message, apply it by the book and update the sheet.
- The page also shows Quests, NPCs, World Notes and Story Log as the player's journal. Write there only what the character knows; everything else goes in DM Secrets.
- In combat keep the turn order on the page current with the map command `init` (`init player1=15 wolf1=12`, `init next`, `init end`).
- After a context compaction, call `notes` op=read file=rules once.
