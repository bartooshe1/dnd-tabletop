// Wound words for non-player tokens. Real HP numbers never leave the server for these.
export const WOUNDS = ["unhurt", "hurt", "bloodied", "badly wounded", "near death", "down"];

export function woundWord(hp, maxHp) {
  if (typeof hp !== "number" || typeof maxHp !== "number" || maxHp <= 0) return null;
  if (hp <= 0) return "down";
  if (hp >= maxHp) return "unhurt";
  const f = hp / maxHp;
  if (f <= 0.1 || hp <= 2) return "near death";
  if (f <= 0.25) return "badly wounded";
  if (f <= 0.5) return "bloodied";
  return "hurt";
}
