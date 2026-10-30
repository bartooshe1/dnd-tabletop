// What each 5e condition does, in plain words (summarized from the SRD 5.1), for tooltips on
// condition chips and in the map's hover box.

export const CONDITIONS = {
  blinded: ["Can't see.", "Fails checks that need sight.", "Attacks against it have advantage; its attacks have disadvantage."],
  charmed: ["Can't attack the charmer or target it with harmful effects.", "The charmer has advantage on social checks with it."],
  deafened: ["Can't hear.", "Fails checks that need hearing."],
  frightened: ["Disadvantage on checks and attacks while the source of fear is in sight.", "Can't willingly move closer to it."],
  grappled: ["Speed 0.", "Ends if the grappler is incapacitated or it is moved out of reach."],
  incapacitated: ["Can't take actions or reactions."],
  invisible: ["Can't be seen without magic; counts as heavily obscured.", "Its attacks have advantage; attacks against it have disadvantage."],
  paralyzed: ["Incapacitated; can't move or speak.", "Fails Strength and Dexterity saves.", "Attacks against it have advantage; hits from within 1.5 m (5 ft) are critical hits."],
  petrified: ["Turned to stone: incapacitated, can't move or speak, unaware.", "Resistant to all damage; fails Strength and Dexterity saves."],
  poisoned: ["Disadvantage on attack rolls and ability checks."],
  prone: ["Can only crawl; standing up costs half its movement.", "Its attacks have disadvantage.", "Attacks from within 1.5 m (5 ft) have advantage, farther ones disadvantage."],
  restrained: ["Speed 0.", "Its attacks and Dexterity saves have disadvantage.", "Attacks against it have advantage."],
  stunned: ["Incapacitated; can't move; speaks only falteringly.", "Fails Strength and Dexterity saves.", "Attacks against it have advantage."],
  unconscious: ["Incapacitated, can't move or speak, unaware; drops what it holds and falls prone.", "Fails Strength and Dexterity saves.", "Attacks against it have advantage; hits from within 1.5 m (5 ft) are critical hits."],
  exhaustion: [
    "Levels add up: 1 disadvantage on ability checks; 2 speed halved; 3 disadvantage on attacks and saves; 4 HP maximum halved; 5 speed 0; 6 death.",
    "A long rest with food and drink removes one level.",
  ],
  concentrating: ["Keeping a spell going. Taking damage needs a Constitution save (DC 10 or half the damage, whichever is higher) or the spell ends."],
  dodging: ["Until its next turn, attacks against it have disadvantage (if it can see the attacker) and it has advantage on Dexterity saves."],
  hidden: ["Unseen and unheard: attacks against it have disadvantage and its attacks have advantage. Attacking or making noise gives it away."],
  raging: ["Advantage on Strength checks and saves, bonus melee damage, resistance to bludgeoning, piercing and slashing damage. Can't cast or concentrate on spells."],
  blessed: ["Adds 1d4 to attack rolls and saving throws."],
  hasted: ["Double speed, +2 AC, advantage on Dexterity saves and one extra limited action each turn. When it ends: one turn of lethargy."],
  slowed: ["Half speed, −2 AC and Dexterity saves, no reactions, only an action or a bonus action each turn."],
  stable: ["At 0 HP but no longer making death saves. Regains 1 HP after 1d4 hours."],
  dying: ["At 0 HP: make a death saving throw each turn. Three successes: stable. Three failures: dead. A natural 20 brings it back with 1 HP."],
  surprised: ["Can't move or act on its first turn of the fight, and can't take reactions until that turn ends."],
};

const ALIAS = { exhausted: "exhaustion", concentration: "concentrating", dodge: "dodging", rage: "raging", bless: "blessed", haste: "hasted", slow: "slowed", unconscious_: "unconscious", asleep: "unconscious", sleeping: "unconscious", charm: "charmed", fear: "frightened", scared: "frightened", grapple: "grappled", restrain: "restrained", stun: "stunned", blind: "blinded", deaf: "deafened", invisibility: "invisible", poison: "poisoned", paralysis: "paralyzed", stabilized: "stable", down: "dying" };

/** Rules text for a condition name ("prone", "exhaustion 2", "Poisoned"), or null. */
export function conditionInfo(name) {
  const key = String(name).toLowerCase().replace(/[^a-z ]/g, "").trim().split(" ")[0];
  const id = CONDITIONS[key] ? key : ALIAS[key];
  return id ? { name: id, lines: CONDITIONS[id] } : null;
}
