// Sounds made in code with Web Audio (no audio files, nothing downloaded): dice clatter, a
// chime when it's your turn, and quiet ambient loops (rain, cave, tavern, forest, fire, sea,
// wind). Everything is off until the player turns it on; browsers only allow sound after a
// click, so the first click on the page wakes the audio up.

let ctx = null;
let master = null;
let fxGain = null;
let ambGain = null;
let amb = null; // { kind, stop }
const want = { fx: false, ambient: "off", volume: 0.6 };

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = want.volume;
    master.connect(ctx.destination);
    fxGain = ctx.createGain();
    fxGain.connect(master);
    ambGain = ctx.createGain();
    ambGain.gain.value = 0.5;
    ambGain.connect(master);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

const unlock = () => {
  if (want.fx || want.ambient !== "off") {
    audio();
    if (want.ambient !== "off" && !amb) setAmbient(want.ambient, want.lastScene);
  }
};
addEventListener("pointerdown", unlock, { capture: true });
addEventListener("keydown", unlock, { capture: true });

function noiseBuffer(kind = "white", seconds = 2) {
  const c = audio();
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "brown") {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else if (kind === "pink") {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
    } else d[i] = w;
  }
  return buf;
}

function loopNoise(kind, dest, { filter = "lowpass", freq = 800, q = 0.7, gain = 0.3 } = {}) {
  const c = audio();
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(kind, 4);
  src.loop = true;
  const f = c.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(dest);
  src.start();
  return { src, f, g };
}

