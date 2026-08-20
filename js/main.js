// Wiring: screens, the host's authoritative loop, and the guest's interpolating
// loop. The host simulates and broadcasts snapshots; the guest sends input,
// predicts its own paddle, and renders everything else slightly in the past.

import * as Game from './game.js';
import { createNet, MSG, describeError } from './net.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { sfx } from './sfx.js';

const FIXED_DT = 1 / 60;
const MAX_FRAME_SECS = 0.25; // a backgrounded tab must not fast-forward the match
const SNAPSHOT_MS = 33; // ~30 snapshots per second
const INTERP_DELAY_MS = 90; // guest renders this far behind, to have data to interpolate
const PREDICTION_SNAP = 26; // px of disagreement before the guest's paddle is corrected
const ROOM_ID_RE = /^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/;

const $ = (id) => document.getElementById(id);
const SCREENS = ['menu', 'lobby', 'connect', 'game', 'error'];

const canvas = $('field');
const renderer = createRenderer(canvas);
const input = createInput(canvas);

let net = null;
let role = null; // 'host' | 'guest'
let youAre = 1; // which paddle is mine
let sim = null; // host only: the authoritative state
let rafId = 0;
let lastFrameMs = 0;
let accumulator = 0;
let lastSnapshotMs = 0;
let snapshotSeq = 0;
let guestInput = {}; // host only: most recent input from the guest
let snapshots = []; // guest only: recent snapshots with local arrival times
let predicted = null; // guest only: locally predicted own paddle
let rematchPending = false;

function showScreen(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
}

function showOverlay(title, sub, { rematch = false } = {}) {
  $('overlay-title').textContent = title;
  $('overlay-sub').textContent = sub || '';
  $('btn-rematch').hidden = !rematch;
  $('btn-rematch').disabled = false;
  $('btn-rematch').textContent = 'Rematch';
  $('overlay').hidden = false;
}

function hideOverlay() {
  $('overlay').hidden = true;
  rematchPending = false;
}

function setHud() {
  $('hud-you').innerHTML =
    `<span class="you-dot">&#9646;</span> You are ${youAre === 1 ? 'the left' : 'the right'} paddle` +
    ` &middot; ${role === 'host' ? 'hosting' : 'guest'}`;
  $('hud-rtt').textContent = '';
}

function stopLoop() {
  cancelAnimationFrame(rafId);
  rafId = 0;
}

function startLoop(frame) {
  stopLoop();
  lastFrameMs = performance.now();
  accumulator = 0;
  rafId = requestAnimationFrame(frame);
}

/** Tear down everything and return to the menu. */
function leave() {
  stopLoop();
  net?.close();
  net = null;
  role = null;
  sim = null;
  snapshots = [];
  predicted = null;
  guestInput = {};
  input.reset();
  hideOverlay();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  showScreen('menu');
}

function fatal(code) {
  stopLoop();
  net?.close();
  net = null;
  $('error-text').textContent = describeError(code);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  showScreen('error');
}

// --- Hosting -----------------------------------------------------------

function startHost() {
  role = 'host';
  youAre = 1;
  showScreen('lobby');
  $('copy-status').textContent = ' ';

  net = createNet({
    onReady(roomId) {
      const link = `${location.origin}${location.pathname}#${roomId}`;
      $('share-link').value = link;
      history.replaceState(null, '', `#${roomId}`);
    },
    onConnected() {
      sim = Game.createState((Math.random() * 0xffffffff) >>> 0);
      guestInput = {};
      input.reset();
      hideOverlay();
      setHud();
      showScreen('game');
      startLoop(hostFrame);
    },
    onMessage: handleHostMessage,
    onDisconnected: onOpponentGone,
    onError: fatal,
    onRtt: showRtt,
  });
  net.host();
}

function handleHostMessage(msg) {
  if (msg.t === MSG.INPUT) {
    guestInput = msg.absY == null ? { up: !!msg.up, down: !!msg.down } : { absY: msg.absY };
  } else if (msg.t === MSG.EVENT && msg.kind === 'rematch-request') {
    startRematch();
  }
}

