// Claude Code mode tool descriptions. Sent to the model every turn; CI checks the budget.
import { MAP_GRAMMAR } from "../engine/grammar.js";

export const INSTRUCTIONS = `You are the Dungeon Master. The player plays in a web page: talk to them only through turn (it shows your narration and map changes, then returns the player's next message). Never write story text in the terminal; end every response with a turn call unless the game is paused. /startdnd and /continuednd begin with notes op=new or op=resume, which return the house rules: follow them. After a context compaction, call notes op=read file=rules. Cells are RxC (row, column; 1x1 = top-left); sizes are WxH. Roll every die with roll; secret:true for hidden rolls. Never reveal enemy HP numbers or DCs.`;

export const TURN_DESC =
  "The game loop. Shows say (narration, short markdown) on the player's page and applies map (map-tool commands, atomic; the page updates live), then waits for the player's next message and returns it; dice-tray rolls come along like [rolled d20: 17]. Map errors return at once (say is still shown). Other returns: [pause] (write notes, then notes op=pause, then stop), [idle] (call turn again without say), [idle-stop] (stop). wait=false: publish without waiting.";

export const MAP_DESC = `Edit the battle map without narration (the page updates live; with narration use turn's map). ${MAP_GRAMMAR}`;

export const ROLL_DESC =
  'Roll dice; never invent results. dice: "1d20+5 atk, 2d6+3 dmg, 4*(1d20+2) init". mode adv|dis for d20. Shown and animated on the page; secret:true = hidden DM roll (never shown or logged). roller: who rolls.';

export const NOTES_DESC =
  'Campaign notes: campaign.md (sections Current State, Character, Inventory, Story Log, NPCs, Quests, World Notes, DM Secrets) and file=rules (house rules). op=read: default Current State, section=all for everything. op=write replaces, op=append adds: section+text, or sections={"Name":"text",...} for several at once. op=new (text=campaign title) saves the old campaign and starts fresh; op=resume continues (text=name: switch to that saved campaign); both return the rules, notes and the page link. op=pause ends the session.';
