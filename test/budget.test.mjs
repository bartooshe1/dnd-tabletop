// Token budget guard: CI fails if what Claude sees every turn grows past the budget, for both
// tool sets (Claude Desktop extension and Claude Code mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { measure, BUDGET } from "../scripts/measure-tokens.mjs";

test(`both tool sets stay within ${BUDGET} tokens per turn; results stay tiny`, async () => {
  const { desktop, cc } = await measure();
  for (const [name, set] of [["desktop", desktop], ["cc", cc]]) {
    assert.ok(set.fixedTokens <= BUDGET, `${name}: fixed per-turn tokens ${set.fixedTokens} > ${BUDGET}`);
    assert.ok(set.instrWords <= 110, `${name}: instructions are ${set.instrWords} words`);
    assert.equal(Object.keys(set.perTool).length, 4, `${name}: exactly 4 tools`);
  }
  const d = desktop.results;
  assert.ok(d["map: 20-command batch"].tokens <= 120, d["map: 20-command batch"].text);
  assert.ok(d["show_map (card)"].tokens <= 20);
  assert.ok(d["roll: attack + damage"].tokens <= 30);
  assert.ok(d["notes append"].tokens <= 5);
  assert.doesNotMatch(d["show_map (card)"].text, /#/, "no ASCII map when the card renders");
  const c = cc.results;
  assert.ok(c["turn: narration only, player reply"].tokens <= 15, c["turn: narration only, player reply"].text);
  assert.ok(c["turn: [idle] (no reply)"].tokens <= 3);
  assert.ok(c["notes: batched end-of-scene write"].tokens <= 3);
});