function snapshotOf(state) {
  const round = (n) => Math.round(n * 10) / 10;
  return {
    t: MSG.SNAPSHOT,
    n: ++snapshotSeq,
    bx: round(state.ball.x),
    by: round(state.ball.y),
    a: round(state.p1.y),
    b: round(state.p2.y),
    s0: state.score[0],
    s1: state.score[1],
    ph: state.phase,
    cd: round(state.countdown * 100) / 100,
  };
}

function hostFrame(nowMs) {
  rafId = requestAnimationFrame(hostFrame);
  const dt = Math.min((nowMs - lastFrameMs) / 1000, MAX_FRAME_SECS);
  lastFrameMs = nowMs;

  const inputs = { p1: input.read(), p2: guestInput };
  accumulator += dt;
  while (accumulator >= FIXED_DT) {
    Game.step(sim, inputs, FIXED_DT);
    accumulator -= FIXED_DT;
  }

  for (const event of Game.takeEvents(sim)) {
    playEventSound(event);
    net.send({ t: MSG.EVENT, kind: event.kind, by: event.by, winner: event.winner });
    if (event.kind === 'over') showWinner(event.winner);
  }

  if (nowMs - lastSnapshotMs >= SNAPSHOT_MS) {
    lastSnapshotMs = nowMs;
    net.send(snapshotOf(sim));
  }

  renderer.draw(sim, { youAre });
}

function startRematch() {
  if (role !== 'host' || !sim) return;
  sim = Game.resetMatch(sim, (Math.random() * 0xffffffff) >>> 0);
  hideOverlay();
  net.send({ t: MSG.EVENT, kind: 'rematch' });
  net.send(snapshotOf(sim));
}

// --- Joining -----------------------------------------------------------

function startJoin(roomId) {
  role = 'guest';
  youAre = 2;
  showScreen('connect');

  net = createNet({
    onConnected() {
      snapshots = [];
      predicted = null;
      input.reset();
      hideOverlay();
      setHud();
      showScreen('game');
      startLoop(guestFrame);
    },
    onMessage: handleGuestMessage,
    onDisconnected: onOpponentGone,
    onError: fatal,
    onRtt: showRtt,
  });
  net.join(roomId);
}

function handleGuestMessage(msg) {
  if (msg.t === MSG.SNAPSHOT) {
    snapshots.push({ ...msg, at: performance.now() });
    if (snapshots.length > 8) snapshots.shift();
    if (!predicted) predicted = { y: msg.b };
    return;
  }
  if (msg.t !== MSG.EVENT) return;

  if (msg.kind === 'full') {
    fatal('full');
  } else if (msg.kind === 'over') {
    playEventSound(msg);
    showWinner(msg.winner);
  } else if (msg.kind === 'rematch') {
    snapshots = [];
    hideOverlay();
  } else {
    playEventSound(msg);
  }
}

/** Reconstruct a renderable state from the snapshot stream. */
function interpolatedState(nowMs) {
  if (!snapshots.length) return null;
  const target = nowMs - INTERP_DELAY_MS;

  let older = snapshots[0];
  let newer = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].at <= target) {
      older = snapshots[i];
      newer = snapshots[i + 1] || null;
      break;
    }
    if (i === 0) {
      older = snapshots[0];
      newer = snapshots[1] || null;
    }
  }

  const span = newer ? newer.at - older.at : 0;
  const alpha = span > 0 ? Math.min(1, Math.max(0, (target - older.at) / span)) : 0;
  const mix = (from, to) => (newer ? from + (to - from) * alpha : from);

  return {
    ball: {
      x: mix(older.bx, newer?.bx),
      y: mix(older.by, newer?.by),
    },
    p1: { y: mix(older.a, newer?.a) },
    p2: { y: mix(older.b, newer?.b) },
    score: [older.s0, older.s1],
    phase: older.ph,
    // The countdown keeps ticking locally between snapshots so it never stutters.
    countdown: Math.max(0, older.cd - (target - older.at) / 1000),
    authoritativeMine: newer ? newer.b : older.b,
  };
}