function blip(dest, { freq = 880, to = null, dur = 0.15, type = "sine", gain = 0.2, at = 0 }) {
  const c = audio();
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function burst(dest, { at = 0, dur = 0.04, freq = 2500, gain = 0.25, q = 1.5 }) {
  const c = audio();
  const t = c.currentTime + at;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer("white", dur + 0.02);
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(dest);
  src.start(t);
}

// ---------- effects ----------

/** Dice tumbling onto a wooden table, then settling. nat: 20 or 1 adds a flourish. */
export function diceSound(count = 1, nat = null) {
  if (!want.fx || !audio()) return;
  let t = 0;
  const hits = Math.min(14, 5 + count * 3);
  for (let i = 0; i < hits; i++) {
    t += 0.03 + Math.random() * (i < hits - 3 ? 0.07 : 0.14);
    burst(fxGain, { at: t, dur: 0.025 + Math.random() * 0.03, freq: 1800 + Math.random() * 2600, gain: 0.18 * (1 - i / (hits + 4)) });
    if (Math.random() < 0.4) blip(fxGain, { at: t, freq: 300 + Math.random() * 200, to: 120, dur: 0.06, type: "triangle", gain: 0.05 });
  }
  if (nat === 20) [784, 988, 1175, 1568].forEach((f, i) => blip(fxGain, { at: t + 0.15 + i * 0.09, freq: f, dur: 0.5, type: "triangle", gain: 0.09 }));
  if (nat === 1) blip(fxGain, { at: t + 0.12, freq: 180, to: 70, dur: 0.6, type: "sawtooth", gain: 0.06 });
}

/** A soft two-note bell: your turn. */
export function turnChime() {
  if (!want.fx || !audio()) return;
  blip(fxGain, { freq: 659, dur: 0.9, gain: 0.12 });
  blip(fxGain, { freq: 988, dur: 1.2, gain: 0.1, at: 0.16 });
  blip(fxGain, { freq: 1976, dur: 0.5, gain: 0.02, at: 0.16 });
}

// ---------- ambience ----------

export const AMBIENTS = { off: "Off", auto: "Match the scene", rain: "Rain", cave: "Cave / dungeon", tavern: "Tavern", forest: "Forest", fire: "Campfire", sea: "Sea / lake", wind: "Wind" };

/** Pick an ambience from the scene's name and caption. */
export function sceneAmbient(text) {
  const s = String(text ?? "").toLowerCase();
  if (/rain|storm|thunder|drizzle/.test(s)) return "rain";
  if (/tavern|inn\b|alehouse|feast|hall|market|bazaar|town|village|street|square/.test(s)) return "tavern";
  if (/cave|crypt|dungeon|tomb|cellar|sewer|mine|catacomb|vault|undercroft|tunnel|lair/.test(s)) return "cave";
  if (/camp|fire|forge|hearth|smithy/.test(s)) return "fire";
  if (/sea|lake|river|shore|coast|ship|boat|harbou?r|dock|beach|ferry|bay/.test(s)) return "sea";
  if (/forest|wood|clearing|grove|glade|jungle|thicket|meadow/.test(s)) return "forest";
  if (/mountain|peak|pass|cliff|snow|winter|frozen|tundra|ridge|tower|wind/.test(s)) return "wind";
  return "cave";
}

function every(minS, maxS, fn) {
  let timer = 0;
  const tick = () => {
    fn();
    timer = setTimeout(tick, (minS + Math.random() * (maxS - minS)) * 1000);
  };
  timer = setTimeout(tick, (minS + Math.random() * (maxS - minS)) * 500);
  return () => clearTimeout(timer);
}

function lfo(param, { rate = 0.1, depth = 100 }) {
  const c = audio();
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = rate;
  g.gain.value = depth;
  o.connect(g).connect(param);
  o.start();
  return o;
}

const BUILD = {
  rain(out) {
    const a = loopNoise("pink", out, { filter: "highpass", freq: 900, gain: 0.35 });
    const b = loopNoise("brown", out, { filter: "lowpass", freq: 500, gain: 0.25 });
    const stopDrops = every(0.05, 0.25, () => burst(out, { dur: 0.02, freq: 3000 + Math.random() * 3000, gain: 0.05 }));
    return () => (a.src.stop(), b.src.stop(), stopDrops());
  },
  cave(out) {
    const a = loopNoise("brown", out, { filter: "lowpass", freq: 160, gain: 0.5 });
    const l = lfo(a.f.frequency, { rate: 0.05, depth: 60 });
    const stopDrips = every(2, 6, () => {
      const f = 900 + Math.random() * 900;
      blip(out, { freq: f, to: f * 1.9, dur: 0.12, gain: 0.08 });
      blip(out, { freq: f * 0.7, to: f * 1.2, dur: 0.25, gain: 0.02, at: 0.35 });
    });
    return () => (a.src.stop(), l.stop(), stopDrips());
  },
  tavern(out) {
    const a = loopNoise("brown", out, { filter: "bandpass", freq: 420, q: 0.9, gain: 0.55 });
    const l = lfo(a.g.gain, { rate: 0.23, depth: 0.15 });
    const stopClinks = every(1.5, 5, () => {
      const f = 2200 + Math.random() * 1500;
      blip(out, { freq: f, dur: 0.18, type: "triangle", gain: 0.03 });
      if (Math.random() < 0.5) blip(out, { freq: f * 1.06, dur: 0.15, type: "triangle", gain: 0.02, at: 0.05 });
    });
    const stopThuds = every(4, 11, () => blip(out, { freq: 110, to: 60, dur: 0.15, type: "triangle", gain: 0.07 }));
    return () => (a.src.stop(), l.stop(), stopClinks(), stopThuds());
  },
  forest(out) {
    const a = loopNoise("pink", out, { filter: "bandpass", freq: 700, q: 0.5, gain: 0.2 });
    const l = lfo(a.f.frequency, { rate: 0.07, depth: 300 });
    const stopBirds = every(2.5, 8, () => {
      const f = 2500 + Math.random() * 1800;
      const n = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) blip(out, { freq: f, to: f * (1.15 + Math.random() * 0.3), dur: 0.08, gain: 0.025, at: i * 0.12 });
    });
    return () => (a.src.stop(), l.stop(), stopBirds());
  },
  fire(out) {
    const a = loopNoise("brown", out, { filter: "lowpass", freq: 300, gain: 0.45 });
    const stopCrackle = every(0.04, 0.4, () => burst(out, { dur: 0.01 + Math.random() * 0.02, freq: 1500 + Math.random() * 4000, gain: 0.04 + Math.random() * 0.08, q: 0.8 }));
    return () => (a.src.stop(), stopCrackle());
  },
  sea(out) {
    const a = loopNoise("pink", out, { filter: "lowpass", freq: 600, gain: 0.2 });
    const l = lfo(a.g.gain, { rate: 0.09, depth: 0.18 });
    const l2 = lfo(a.f.frequency, { rate: 0.09, depth: 350 });
    return () => (a.src.stop(), l.stop(), l2.stop());
  },
  wind(out) {
    const a = loopNoise("pink", out, { filter: "bandpass", freq: 500, q: 2.5, gain: 0.35 });
    const l = lfo(a.f.frequency, { rate: 0.06, depth: 280 });
    const l2 = lfo(a.g.gain, { rate: 0.13, depth: 0.12 });
    return () => (a.src.stop(), l.stop(), l2.stop());
  },
};

/** Start (or change) the ambient loop. kind "auto" follows sceneText. */
export function setAmbient(kind, sceneText = "") {
  want.ambient = kind;
  want.lastScene = sceneText;
  const target = kind === "auto" ? sceneAmbient(sceneText) : kind;
  if (amb?.kind === target) return;
  if (amb) {
    const old = amb;
    amb = null;
    const g = old.gain;
    g.gain.setTargetAtTime(0, ctx.currentTime, 0.6);
    setTimeout(() => (old.stop(), g.disconnect()), 2500);
  }
  if (target === "off" || !BUILD[target]) return;
  const c = audio();
  if (!c) return;
  if (c.state !== "running") {
    // browsers start audio only after a click: try once now, else the next click (unlock) does it
    c.resume()
      .then(() => c.state === "running" && want.ambient === kind && !amb && setAmbient(kind, sceneText))
      .catch(() => {});
    return;
  }
  const g = c.createGain();
  g.gain.value = 0;
  g.connect(ambGain);
  g.gain.setTargetAtTime(1, c.currentTime, 1.2);
  amb = { kind: target, gain: g, stop: BUILD[target](g) };
}

export function setSoundOptions({ fx, volume }) {
  if (typeof fx === "boolean") want.fx = fx;
  if (typeof volume === "number") {
    want.volume = volume;
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
  }
  if (want.fx) audio();
}

export const soundState = () => ({ ...want, playing: amb?.kind ?? null });
