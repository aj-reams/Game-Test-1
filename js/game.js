// Pure Pong simulation. No DOM, no network, no globals: given a state, a set of
// inputs and a timestep it produces the next state. The host runs this; the
// guest only ever renders snapshots of it. Being pure is what makes it testable
// under `node --test`.

export const FIELD_W = 800;
export const FIELD_H = 480;

export const PADDLE_W = 14;
export const PADDLE_H = 84;
export const PADDLE_MARGIN = 28;
export const PADDLE_SPEED = 470;

export const BALL_R = 9;
export const BALL_SPEED_START = 360;
export const BALL_SPEED_MAX = 900;
export const BALL_SPEED_GAIN = 1.045;

export const WIN_SCORE = 11;
export const COUNTDOWN_SECS = 2;
export const MAX_BOUNCE_ANGLE = Math.PI / 3; // 60 degrees off the horizontal

const P1_FRONT = PADDLE_MARGIN + PADDLE_W; // right edge of the left paddle
const P2_FRONT = FIELD_W - PADDLE_MARGIN - PADDLE_W; // left edge of the right paddle

// Deterministic LCG so a given seed always produces the same match. Tests rely
// on this; it also means the serve angle is never a surprise to debug.
function nextRandom(state) {
  state.seed = (state.seed * 1664525 + 1013904223) >>> 0;
  return state.seed / 4294967296;
}

export function createState(seed = 1) {
  return {
    seed: seed >>> 0,
    phase: 'countdown',
    countdown: COUNTDOWN_SECS,
    serveTo: 2, // player 2 receives the opening serve
    ball: { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0 },
    p1: { y: FIELD_H / 2 },
    p2: { y: FIELD_H / 2 },
    score: [0, 0],
    winner: 0,
    events: [],
  };
}

function serve(state) {
  const toward = state.serveTo === 2 ? 1 : -1;
  // Keep the opening angle shallow so the serve always reads as "at" a player.
  const angle = (nextRandom(state) - 0.5) * (MAX_BOUNCE_ANGLE * 0.7);
  state.ball.x = FIELD_W / 2;
  state.ball.y = FIELD_H / 2;
  state.ball.vx = Math.cos(angle) * BALL_SPEED_START * toward;
  state.ball.vy = Math.sin(angle) * BALL_SPEED_START;
}

function movePaddle(paddle, input, dt) {
  const half = PADDLE_H / 2;
  const max = PADDLE_SPEED * dt;
  if (input && typeof input.absY === 'number') {
    // Pointer/touch control: chase the requested position, but never faster
    // than a key-holding player could move, so neither input method wins.
    const target = clamp(input.absY * FIELD_H, half, FIELD_H - half);
    const delta = clamp(target - paddle.y, -max * 2, max * 2);
    paddle.y = paddle.y + delta;
  } else if (input) {
    const dir = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    paddle.y = paddle.y + dir * max;
  }
  paddle.y = clamp(paddle.y, half, FIELD_H - half);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function bounceOffPaddle(state, paddleY, dirX) {
  const ball = state.ball;
  const offset = clamp((ball.y - paddleY) / (PADDLE_H / 2), -1, 1);
  const angle = offset * MAX_BOUNCE_ANGLE;
  const speed = Math.min(Math.hypot(ball.vx, ball.vy) * BALL_SPEED_GAIN, BALL_SPEED_MAX);
  ball.vx = Math.cos(angle) * speed * dirX;
  ball.vy = Math.sin(angle) * speed;
  state.events.push({ kind: 'paddle' });
}

function scorePoint(state, scorer) {
  state.score[scorer - 1] += 1;
  state.events.push({ kind: 'score', by: scorer });
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.x = FIELD_W / 2;
  state.ball.y = FIELD_H / 2;
  if (state.score[scorer - 1] >= WIN_SCORE) {
    state.phase = 'over';
    state.winner = scorer;
    state.events.push({ kind: 'over', winner: scorer });
  } else {
    state.phase = 'countdown';
    state.countdown = COUNTDOWN_SECS;
    state.serveTo = scorer === 1 ? 2 : 1; // loser of the point receives
  }
}

// Advance the ball by `dt`, in slices no larger than the ball's radius so a fast
// ball can never tunnel through a paddle between frames.
function moveBall(state, dt) {
  const ball = state.ball;
  const distance = Math.hypot(ball.vx, ball.vy) * dt;
  const slices = Math.max(1, Math.ceil(distance / BALL_R));
  const h = dt / slices;

  for (let i = 0; i < slices; i++) {
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;

    if (ball.y < BALL_R && ball.vy < 0) {
      ball.y = BALL_R;
      ball.vy = -ball.vy;
      state.events.push({ kind: 'wall' });
    } else if (ball.y > FIELD_H - BALL_R && ball.vy > 0) {
      ball.y = FIELD_H - BALL_R;
      ball.vy = -ball.vy;
      state.events.push({ kind: 'wall' });
    }

    if (ball.vx < 0 && ball.x - BALL_R <= P1_FRONT && ball.x + BALL_R >= PADDLE_MARGIN) {
      if (Math.abs(ball.y - state.p1.y) <= PADDLE_H / 2 + BALL_R) {
        ball.x = P1_FRONT + BALL_R;
        bounceOffPaddle(state, state.p1.y, 1);
        continue;
      }
    } else if (ball.vx > 0 && ball.x + BALL_R >= P2_FRONT && ball.x - BALL_R <= P2_FRONT + PADDLE_W) {
      if (Math.abs(ball.y - state.p2.y) <= PADDLE_H / 2 + BALL_R) {
        ball.x = P2_FRONT - BALL_R;
        bounceOffPaddle(state, state.p2.y, -1);
        continue;
      }
    }

    if (ball.x + BALL_R < 0) return scorePoint(state, 2);
    if (ball.x - BALL_R > FIELD_W) return scorePoint(state, 1);
  }
}

/**
 * Move a single paddle. Exported so the guest can predict its own paddle
 * locally instead of waiting a round trip to see it move.
 */
export function stepPaddle(paddle, input, dt) {
  movePaddle(paddle, input, dt);
  return paddle;
}

/**
 * Advance the match by one fixed timestep.
 * @param {object} state  mutated in place
 * @param {{p1?: object, p2?: object}} inputs  per-player {up, down} or {absY}
 * @param {number} dt  seconds
 */
export function step(state, inputs, dt) {
  movePaddle(state.p1, inputs.p1, dt);
  movePaddle(state.p2, inputs.p2, dt);

  if (state.phase === 'countdown') {
    state.countdown -= dt;
    if (state.countdown <= 0) {
      state.countdown = 0;
      state.phase = 'play';
      serve(state);
    }
  } else if (state.phase === 'play') {
    moveBall(state, dt);
  }
  return state;
}

/** Reset scores for a rematch, keeping paddles where they are. */
export function resetMatch(state, seed = state.seed) {
  const fresh = createState(seed);
  fresh.p1.y = state.p1.y;
  fresh.p2.y = state.p2.y;
  return fresh;
}

/** Drain the event queue; callers use these for sound and network events. */
export function takeEvents(state) {
  const events = state.events;
  state.events = [];
  return events;
}
