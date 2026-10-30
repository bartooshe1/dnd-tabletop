# Claude Code mode spike

Throwaway test of the blocking `turn` loop. Run from this repo (it imports the engine from `../server/lib`).

    claude --plugin-dir "<repo>/spike-cc"

Then type `/dnd-spike:startdnd`. A browser tab opens; type there. The grey panel at the bottom shows how long `turn` has been waiting, the env Claude Code passed, and every Stop hook decision.
Data (flag file, hook log) lives in `%APPDATA%\dnd-tabletop-spike` (or the OS equivalent).