function guestFrame(nowMs) {
  rafId = requestAnimationFrame(guestFrame);
  const dt = Math.min((nowMs - lastFrameMs) / 1000, MAX_FRAME_SECS);
  lastFrameMs = nowMs;

  const mine = input.read();
  net.send({
    t: MSG.INPUT,
    up: !!mine.up,
    down: !!mine.down,
    absY: mine.absY == null ? null : Math.round(mine.absY * 1000) / 1000,
  });

  const view = interpolatedState(nowMs);
  if (!view) return;

  if (!predicted) predicted = { y: view.authoritativeMine };
  Game.stepPaddle(predicted, mine, dt);
  // Ease back toward the host's version; snap if we have drifted badly.
  const drift = view.authoritativeMine - predicted.y;
  predicted.y += Math.abs(drift) > PREDICTION_SNAP ? drift : drift * 0.12;
  view.p2.y = predicted.y;

  renderer.draw(view, { youAre });
}

// --- Shared ------------------------------------------------------------

function playEventSound(event) {
  if (event.kind === 'wall') sfx.wall();
  else if (event.kind === 'paddle') sfx.paddle();
  else if (event.kind === 'score') sfx.score();
  else if (event.kind === 'over') sfx.win();
}

function showWinner(winner) {
  showOverlay(
    winner === youAre ? 'You win!' : 'You lose',
    role === 'host' ? 'Play again with the same opponent?' : 'Ask the host for a rematch.',
    { rematch: true },
  );
}

function onOpponentGone(code) {
  stopLoop();
  if (role === 'host' && $('screen-lobby').hidden === false) return; // nobody had joined yet
  showOverlay('Opponent disconnected', describeError(code), { rematch: false });
  showScreen('game');
}

function showRtt(ms) {
  $('hud-rtt').textContent = `${Math.round(ms)} ms`;
}

async function copyLink() {
  const field = $('share-link');
  try {
    await navigator.clipboard.writeText(field.value);
    $('copy-status').textContent = 'Link copied.';
  } catch {
    // Clipboard access needs a secure context; fall back to selecting the text.
    field.select();
    field.setSelectionRange(0, field.value.length);
    $('copy-status').textContent = 'Press Ctrl/Cmd+C to copy the selected link.';
  }
}

// --- Boot --------------------------------------------------------------

$('btn-host').addEventListener('click', startHost);
$('btn-copy').addEventListener('click', copyLink);
$('share-link').addEventListener('focus', (e) => e.target.select());
$('btn-cancel-host').addEventListener('click', leave);
$('btn-cancel-join').addEventListener('click', leave);
$('btn-leave').addEventListener('click', leave);
$('btn-overlay-menu').addEventListener('click', leave);
$('btn-error-menu').addEventListener('click', leave);

$('btn-rematch').addEventListener('click', () => {
  if (role === 'host') {
    startRematch();
  } else if (!rematchPending) {
    rematchPending = true;
    net.send({ t: MSG.EVENT, kind: 'rematch-request' });
    $('btn-rematch').disabled = true;
    $('btn-rematch').textContent = 'Asking…';
  }
});

$('btn-mute').addEventListener('click', (e) => {
  sfx.setMuted(!sfx.muted);
  e.target.textContent = sfx.muted ? 'Sound off' : 'Sound on';
  e.target.setAttribute('aria-pressed', String(sfx.muted));
});

window.addEventListener('beforeunload', () => net?.close());
window.addEventListener('resize', () => renderer.resize());

// Read-only view of the live match, for the browser console and the
// end-to-end tests. Nothing in the game reads this back.
window.__pong = {
  get role() {
    return role;
  },
  get youAre() {
    return youAre;
  },
  get connected() {
    return !!net?.connected;
  },
  get state() {
    return role === 'host' ? sim : interpolatedState(performance.now());
  },
};

const hashId = location.hash.slice(1);
if (ROOM_ID_RE.test(hashId)) startJoin(hashId);
else showScreen('menu');
