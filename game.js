(() => {
  "use strict";

  // ---------- setup ----------
  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d");
  const shadow = document.createElement("canvas");
  const sctx = shadow.getContext("2d");
  const roomLayer = document.createElement("canvas");
  const rctx = roomLayer.getContext("2d");

  const $ = (id) => document.getElementById(id);
  const ui = {
    light: $("st-light"), shots: $("st-shots"), hits: $("st-hits"), bulbs: $("st-bulbs"),
    hint: $("hint"), clock: $("clock"),
    btnBulb: $("btn-bulb"), btnSweep: $("btn-sweep"), btnSound: $("btn-sound"), btnReset: $("btn-reset"),
    card: $("broken-card"), btnBulbCard: $("btn-bulb-card"),
  };

  // big faint lettering painted on the wall behind everything
  const WALL_TEXT = ["HANDLE", "WITH CARE"];

  const GRAVITY = 1000;
  const SHADE_TOP = 22;   // half width at top of shade
  const SHADE_BOT = 78;   // half width at rim
  const SHADE_H = 78;
  const BULB_R = 20;
  const CHAIN_X = 58;
  const CHAIN_LEN = 64;
  const CHAIN_LINKS = 12;
  const STONE_R = 7;
  const MAX_PULL = 120;
  const LAUNCH_POWER = 10;
  const MAX_SHARDS = 450;
  const MAX_STONES = 30;

  const GOLD = { hi: "#f6dfa3", mid: "#d9b46a", lo: "#8e6b30", deep: "#5a421a" };

  let W = 0, H = 0, dpr = 1;
  const layout = { pivot: { x: 0, y: 0 }, L: 260, floorY: 0, sling: { x: 0, y: 0 } };

  const state = {
    theta: 0.04, omega: 0,
    switchOn: true, bulbIntact: true,
    lightLevel: 1, bulbScale: 1,
    shots: 0, hits: 0, bulbsLost: 0,
    sound: true,
    time: 0,
  };

  const stones = [];
  const sparks = [];
  const shards = [];   // glass stays on the floor until swept or reset
  const motes = [];
  const stars = [];
  const chain = [];    // verlet rope points; [0] is pinned to the shade rim

  const pointer = { x: 0, y: 0, mode: null, id: null, grabOffset: 0 };
  const pouch = { x: 0, y: 0 };
  let subH = 1 / 240;
  let vignette = null;
  let grain = null;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    for (const c of [canvas, shadow, roomLayer]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const wide = W > 760;
    layout.pivot.x = W * (wide ? 0.56 : 0.5);
    layout.pivot.y = 0;
    layout.L = clamp(H * 0.3, 130, 290);
    layout.floorY = H - clamp(H * 0.15, 86, 140);
    layout.sling.x = wide ? W * 0.24 : W * 0.5;
    layout.sling.y = layout.floorY + 14;
    if (pointer.mode !== "pull") Object.assign(pouch, restPouch());

    stars.length = 0;
    const win = windowRect();
    for (let i = 0; i < 30; i++) {
      stars.push({ x: win.x + Math.random() * win.w, y: win.y + Math.random() * win.h * 0.85, t: Math.random() * 6, s: Math.random() * 1.3 + 0.4 });
    }
    motes.length = 0;
    for (let i = 0; i < 55; i++) {
      motes.push({ x: Math.random() * W, y: Math.random() * layout.floorY, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 6, s: Math.random() * 1.6 + 0.4 });
    }
    for (const s of shards) if (s.resting) s.y = layout.floorY + s.depth;

    vignette = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.max(W, H) * 0.8);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.55)");

    initChain();
    paintRoom();
  }

  // ---------- helpers ----------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  function toLocal(x, y) {
    const dx = x - layout.pivot.x, dy = y - layout.pivot.y;
    const c = Math.cos(state.theta), s = Math.sin(state.theta);
    return { x: dx * c + dy * s, y: -dx * s + dy * c - layout.L };
  }
  function toWorld(lx, ly) {
    const a = lx, b = ly + layout.L;
    const c = Math.cos(state.theta), s = Math.sin(state.theta);
    return { x: layout.pivot.x + a * c - b * s, y: layout.pivot.y + a * s + b * c };
  }
  function shadeHalfWidth(ly) {
    return SHADE_TOP + (SHADE_BOT - SHADE_TOP) * clamp(ly / SHADE_H, 0, 1);
  }
  function inShade(l, pad) {
    return l.y > -pad && l.y < SHADE_H + pad && Math.abs(l.x) < shadeHalfWidth(l.y) + pad;
  }
  function bulbCenterLocal() { return { x: 0, y: SHADE_H + 6 }; }
  function inBulb(l, pad) {
    const b = bulbCenterLocal();
    return Math.hypot(l.x - b.x, l.y - b.y) < BULB_R + pad && l.y > SHADE_H - 10;
  }
  function chainAnchor() { return toWorld(CHAIN_X, SHADE_H - 2); }
  function chainEnd() { return chain[chain.length - 1]; }
  function restPouch() { return { x: layout.sling.x, y: layout.sling.y - 96 }; }
  function forkTips() {
    const s = layout.sling;
    return [{ x: s.x - 30, y: s.y - 104 }, { x: s.x + 30, y: s.y - 104 }];
  }
  function windowRect() {
    const w = clamp(W * 0.15, 110, 210), h = w * 1.35;
    const x = W > 760 ? W * 0.83 - w / 2 : W - w - 26;
    return { x, y: clamp(H * 0.2, 120, 200), w, h };
  }
  function isLit() { return state.switchOn && state.bulbIntact; }

  function metal(g, x0, y0, x1, y1) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, GOLD.lo);
    gr.addColorStop(0.35, GOLD.hi);
    gr.addColorStop(0.6, GOLD.mid);
    gr.addColorStop(1, GOLD.deep);
    return gr;
  }

  // ---------- chain (verlet rope) ----------
  function initChain() {
    chain.length = 0;
    const a = chainAnchor();
    const seg = CHAIN_LEN / (CHAIN_LINKS - 1);
    for (let i = 0; i < CHAIN_LINKS; i++) chain.push({ x: a.x, y: a.y + i * seg, px: a.x, py: a.y + i * seg });
  }

  function stepChain(h) {
    const a = chainAnchor();
    chain[0].x = chain[0].px = a.x;
    chain[0].y = chain[0].py = a.y;
    for (let i = 1; i < chain.length; i++) {
      const p = chain[i];
      const vx = (p.x - p.px) * 0.996, vy = (p.y - p.py) * 0.996;
      p.px = p.x; p.py = p.y;
      p.x += vx; p.y += vy + GRAVITY * h * h;
    }
    const seg = CHAIN_LEN / (CHAIN_LINKS - 1);
    for (let k = 0; k < 8; k++) {
      for (let i = 1; i < chain.length; i++) {
        const p = chain[i - 1], q = chain[i];
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 0.001;
        const diff = (d - seg) / d;
        if (i === 1) { q.x -= dx * diff; q.y -= dy * diff; }
        else {
          p.x += dx * diff * 0.5; p.y += dy * diff * 0.5;
          q.x -= dx * diff * 0.5; q.y -= dy * diff * 0.5;
        }
      }
    }
  }

  function kickChain(vx, vy) {
    for (let i = 1; i < chain.length; i++) {
      const w = i / (chain.length - 1);
      chain[i].px -= vx * w * subH;
      chain[i].py -= vy * w * subH;
    }
  }

  // ---------- audio (synthesized, no files) ----------
  let actx = null;
  function audio() {
    if (!state.sound) return null;
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  function tone(type, f0, f1, dur, vol) {
    const a = audio(); if (!a) return;
    const t = a.currentTime;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, hp) {
    const a = audio(); if (!a) return;
    const t = a.currentTime;
    const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp;
    const g = a.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(a.destination);
    src.start(t);
  }
  const sfx = {
    twang: (p) => { tone("triangle", 160 + p * 120, 70, 0.25, 0.25); noise(0.06, 0.08, 1500); },
    thunk: () => { tone("sine", 140, 55, 0.2, 0.45); noise(0.05, 0.12, 400); },
    shatter: () => {
      noise(0.6, 0.35, 2200);
      for (let i = 0; i < 5; i++) setTimeout(() => tone("sine", rand(2800, 6200), rand(2000, 5000), 0.12, 0.05), i * 40 + Math.random() * 60);
    },
    tinkle: () => tone("sine", rand(3500, 6500), rand(2500, 4000), 0.06, 0.018),
    click: () => { tone("square", 1900, 1200, 0.03, 0.08); tone("square", 900, 700, 0.03, 0.05); },
    chime: () => { tone("sine", 2400, 2300, 0.25, 0.04); tone("sine", 3600, 3500, 0.2, 0.025); },
    tap: () => tone("sine", 320, 180, 0.07, 0.08),
    crackle: () => noise(0.05, 0.05, 3000),
    screw: () => { for (let i = 0; i < 3; i++) setTimeout(() => tone("square", 600 + i * 80, 400, 0.03, 0.04), i * 90); },
    sweep: () => noise(0.5, 0.12, 900),
  };

  // ---------- actions ----------
  function toggleSwitch() {
    state.switchOn = !state.switchOn;
    sfx.click();
    if (state.switchOn && state.bulbIntact) state.lightLevel = 0.2;
    updateUI();
  }

  function breakBulb(vx, vy) {
    state.bulbIntact = false;
    state.bulbsLost++;
    sfx.shatter();
    const c = toWorld(0, SHADE_H + 4);
    for (let i = 0; i < 30; i++) {
      const ang = rand(0, Math.PI * 2), sp = rand(80, 440);
      shards.push({
        x: c.x, y: c.y,
        vx: Math.cos(ang) * sp + vx * 0.25, vy: Math.sin(ang) * sp + vy * 0.2 - 120,
        rot: rand(0, 6), vr: rand(-14, 14), size: rand(2.5, 8), seed: rand(0, 100),
        depth: rand(2, Math.max(6, (H - layout.floorY) * 0.55)), resting: false,
      });
    }
    if (shards.length > MAX_SHARDS) shards.splice(0, shards.length - MAX_SHARDS);
    burstSparks(c.x, c.y, 20);
    updateUI();
  }

  function burstSparks(x, y, n) {
    for (let i = 0; i < n; i++) {
      const ang = rand(0, Math.PI * 2), sp = rand(60, 320);
      sparks.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: rand(0.25, 0.6) });
    }
    if (sparks.length > 300) sparks.splice(0, sparks.length - 300);
  }

  function newBulb() {
    if (state.bulbIntact) return;
    state.bulbIntact = true;
    state.bulbScale = 0;
    sfx.screw();
    if (state.switchOn) state.lightLevel = 0;
    updateUI();
  }

  function sweep() {
    if (!shards.length && !stones.length) return;
    shards.length = 0;
    for (let i = stones.length - 1; i >= 0; i--) if (stones[i].resting) stones.splice(i, 1);
    sfx.sweep();
    updateUI();
  }

  function fire() {
    const rest = restPouch();
    const dx = rest.x - pouch.x, dy = rest.y - pouch.y;
    const pull = Math.hypot(dx, dy);
    if (pull < 14) return;
    stones.push({ x: pouch.x, y: pouch.y, vx: dx * LAUNCH_POWER, vy: dy * LAUNCH_POWER, spent: false, resting: false, depth: rand(4, 30), shade: rand(0, 1) });
    if (stones.length > MAX_STONES) stones.splice(0, stones.length - MAX_STONES);
    state.shots++;
    sfx.twang(pull / MAX_PULL);
    updateUI();
  }

  function reset() {
    stones.length = 0;
    sparks.length = 0;
    shards.length = 0;
    Object.assign(state, { theta: 0.04, omega: 0, switchOn: true, bulbIntact: true, lightLevel: 1, bulbScale: 1, shots: 0, hits: 0, bulbsLost: 0 });
    initChain();
    updateUI();
  }

  // ---------- UI ----------
  function updateUI() {
    const lightState = isLit() ? "on" : state.bulbIntact ? "off" : "broken";
    ui.light.textContent = lightState;
    ui.light.dataset.v = lightState;
    ui.shots.textContent = state.shots;
    ui.hits.textContent = state.hits;
    ui.bulbs.textContent = state.bulbsLost;
    ui.btnBulb.hidden = state.bulbIntact;
    ui.card.hidden = state.bulbIntact;
    ui.btnSweep.hidden = shards.length === 0;
    ui.btnSound.textContent = "Sound: " + (state.sound ? "on" : "off");
    ui.btnSound.setAttribute("aria-pressed", String(state.sound));
    if (!state.bulbIntact) ui.hint.textContent = "Well, that happened. Screw in a new bulb (R) or enjoy the dark.";
    else if (!state.switchOn) ui.hint.textContent = "Lights out. Tug the chain (or press L) to switch it back on.";
    else ui.hint.textContent = "Pull the slingshot back & let go · drag the shade to swing it · tug the chain";
  }

  function tickClock() {
    ui.clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  ui.btnBulb.addEventListener("click", newBulb);
  ui.btnBulbCard.addEventListener("click", newBulb);

  // keep the "new bulb" card hanging just under the swinging lamp
  function placeCard() {
    if (ui.card.hidden) return;
    const c = toWorld(0, SHADE_H + 40);
    const x = clamp(c.x, 166, W - 166);
    const y = clamp(c.y, 120, H - ui.card.offsetHeight - 90);
    ui.card.style.left = x + "px";
    ui.card.style.top = y + "px";
  }
  ui.btnSweep.addEventListener("click", sweep);
  ui.btnReset.addEventListener("click", reset);
  ui.btnSound.addEventListener("click", () => { state.sound = !state.sound; updateUI(); });

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "l") toggleSwitch();
    else if (k === "r") newBulb();
    else if (k === "s") sweep();
    else if (k === "m") { state.sound = !state.sound; updateUI(); }
  });

  // ---------- input ----------
  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function nearChain(x, y, pad) {
    for (let i = 2; i < chain.length; i++) {
      const p = chain[i];
      if (Math.hypot(x - p.x, y - p.y) < pad + (i === chain.length - 1 ? 10 : 3)) return true;
    }
    return false;
  }

  function hitTarget(p) {
    if (Math.hypot(p.x - pouch.x, p.y - pouch.y) < 46) return "pull";
    if (nearChain(p.x, p.y, 12)) return "chain";
    const l = toLocal(p.x, p.y);
    if (inShade(l, 10) || inBulb(l, 8)) return "lamp";
    return null;
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (pointer.id !== null) return;
    const p = pointerPos(e);
    const t = hitTarget(p);
    audio();
    if (!t) return;
    pointer.id = e.pointerId;
    pointer.x = p.x; pointer.y = p.y;
    canvas.setPointerCapture(e.pointerId);
    if (t === "chain") {
      toggleSwitch();
      sfx.chime();
      kickChain(rand(-160, 160), 380);
      pointer.mode = "chain";
    } else if (t === "lamp") {
      pointer.mode = "lamp";
      pointer.grabOffset = state.theta - Math.atan2(-(p.x - layout.pivot.x), p.y - layout.pivot.y);
      canvas.style.cursor = "grabbing";
    } else {
      pointer.mode = "pull";
      canvas.style.cursor = "grabbing";
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const p = pointerPos(e);
    pointer.x = p.x; pointer.y = p.y;
    if (pointer.id === null) {
      const t = hitTarget(p);
      canvas.style.cursor = t === "chain" ? "pointer" : t ? "grab" : "crosshair";
    }
  });

  function endPointer(e) {
    if (e.pointerId !== pointer.id) return;
    if (pointer.mode === "pull") fire();
    pointer.mode = null;
    pointer.id = null;
    canvas.style.cursor = "crosshair";
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  // ---------- simulation ----------
  function stepLamp(dt) {
    const L = layout.L;
    if (pointer.mode === "lamp") {
      const target = clamp(Math.atan2(-(pointer.x - layout.pivot.x), pointer.y - layout.pivot.y) + pointer.grabOffset, -1.35, 1.35);
      state.omega += ((target - state.theta) * 140 - state.omega * 14) * dt;
    } else {
      state.omega += (-(GRAVITY / L) * Math.sin(state.theta) - state.omega * 0.22) * dt;
    }
    state.theta += state.omega * dt;
    if (Math.abs(state.theta) > 1.45) { state.theta = Math.sign(state.theta) * 1.45; state.omega *= -0.3; }
    stepChain(dt);
  }

  function stoneHitsLamp(s) {
    if (nearChain(s.x, s.y, STONE_R)) {
      s.spent = true;
      state.hits++;
      toggleSwitch();
      sfx.chime();
      kickChain(s.vx * 0.5, s.vy * 0.5);
      s.vx *= 0.7; s.vy *= 0.7;
      const e = chainEnd();
      burstSparks(e.x, e.y, 5);
      return;
    }

    const l = toLocal(s.x, s.y);

    if (state.bulbIntact && inBulb(l, STONE_R)) {
      s.spent = true;
      state.hits++;
      addTorque(s, 3e-6);
      breakBulb(s.vx, s.vy);
      s.vx *= 0.6; s.vy *= 0.6;
      return;
    }

    if (inShade(l, STONE_R)) {
      s.spent = true;
      state.hits++;
      addTorque(s, 5e-6);
      // outward normal in lamp space (top, or one of the slanted sides)
      let nx, ny;
      if (l.y < 4) { nx = 0; ny = -1; }
      else {
        const side = Math.sign(l.x) || 1;
        nx = side * SHADE_H; ny = -(SHADE_BOT - SHADE_TOP);
        const m = Math.hypot(nx, ny); nx /= m; ny /= m;
      }
      const c = Math.cos(state.theta), sn = Math.sin(state.theta);
      const wx = nx * c - ny * sn, wy = nx * sn + ny * c;
      const dot = s.vx * wx + s.vy * wy;
      if (dot < 0) { s.vx -= 2 * dot * wx; s.vy -= 2 * dot * wy; }
      s.vx *= 0.45; s.vy *= 0.45;
      s.x += wx * 4; s.y += wy * 4;
      sfx.thunk();
      burstSparks(s.x, s.y, 4);
      updateUI();
    }
  }

  function addTorque(s, k) {
    const rx = s.x - layout.pivot.x, ry = s.y - layout.pivot.y;
    state.omega += (rx * s.vy - ry * s.vx) * k;
  }

  function stepStones(dt) {
    for (const s of stones) {
      if (s.resting) continue;
      const floor = layout.floorY + s.depth;
      s.vy += GRAVITY * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (!s.spent) stoneHitsLamp(s);

      if (s.y > floor - STONE_R && s.vy > 0) {
        s.y = floor - STONE_R;
        if (Math.abs(s.vy) > 120) sfx.tap();
        s.vy *= -0.35; s.vx *= 0.65;
        s.spent = true;
        if (Math.abs(s.vy) < 30 && Math.abs(s.vx) < 20) { s.resting = true; s.vx = s.vy = 0; }
      }
      if (s.x < STONE_R && s.vx < 0) { s.x = STONE_R; s.vx *= -0.5; }
      if (s.x > W - STONE_R && s.vx > 0) { s.x = W - STONE_R; s.vx *= -0.5; }
      if (s.y < STONE_R && s.vy < 0) { s.y = STONE_R; s.vy *= -0.4; }
    }
  }

  function stepParticles(dt) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life += dt;
      if (p.life > p.max) { sparks.splice(i, 1); continue; }
      p.vy += GRAVITY * 0.5 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }

    let landed = false;
    for (const p of shards) {
      if (p.resting) continue;
      const floor = layout.floorY + p.depth;
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.x < 2 || p.x > W - 2) { p.vx *= -0.5; p.x = clamp(p.x, 2, W - 2); }
      if (p.y > floor && p.vy > 0) {
        p.y = floor;
        if (p.vy > 150) landed = true;
        p.vy *= -0.28; p.vx *= 0.55; p.vr *= 0.4;
        if (Math.abs(p.vy) < 25) { p.vy = 0; p.vx = 0; p.vr = 0; p.resting = true; }
      }
    }
    if (landed && Math.random() < 0.5) sfx.tinkle();

    // a broken bulb with the switch on fizzles now and then
    if (state.switchOn && !state.bulbIntact && Math.random() < dt * 1.4) {
      const c = toWorld(0, SHADE_H - 6);
      burstSparks(c.x, c.y, 6);
      sfx.crackle();
    }

    for (const m of motes) {
      m.x += m.vx * dt; m.y += m.vy * dt;
      if (m.x < 0) m.x += W; if (m.x > W) m.x -= W;
      if (m.y < 0) m.y += layout.floorY; if (m.y > layout.floorY) m.y -= layout.floorY;
    }
  }

  function stepPouch(dt) {
    const rest = restPouch();
    if (pointer.mode === "pull") {
      let dx = pointer.x - rest.x, dy = pointer.y - rest.y;
      const d = Math.hypot(dx, dy);
      if (d > MAX_PULL) { dx *= MAX_PULL / d; dy *= MAX_PULL / d; }
      pouch.x = rest.x + dx; pouch.y = rest.y + dy;
    } else {
      const k = 1 - Math.exp(-dt * 30);
      pouch.x += (rest.x - pouch.x) * k;
      pouch.y += (rest.y - pouch.y) * k;
    }
  }

  function step(dt) {
    state.time += dt;
    const target = isLit() ? 1 : 0;
    state.lightLevel += (target - state.lightLevel) * (1 - Math.exp(-dt * (target ? 9 : 22)));
    if (target && state.lightLevel < 0.9 && Math.random() < 0.25) state.lightLevel *= 0.6; // warm-up flicker
    state.bulbScale = Math.min(1, state.bulbScale + dt * 3);

    const sub = 4;
    subH = dt / sub;
    for (let i = 0; i < sub; i++) { stepLamp(subH); stepStones(subH); }
    stepParticles(dt);
    stepPouch(dt);
  }

  // ---------- static room (painted once per resize) ----------
  function paintRoom() {
    const g = rctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const floor = layout.floorY;

    // wall: deep emerald-navy with a damask-ish dot pattern
    const wall = g.createLinearGradient(0, 0, 0, floor);
    wall.addColorStop(0, "#14262b");
    wall.addColorStop(1, "#1b3236");
    g.fillStyle = wall;
    g.fillRect(0, 0, W, floor);
    g.fillStyle = "rgba(217,180,106,0.05)";
    for (let y = 30, r = 0; y < floor; y += 34, r++) {
      for (let x = (r % 2) * 22; x < W; x += 44) {
        g.beginPath();
        g.moveTo(x, y - 5); g.lineTo(x + 4, y); g.lineTo(x, y + 5); g.lineTo(x - 4, y);
        g.closePath(); g.fill();
      }
    }

    // crown molding
    g.fillStyle = "#0c1719";
    g.fillRect(0, 0, W, 16);
    g.fillStyle = metal(g, 0, 16, 0, 19);
    g.fillRect(0, 16, W, 2);

    // faint oversized wall lettering
    const wallH = floor - 20;
    let fs = Math.min(W * 0.16, wallH * 0.32);
    g.font = `800 ${fs}px "Bricolage Grotesque", system-ui, sans-serif`;
    const widest = Math.max(...WALL_TEXT.map((t) => g.measureText(t).width));
    if (widest > W * 0.92) {
      fs *= (W * 0.92) / widest;
      g.font = `800 ${fs}px "Bricolage Grotesque", system-ui, sans-serif`;
    }
    if ("letterSpacing" in g) g.letterSpacing = `${Math.round(fs * -0.03)}px`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const lineH = fs * 0.95;
    const ty = 20 + wallH * 0.52 - ((WALL_TEXT.length - 1) * lineH) / 2;
    WALL_TEXT.forEach((t, i) => {
      g.fillStyle = "rgba(217,180,106,0.045)";
      g.fillText(t, W / 2, ty + i * lineH);
      g.strokeStyle = "rgba(246,223,163,0.07)";
      g.lineWidth = 1;
      g.strokeText(t, W / 2, ty + i * lineH);
    });
    if ("letterSpacing" in g) g.letterSpacing = "0px";

    // wainscoting
    const wTop = floor - clamp((floor) * 0.34, 90, 220);
    g.fillStyle = "#10201f";
    g.fillRect(0, wTop, W, floor - wTop);
    g.fillStyle = metal(g, 0, wTop - 4, 0, wTop + 4);
    g.fillRect(0, wTop - 3, W, 5);
    const panelW = 140, gap = 22;
    g.strokeStyle = "rgba(217,180,106,0.18)";
    g.lineWidth = 1;
    for (let x = gap; x + panelW < W; x += panelW + gap) {
      g.strokeRect(x + 0.5, wTop + 18.5, panelW, floor - wTop - 44);
      g.strokeStyle = "rgba(0,0,0,0.35)";
      g.strokeRect(x + 4.5, wTop + 22.5, panelW - 8, floor - wTop - 52);
      g.strokeStyle = "rgba(217,180,106,0.18)";
    }

    // framed artwork (original abstract piece) on the left wall
    const aw = clamp(W * 0.12, 90, 170), ah = aw * 1.25;
    const ax = W > 760 ? W * 0.08 : 18, ay = clamp(H * 0.22, 150, 220);
    if (W > 520) {
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.fillRect(ax + 6, ay + 8, aw, ah);
      g.fillStyle = metal(g, ax, ay, ax + aw, ay + ah);
      g.fillRect(ax - 8, ay - 8, aw + 16, ah + 16);
      g.fillStyle = "#e9e0cc";
      g.fillRect(ax, ay, aw, ah);
      g.fillStyle = "#f3ecdc";
      g.fillRect(ax + 10, ay + 10, aw - 20, ah - 20);
      g.save();
      g.beginPath(); g.rect(ax + 10, ay + 10, aw - 20, ah - 20); g.clip();
      const cx = ax + aw / 2, cy = ay + ah / 2;
      g.fillStyle = "#1f4f4a"; g.beginPath(); g.arc(cx - aw * 0.12, cy + ah * 0.1, aw * 0.3, 0, Math.PI * 2); g.fill();
      g.fillStyle = "rgba(201,110,74,0.9)"; g.beginPath(); g.arc(cx + aw * 0.14, cy - ah * 0.12, aw * 0.2, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#d9b46a"; g.fillRect(cx - aw * 0.3, cy + ah * 0.26, aw * 0.6, 3);
      g.restore();
    }

    // window + drapes
    const win = windowRect();
    g.fillStyle = "#0b1416";
    g.fillRect(win.x - 12, win.y - 12, win.w + 24, win.h + 24);
    const sky = g.createLinearGradient(0, win.y, 0, win.y + win.h);
    sky.addColorStop(0, "#050a1f");
    sky.addColorStop(1, "#1d2a55");
    g.fillStyle = sky;
    g.fillRect(win.x, win.y, win.w, win.h);
    // city glow at horizon
    const cg = g.createLinearGradient(0, win.y + win.h * 0.7, 0, win.y + win.h);
    cg.addColorStop(0, "rgba(255,160,90,0)");
    cg.addColorStop(1, "rgba(255,160,90,0.22)");
    g.fillStyle = cg;
    g.fillRect(win.x, win.y, win.w, win.h);
    g.fillStyle = "#070b18";
    for (let x = win.x, i = 0; x < win.x + win.w; i++) {
      const bw = 10 + ((i * 37) % 17), bh = win.h * (0.08 + ((i * 53) % 13) / 100);
      g.fillRect(x, win.y + win.h - bh, bw, bh);
      g.fillStyle = "rgba(255,210,140,0.55)";
      for (let wy = win.y + win.h - bh + 4; wy < win.y + win.h - 3; wy += 6) if ((i + wy) % 3 < 1.2) g.fillRect(x + 3, wy, 2, 2);
      g.fillStyle = "#070b18";
      x += bw + 2;
    }
    const mx = win.x + win.w * 0.7, my = win.y + win.h * 0.24, mr = win.w * 0.12;
    const moonGlow = g.createRadialGradient(mx, my, mr, mx, my, mr * 4);
    moonGlow.addColorStop(0, "rgba(240,235,210,0.25)");
    moonGlow.addColorStop(1, "rgba(240,235,210,0)");
    g.fillStyle = moonGlow;
    g.fillRect(win.x, win.y, win.w, win.h);
    g.fillStyle = "#f3efd8";
    g.beginPath(); g.arc(mx, my, mr, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#08102a";
    g.beginPath(); g.arc(mx - mr * 0.45, my - mr * 0.2, mr * 0.9, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#0b1416"; g.lineWidth = 6;
    g.beginPath();
    g.moveTo(win.x + win.w / 2, win.y); g.lineTo(win.x + win.w / 2, win.y + win.h);
    g.moveTo(win.x, win.y + win.h * 0.5); g.lineTo(win.x + win.w, win.y + win.h * 0.5);
    g.stroke();
    g.fillStyle = metal(g, 0, win.y + win.h + 10, 0, win.y + win.h + 20);
    g.fillRect(win.x - 20, win.y + win.h + 10, win.w + 40, 8);

    // velvet drapes
    const drapeTop = win.y - 34, drapeBot = floor - 6, dw = win.w * 0.42;
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? win.x - dw * 0.55 : win.x + win.w - dw * 0.45;
      const grad = g.createLinearGradient(x0, 0, x0 + dw, 0);
      for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, i % 2 ? "#5c1a26" : "#3a0f18");
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x0, drapeTop);
      g.lineTo(x0 + dw, drapeTop);
      const tie = win.y + win.h * 0.62;
      g.quadraticCurveTo(x0 + dw * (side < 0 ? 0.55 : 0.45), tie, x0 + dw + side * -6, drapeBot);
      g.lineTo(x0 + side * 6, drapeBot);
      g.closePath(); g.fill();
      g.fillStyle = metal(g, 0, tie - 3, 0, tie + 3);
      g.fillRect(x0 + dw * 0.18, tie - 3, dw * 0.64, 6);
    }
    g.fillStyle = metal(g, 0, drapeTop - 5, 0, drapeTop + 3);
    g.fillRect(win.x - dw * 0.7, drapeTop - 5, win.w + dw * 1.4, 6);
    for (const x of [win.x - dw * 0.7, win.x + win.w + dw * 0.7]) {
      g.beginPath(); g.arc(x, drapeTop - 2, 7, 0, Math.PI * 2); g.fill();
    }

    // skirting
    g.fillStyle = "#0a1413";
    g.fillRect(0, floor - 14, W, 14);
    g.fillStyle = metal(g, 0, floor - 15, 0, floor - 13);
    g.fillRect(0, floor - 15, W, 1.5);

    // walnut floor boards in soft perspective
    const fl = g.createLinearGradient(0, floor, 0, H);
    fl.addColorStop(0, "#3b2418");
    fl.addColorStop(1, "#1e120c");
    g.fillStyle = fl;
    g.fillRect(0, floor, W, H - floor);
    let y = floor, row = 0, bh = 8;
    while (y < H) {
      g.fillStyle = row % 2 ? "rgba(255,210,160,0.035)" : "rgba(0,0,0,0.08)";
      g.fillRect(0, y, W, bh);
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.fillRect(0, y, W, 1);
      const off = (row * 97) % 180;
      for (let x = off; x < W; x += 180 + bh * 6) g.fillRect(x, y, 1, bh);
      y += bh; bh *= 1.18; row++;
    }

    // rug under the lamp
    const rx = layout.pivot.x, ry = floor + (H - floor) * 0.48;
    const rw = clamp(W * 0.19, 110, 270), rh = (H - floor) * 0.32;
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.beginPath(); g.ellipse(rx, ry + 4, rw + 6, rh + 4, 0, 0, Math.PI * 2); g.fill();
    const rug = g.createRadialGradient(rx, ry, 0, rx, ry, rw);
    rug.addColorStop(0, "#7b2433");
    rug.addColorStop(1, "#4d1320");
    g.fillStyle = rug;
    g.beginPath(); g.ellipse(rx, ry, rw, rh, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = GOLD.mid; g.lineWidth = 2;
    g.beginPath(); g.ellipse(rx, ry, rw - 8, rh - 5, 0, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = "rgba(217,180,106,0.5)"; g.lineWidth = 1; g.setLineDash([2, 5]);
    g.beginPath(); g.ellipse(rx, ry, rw - 15, rh - 10, 0, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    g.fillStyle = "rgba(217,180,106,0.55)";
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = rx + Math.cos(a) * rw * 0.45, py = ry + Math.sin(a) * rh * 0.45;
      g.beginPath(); g.moveTo(px, py - 4); g.lineTo(px + 5, py); g.lineTo(px, py + 4); g.lineTo(px - 5, py); g.closePath(); g.fill();
    }
    g.beginPath(); g.ellipse(rx, ry, rw * 0.12, rh * 0.18, 0, 0, Math.PI * 2); g.fill();

    // film grain tile
    const gc = document.createElement("canvas");
    gc.width = gc.height = 128;
    const gx = gc.getContext("2d");
    const img = gx.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    gx.putImageData(img, 0, 0);
    grain = ctx.createPattern(gc, "repeat");
  }

  // ---------- drawing ----------
  function drawRoom() {
    ctx.drawImage(roomLayer, 0, 0, W, H);
    const win = windowRect();
    ctx.save();
    ctx.beginPath(); ctx.rect(win.x, win.y, win.w, win.h * 0.7); ctx.clip();
    for (const s of stars) {
      const a = 0.3 + 0.7 * Math.abs(Math.sin(state.time * 1.3 + s.t));
      ctx.fillStyle = `rgba(230,235,255,${a})`;
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }
    ctx.restore();
  }

  function drawDarkness() {
    const lvl = state.lightLevel;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, W, H);
    sctx.fillStyle = `rgba(4,5,12,${0.9 - lvl * 0.45})`;
    sctx.fillRect(0, 0, W, H);

    sctx.globalCompositeOperation = "destination-out";

    // moonlight spill from the window, always there
    const win = windowRect();
    const mg = sctx.createRadialGradient(win.x + win.w / 2, win.y + win.h / 2, 10, win.x + win.w / 2, win.y + win.h / 2, win.w * 1.5);
    mg.addColorStop(0, "rgba(0,0,0,0.6)");
    mg.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = mg;
    sctx.fillRect(0, 0, W, H);

    if (lvl > 0.01) {
      const bulb = toWorld(0, SHADE_H);
      const F = Math.max(W, H) * 2, h = 0.62;
      const pL = toWorld(-SHADE_BOT + 6, SHADE_H), pR = toWorld(SHADE_BOT - 6, SHADE_H);
      const fL = toWorld(-SHADE_BOT - F * Math.sin(h), SHADE_H + F * Math.cos(h));
      const fR = toWorld(SHADE_BOT + F * Math.sin(h), SHADE_H + F * Math.cos(h));
      const cg = sctx.createRadialGradient(bulb.x, bulb.y, 20, bulb.x, bulb.y, Math.max(H * 1.1, 600));
      cg.addColorStop(0, `rgba(0,0,0,${lvl})`);
      cg.addColorStop(0.55, `rgba(0,0,0,${lvl * 0.75})`);
      cg.addColorStop(1, "rgba(0,0,0,0)");
      sctx.fillStyle = cg;
      sctx.beginPath();
      sctx.moveTo(pL.x, pL.y); sctx.lineTo(fL.x, fL.y); sctx.lineTo(fR.x, fR.y); sctx.lineTo(pR.x, pR.y);
      sctx.closePath(); sctx.fill();

      const gg = sctx.createRadialGradient(bulb.x, bulb.y, 0, bulb.x, bulb.y, 280);
      gg.addColorStop(0, `rgba(0,0,0,${lvl * 0.7})`);
      gg.addColorStop(1, "rgba(0,0,0,0)");
      sctx.fillStyle = gg;
      sctx.fillRect(bulb.x - 280, bulb.y - 280, 560, 560);
    }

    ctx.drawImage(shadow, 0, 0, W, H);

    if (lvl > 0.01) {
      const bulb = toWorld(0, SHADE_H);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const warm = ctx.createRadialGradient(bulb.x, bulb.y, 0, bulb.x, bulb.y, H * 0.9);
      warm.addColorStop(0, `rgba(255,170,70,${0.2 * lvl})`);
      warm.addColorStop(1, "rgba(255,170,70,0)");
      ctx.fillStyle = warm;
      ctx.fillRect(0, 0, W, H);

      // glossy pool of light on the floor
      const axis = { x: -Math.sin(state.theta), y: Math.cos(state.theta) };
      const t = (layout.floorY + (H - layout.floorY) * 0.4 - bulb.y) / Math.max(axis.y, 0.2);
      const fx = bulb.x + axis.x * t, fy = layout.floorY + (H - layout.floorY) * 0.45;
      ctx.save();
      ctx.translate(fx, fy); ctx.scale(1, 0.28);
      const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, 260);
      pool.addColorStop(0, `rgba(255,190,110,${0.28 * lvl})`);
      pool.addColorStop(1, "rgba(255,190,110,0)");
      ctx.fillStyle = pool;
      ctx.beginPath(); ctx.arc(0, 0, 260, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      for (const m of motes) {
        const dx = m.x - bulb.x, dy = m.y - bulb.y, d = Math.hypot(dx, dy) || 1;
        const cos = (dx * axis.x + dy * axis.y) / d;
        if (cos < 0.8) continue;
        const a = (cos - 0.8) * 3 * lvl * (0.5 + 0.5 * Math.sin(state.time * 2 + m.s * 9));
        ctx.fillStyle = `rgba(255,225,170,${a * 0.6})`;
        ctx.fillRect(m.x, m.y, m.s, m.s);
      }
      ctx.restore();
    }
  }

  // rim ellipse radius (depth) — how much of the shade's underside we see
  const RIM_RY = 9;

  function shadePath(g) {
    // domed shade: rounded shoulders flaring out to a wide rim
    g.beginPath();
    g.moveTo(-SHADE_TOP, 0);
    g.bezierCurveTo(-SHADE_TOP - 34, 4, -SHADE_BOT + 2, 34, -SHADE_BOT, SHADE_H);
    g.ellipse(0, SHADE_H, SHADE_BOT, RIM_RY, 0, Math.PI, 0, true);
    g.bezierCurveTo(SHADE_BOT - 2, 34, SHADE_TOP + 34, 4, SHADE_TOP, 0);
    g.closePath();
  }

  function drawBulb(lit) {
    const b = bulbCenterLocal();
    const k = state.bulbScale;
    const cy = b.y;
    const r = (BULB_R + 3) * (0.3 + 0.7 * k);

    if (!state.bulbIntact) {
      // jagged glass left in the socket
      ctx.fillStyle = "rgba(210,225,235,0.55)";
      ctx.beginPath();
      ctx.moveTo(-13, SHADE_H - 6);
      ctx.lineTo(-15, SHADE_H + 6); ctx.lineTo(-9, SHADE_H + 1); ctx.lineTo(-5, SHADE_H + 11);
      ctx.lineTo(1, SHADE_H + 2); ctx.lineTo(7, SHADE_H + 8); ctx.lineTo(14, SHADE_H); ctx.lineTo(13, SHADE_H - 6);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.strokeStyle = "#7a6a50"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(-3, SHADE_H - 6); ctx.lineTo(-2, SHADE_H + 4); ctx.moveTo(3, SHADE_H - 6); ctx.lineTo(1, SHADE_H + 5); ctx.stroke();
      return;
    }

    // glass globe
    const glass = ctx.createRadialGradient(-r * 0.25, cy - r * 0.3, r * 0.1, 0, cy, r);
    if (lit > 0.05) {
      glass.addColorStop(0, "#fffdf6");
      glass.addColorStop(0.35, `rgba(255,236,190,${0.85 + lit * 0.15})`);
      glass.addColorStop(0.8, `rgba(255,190,100,${0.55 + lit * 0.35})`);
      glass.addColorStop(1, `rgba(230,140,60,${0.5 + lit * 0.3})`);
    } else {
      glass.addColorStop(0, "rgba(245,240,228,0.55)");
      glass.addColorStop(0.8, "rgba(170,160,140,0.35)");
      glass.addColorStop(1, "rgba(120,110,95,0.5)");
    }
    ctx.fillStyle = glass;
    ctx.beginPath(); ctx.arc(0, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 0.8; ctx.stroke();

    // Edison filament: two support wires + a looping coil
    ctx.strokeStyle = "rgba(120,100,80,0.8)"; ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-3 * k, cy - r * 0.9); ctx.lineTo(-8 * k, cy + 2);
    ctx.moveTo(3 * k, cy - r * 0.9); ctx.lineTo(8 * k, cy + 2);
    ctx.stroke();
    ctx.save();
    if (lit > 0.05) { ctx.shadowColor = "rgba(255,170,60,0.9)"; ctx.shadowBlur = 8 * lit; }
    ctx.strokeStyle = lit > 0.05 ? `rgb(255,${170 + 70 * lit},${90 + 80 * lit})` : "rgba(110,80,55,0.9)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-8 * k, cy + 2);
    for (let i = 1; i <= 4; i++) {
      const x0 = (-8 + (i - 1) * 4) * k, x1 = (-8 + i * 4) * k;
      ctx.quadraticCurveTo((x0 + x1) / 2, cy + (i % 2 ? 8 : -3) * k, x1, cy + 2);
    }
    ctx.stroke();
    ctx.restore();

    // reflections on the glass
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath(); ctx.ellipse(-r * 0.5, cy - r * 0.15, r * 0.1, r * 0.32, 0.35, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.beginPath(); ctx.arc(r * 0.4, cy + r * 0.45, r * 0.07, 0, Math.PI * 2); ctx.fill();
  }

  function drawLamp() {
    const lit = state.lightLevel;
    const { pivot, L } = layout;

    // ceiling canopy: stepped brass dome
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath(); ctx.ellipse(pivot.x, 18, 40, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = metal(ctx, pivot.x - 34, 0, pivot.x + 34, 0);
    ctx.beginPath(); ctx.ellipse(pivot.x, 14, 34, 14, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(pivot.x - 34, 12, 68, 4);
    ctx.fillStyle = metal(ctx, pivot.x - 8, 0, pivot.x + 8, 0);
    ctx.fillRect(pivot.x - 7, 16, 14, 10);

    ctx.save();
    ctx.translate(pivot.x, pivot.y);
    ctx.rotate(state.theta);

    // braided fabric cord (twisted look)
    ctx.lineCap = "butt";
    ctx.strokeStyle = "#101010"; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(0, 26); ctx.lineTo(0, L - 30); ctx.stroke();
    ctx.strokeStyle = "rgba(217,180,106,0.45)"; ctx.lineWidth = 1.2;
    for (let y = 28; y < L - 32; y += 5) {
      ctx.beginPath(); ctx.moveTo(-2.5, y); ctx.lineTo(2.5, y + 3); ctx.stroke();
    }

    // decorative gold beads along the cord
    for (const t of [0.32, 0.62]) {
      const y = 26 + (L - 56) * t;
      ctx.fillStyle = metal(ctx, -6, 0, 6, 0);
      ctx.beginPath(); ctx.ellipse(0, y, 5.5, 7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(-3.5, y - 10, 7, 3); ctx.fillRect(-3.5, y + 7, 7, 3);
    }

    ctx.translate(0, L);

    // fluted gold neck above the shade
    ctx.fillStyle = metal(ctx, -8, 0, 8, 0);
    ctx.fillRect(-7, -30, 14, 20);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    for (let x = -5; x <= 5; x += 3.3) ctx.fillRect(x, -29, 1, 18);
    ctx.fillStyle = metal(ctx, -11, 0, 11, 0);
    ctx.fillRect(-10, -32, 20, 4);
    ctx.fillRect(-12, -12, 24, 5);

    // --- underside of the shade (seen through the rim) ---
    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, SHADE_H, SHADE_BOT - 1, RIM_RY - 1, 0, 0, Math.PI * 2); ctx.clip();
    const inner = ctx.createRadialGradient(0, SHADE_H - 4, 4, 0, SHADE_H, SHADE_BOT);
    if (lit > 0.05) {
      inner.addColorStop(0, `rgba(255,248,225,${0.95})`);
      inner.addColorStop(0.4, `rgba(255,215,140,${0.6 + lit * 0.4})`);
      inner.addColorStop(1, `rgba(190,120,50,${0.6 + lit * 0.3})`);
    } else {
      inner.addColorStop(0, "#1c2f2a");
      inner.addColorStop(1, "#0a1715");
    }
    ctx.fillStyle = inner;
    ctx.fillRect(-SHADE_BOT, SHADE_H - RIM_RY, SHADE_BOT * 2, RIM_RY * 2);
    ctx.restore();

    // bulb: visible only through the rim opening and below it
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, SHADE_H, SHADE_BOT - 1, RIM_RY - 1, 0, Math.PI, 0);
    ctx.lineTo(SHADE_BOT, SHADE_H + 80);
    ctx.lineTo(-SHADE_BOT, SHADE_H + 80);
    ctx.closePath();
    ctx.clip();
    // socket collar peeking out
    ctx.fillStyle = metal(ctx, -9, 0, 9, 0);
    ctx.fillRect(-9, SHADE_H - 12, 18, 10);
    drawBulb(lit);
    ctx.restore();

    // --- outer dome (enamel, deep emerald) ---
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-SHADE_TOP, 0);
    ctx.bezierCurveTo(-SHADE_TOP - 34, 4, -SHADE_BOT + 2, 34, -SHADE_BOT, SHADE_H);
    ctx.ellipse(0, SHADE_H, SHADE_BOT, RIM_RY, 0, Math.PI, 0, true);
    ctx.bezierCurveTo(SHADE_BOT - 2, 34, SHADE_TOP + 34, 4, SHADE_TOP, 0);
    ctx.closePath();
    // keep the back half of the rim open so the lit interior shows
    ctx.moveTo(SHADE_BOT - 1, SHADE_H);
    ctx.ellipse(0, SHADE_H, SHADE_BOT - 1, RIM_RY - 1, 0, 0, Math.PI * 2);
    ctx.clip("evenodd");

    const body = ctx.createLinearGradient(-SHADE_BOT, 0, SHADE_BOT, 0);
    body.addColorStop(0, "#03110e");
    body.addColorStop(0.18, "#0d3a31");
    body.addColorStop(0.36, "#1f6b5a");
    body.addColorStop(0.46, "#3a9a82");
    body.addColorStop(0.56, "#1a5c4d");
    body.addColorStop(0.8, "#0a2d26");
    body.addColorStop(1, "#020c0a");
    ctx.fillStyle = body;
    ctx.fillRect(-SHADE_BOT - 4, -4, SHADE_BOT * 2 + 8, SHADE_H + RIM_RY + 4);

    // top-down shading so the dome reads as rounded
    const vert = ctx.createLinearGradient(0, 0, 0, SHADE_H);
    vert.addColorStop(0, "rgba(255,255,255,0.08)");
    vert.addColorStop(0.5, "rgba(0,0,0,0)");
    vert.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = vert;
    ctx.fillRect(-SHADE_BOT - 4, -4, SHADE_BOT * 2 + 8, SHADE_H + RIM_RY + 4);

    // subtle flutes following the dome curvature
    ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 1;
    for (let i = -5; i <= 5; i++) {
      const t = i / 5.5;
      ctx.beginPath();
      ctx.moveTo(t * SHADE_TOP, 0);
      ctx.quadraticCurveTo(t * (SHADE_TOP + 40), SHADE_H * 0.35, t * SHADE_BOT, SHADE_H + Math.sqrt(1 - t * t) * RIM_RY);
      ctx.stroke();
    }

    // glossy specular streaks
    const s1 = ctx.createLinearGradient(-SHADE_BOT * 0.7, 0, -SHADE_BOT * 0.2, 0);
    s1.addColorStop(0, "rgba(255,255,255,0)");
    s1.addColorStop(0.5, "rgba(255,255,255,0.32)");
    s1.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = s1;
    ctx.beginPath();
    ctx.moveTo(-SHADE_TOP + 4, 4);
    ctx.quadraticCurveTo(-SHADE_TOP - 20, SHADE_H * 0.4, -SHADE_BOT * 0.62, SHADE_H + 2);
    ctx.lineTo(-SHADE_BOT * 0.42, SHADE_H + 4);
    ctx.quadraticCurveTo(-SHADE_TOP - 4, SHADE_H * 0.4, -SHADE_TOP + 12, 4);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath();
    ctx.moveTo(SHADE_TOP - 2, 6);
    ctx.quadraticCurveTo(SHADE_TOP + 22, SHADE_H * 0.45, SHADE_BOT * 0.6, SHADE_H + 3);
    ctx.lineTo(SHADE_BOT * 0.68, SHADE_H + 2);
    ctx.quadraticCurveTo(SHADE_TOP + 30, SHADE_H * 0.45, SHADE_TOP + 4, 6);
    ctx.closePath(); ctx.fill();

    // warm bounce light licking the lower edge when lit
    if (lit > 0.05) {
      const bounce = ctx.createLinearGradient(0, SHADE_H - 22, 0, SHADE_H + RIM_RY);
      bounce.addColorStop(0, "rgba(255,190,110,0)");
      bounce.addColorStop(1, `rgba(255,190,110,${0.22 * lit})`);
      ctx.fillStyle = bounce;
      ctx.fillRect(-SHADE_BOT, SHADE_H - 22, SHADE_BOT * 2, 22 + RIM_RY);
    }
    ctx.restore();

    // gold rim lip (front half thicker, back half thin)
    ctx.lineCap = "round";
    ctx.strokeStyle = metal(ctx, -SHADE_BOT, 0, SHADE_BOT, 0);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(0, SHADE_H, SHADE_BOT, RIM_RY, 0, Math.PI, 0); ctx.stroke();
    ctx.lineWidth = 4.5;
    ctx.beginPath(); ctx.ellipse(0, SHADE_H, SHADE_BOT, RIM_RY, 0, 0, Math.PI); ctx.stroke();
    ctx.strokeStyle = "rgba(255,245,210,0.55)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, SHADE_H + 1.2, SHADE_BOT - 1, RIM_RY, 0, 0.25 * Math.PI, 0.75 * Math.PI); ctx.stroke();

    // gold collar where the neck meets the dome
    ctx.fillStyle = metal(ctx, -SHADE_TOP - 4, 0, SHADE_TOP + 4, 0);
    ctx.beginPath(); ctx.ellipse(0, 0, SHADE_TOP + 3, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,245,210,0.4)";
    ctx.beginPath(); ctx.ellipse(-4, -1.5, SHADE_TOP - 6, 1.2, 0, 0, Math.PI * 2); ctx.fill();

    ctx.restore();

    // bulb halo
    if (lit > 0.01 && state.bulbIntact) {
      const c = toWorld(0, SHADE_H + 10);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const hg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 110);
      hg.addColorStop(0, `rgba(255,215,140,${0.6 * lit})`);
      hg.addColorStop(0.4, `rgba(255,190,100,${0.2 * lit})`);
      hg.addColorStop(1, "rgba(255,170,70,0)");
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.arc(c.x, c.y, 110, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    drawChain();
  }

  function drawChain() {
    // brass ball chain
    for (let i = 0; i < chain.length - 1; i++) {
      const p = chain[i], q = chain[i + 1];
      const n = 3;
      for (let k = 0; k < n; k++) {
        const t = k / n, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
        const g = ctx.createRadialGradient(x - 0.8, y - 0.8, 0.2, x, y, 2.4);
        g.addColorStop(0, GOLD.hi); g.addColorStop(1, GOLD.lo);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }

    // gold cap + faceted crystal drop, oriented along the last link
    const e = chainEnd(), pe = chain[chain.length - 2];
    const ang = Math.atan2(e.y - pe.y, e.x - pe.x) - Math.PI / 2;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(ang);
    ctx.fillStyle = metal(ctx, -5, 0, 5, 0);
    ctx.beginPath(); ctx.ellipse(0, 2, 5, 4, 0, 0, Math.PI * 2); ctx.fill();
    const top = 5, mid = 14, bot = 30, w = 8;
    const facets = [
      [[0, top], [-w, mid], [0, mid], "rgba(220,240,255,0.9)"],
      [[0, top], [w, mid], [0, mid], "rgba(160,200,230,0.85)"],
      [[-w, mid], [0, bot], [0, mid], "rgba(120,170,210,0.85)"],
      [[w, mid], [0, bot], [0, mid], "rgba(80,130,180,0.85)"],
    ];
    for (const [a, b, c, col] of facets) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(-w, mid); ctx.lineTo(0, bot); ctx.lineTo(w, mid); ctx.closePath(); ctx.stroke();
    const tw = 0.5 + 0.5 * Math.sin(state.time * 3);
    ctx.fillStyle = `rgba(255,255,255,${0.4 + 0.5 * tw * state.lightLevel})`;
    ctx.beginPath(); ctx.arc(-2.5, mid - 2, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawSlingshot() {
    const s = layout.sling;
    const [tl, tr] = forkTips();

    // contact shadow
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath(); ctx.ellipse(s.x, s.y + 2, 30, 6, 0, 0, Math.PI * 2); ctx.fill();

    // back band
    ctx.lineCap = "round";
    ctx.strokeStyle = "#5e1c22";
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(tl.x, tl.y + 4); ctx.lineTo(pouch.x - 6, pouch.y); ctx.stroke();

    // polished walnut Y frame
    const wood = ctx.createLinearGradient(s.x - 30, 0, s.x + 30, 0);
    wood.addColorStop(0, "#3b2111");
    wood.addColorStop(0.45, "#8a5630");
    wood.addColorStop(0.6, "#6a3e20");
    wood.addColorStop(1, "#2e190c");
    ctx.strokeStyle = wood;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y - 56);
    ctx.moveTo(s.x, s.y - 54); ctx.quadraticCurveTo(s.x - 28, s.y - 66, tl.x, tl.y);
    ctx.moveTo(s.x, s.y - 54); ctx.quadraticCurveTo(s.x + 28, s.y - 66, tr.x, tr.y);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,220,180,0.18)"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(s.x - 3, s.y - 4); ctx.lineTo(s.x - 3, s.y - 52); ctx.stroke();

    // leather grip + gold ferrules
    ctx.fillStyle = "#2a1a12";
    ctx.fillRect(s.x - 8, s.y - 40, 16, 26);
    ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1;
    for (let y = s.y - 38; y < s.y - 14; y += 4) { ctx.beginPath(); ctx.moveTo(s.x - 8, y); ctx.lineTo(s.x + 8, y + 3); ctx.stroke(); }
    ctx.fillStyle = metal(ctx, s.x - 9, 0, s.x + 9, 0);
    ctx.fillRect(s.x - 9, s.y - 43, 18, 4);
    ctx.fillRect(s.x - 9, s.y - 15, 18, 4);
    for (const t of [tl, tr]) {
      ctx.fillStyle = metal(ctx, t.x - 7, 0, t.x + 7, 0);
      ctx.fillRect(t.x - 7, t.y - 2, 14, 7);
    }

    // loaded stone
    drawStone(pouch.x, pouch.y, 1, 0.5);
    // leather pouch
    const lp = ctx.createLinearGradient(0, pouch.y, 0, pouch.y + 8);
    lp.addColorStop(0, "#6b3f24"); lp.addColorStop(1, "#3a2114");
    ctx.fillStyle = lp;
    ctx.beginPath(); ctx.ellipse(pouch.x, pouch.y + 3, 11, 5.5, 0, 0, Math.PI); ctx.fill();

    // front band
    ctx.strokeStyle = "#8f2a33";
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(tr.x, tr.y + 4); ctx.lineTo(pouch.x + 6, pouch.y); ctx.stroke();
    ctx.strokeStyle = "rgba(255,160,160,0.25)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(tr.x, tr.y + 3); ctx.lineTo(pouch.x + 6, pouch.y - 1); ctx.stroke();

    // aim preview
    if (pointer.mode === "pull") {
      const rest = restPouch();
      let x = pouch.x, y = pouch.y, vx = (rest.x - pouch.x) * LAUNCH_POWER, vy = (rest.y - pouch.y) * LAUNCH_POWER;
      const dt = 0.028;
      for (let i = 0; i < 26; i++) {
        vy += GRAVITY * dt; x += vx * dt; y += vy * dt;
        if (y > layout.floorY) break;
        if (i % 2) continue;
        ctx.fillStyle = `rgba(246,223,163,${0.8 * (1 - i / 26)})`;
        ctx.beginPath(); ctx.arc(x, y, 2.6 - i * 0.05, 0, Math.PI * 2); ctx.fill();
      }
    } else if (state.shots === 0) {
      const p = 0.5 + 0.5 * Math.sin(state.time * 4);
      ctx.strokeStyle = `rgba(217,180,106,${0.3 + p * 0.5})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(pouch.x, pouch.y, 18 + p * 6, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawStone(x, y, alpha, shade) {
    const g = ctx.createRadialGradient(x - 2.5, y - 2.5, 0.5, x, y, STONE_R);
    const base = 150 + shade * 40;
    g.addColorStop(0, `rgba(235,235,240,${alpha})`);
    g.addColorStop(1, `rgba(${base - 70},${base - 70},${base - 60},${alpha})`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, STONE_R, 0, Math.PI * 2); ctx.fill();
  }

  function drawStones() {
    for (const s of stones) {
      if (s.resting) {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath(); ctx.ellipse(s.x + 2, s.y + STONE_R - 1, STONE_R, 2.5, 0, 0, Math.PI * 2); ctx.fill();
      }
      drawStone(s.x, s.y, 1, s.shade);
    }
  }

  function drawShards() {
    const lvl = state.lightLevel;
    for (const p of shards) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.resting) ctx.scale(1, 0.45);
      ctx.fillStyle = `rgba(215,230,242,${p.resting ? 0.55 : 0.8})`;
      ctx.beginPath();
      ctx.moveTo(-p.size, 0); ctx.lineTo(0, -p.size * 0.6); ctx.lineTo(p.size * 0.8, p.size * 0.4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      // resting glass glints in the lamp light
      if (p.resting) {
        const tw = Math.max(0, Math.sin(state.time * 2.2 + p.seed));
        const a = Math.pow(tw, 8) * (0.25 + 0.75 * lvl);
        if (a > 0.05) {
          ctx.fillStyle = `rgba(255,250,235,${a})`;
          ctx.fillRect(p.x - 3, p.y - 0.5, 6, 1);
          ctx.fillRect(p.x - 0.5, p.y - 3, 1, 6);
        }
      }
    }
  }

  function drawSparks() {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of sparks) {
      const t = p.life / p.max;
      ctx.fillStyle = `rgba(255,${210 - t * 120},110,${1 - t})`;
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    ctx.restore();
  }

  function drawPost() {
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
    if (grain) {
      ctx.save();
      ctx.globalAlpha = 0.035;
      ctx.translate((Math.random() * 128) | 0, (Math.random() * 128) | 0);
      ctx.fillStyle = grain;
      ctx.fillRect(-128, -128, W + 256, H + 256);
      ctx.restore();
    }
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRoom();
    drawDarkness();
    drawShards();
    drawLamp();
    drawStones();
    drawSparks();
    drawSlingshot();
    drawPost();
    placeCard();
  }

  // ---------- loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    step(dt);
    render();
    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  resize();
  // repaint once the web fonts arrive so the wall lettering uses the serif face
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(paintRoom);
  updateUI();
  tickClock();
  setInterval(tickClock, 10000);
  requestAnimationFrame(frame);
})();
