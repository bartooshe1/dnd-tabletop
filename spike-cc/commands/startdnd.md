---
description: Start the D&D spike game loop (test only)
allowed-tools: mcp__plugin_dnd-spike_dnd__turn
disable-model-invocation: true
---
This is a test of a game loop. The player uses a web page, not this terminal.

1. Call `turn` with say="Welcome to the spike. Type anything; mention a cell like 3x4 and I'll move you there." and map="new \"Spike\" 10x8, load small_chamber at 1x2, 4x5-player".
2. Each `turn` result is what the player typed. Answer with ONE short sentence through `turn` (say=...). If they mention a cell like 3x4, also pass map="player1 > 3x4".
3. If the result is `[idle]`, call `turn` again with no say. If it is `[pause]` or `[idle-stop]`, call `turn` with wait=false and say="Paused. Bye!", then stop.
4. Never write story text outside `turn`. Always end your response with a `turn` call unless paused.
