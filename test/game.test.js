// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Game from '../js/game.js';

const DT = 1 / 60;
const IDLE = { p1: {}, p2: {} };

/** Fast-forward past the serve countdown so the ball is live. */
function playing(seed = 1) {
  const state = Game.createState(seed);
  while (state.phase === 'countdown') Game.step(state, IDLE, DT);
  return state;
}

test('the ball is only served once the countdown expires', () => {
  const state = Game.createState(3);
  assert.equal(state.phase, 'countdown');
  assert.equal(state.ball.vx, 0);

  Game.step(state, IDLE, DT);
  assert.equal(state.phase, 'countdown', 'still counting down after one frame');

  const live = playing(3);
  assert.equal(live.phase, 'play');
  assert.ok(Math.abs(live.ball.vx) > 0, 'ball is moving after the serve');
  assert.ok(live.ball.vx > 0, 'the opening serve goes to player 2');
});

test('the ball bounces off the top and bottom walls', () => {
  const state = playing();
  state.ball.x = Game.FIELD_W / 2;
  state.ball.y = Game.BALL_R + 1;
  state.ball.vx = 0;
  state.ball.vy = -300;

  Game.step(state, IDLE, DT);

  assert.ok(state.ball.vy > 0, 'vertical velocity flipped');
  assert.ok(state.ball.y >= Game.BALL_R, 'ball stays inside the field');
  assert.ok(
    Game.takeEvents(state).some((e) => e.kind === 'wall'),
    'a wall event was emitted',
  );
});

test('a paddle hit reverses the ball and speeds it up', () => {
  const state = playing();
  state.p1.y = 240;
  state.ball.y = 240;
  state.ball.x = Game.PADDLE_MARGIN + Game.PADDLE_W + Game.BALL_R + 2;
  state.ball.vx = -400;
  state.ball.vy = 0;
  const speedBefore = Math.hypot(state.ball.vx, state.ball.vy);

  Game.step(state, IDLE, DT);

  assert.ok(state.ball.vx > 0, 'ball is heading back to the right');
  assert.ok(
    Math.hypot(state.ball.vx, state.ball.vy) > speedBefore,
    'rally speed increased',
  );
  assert.deepEqual(state.score, [0, 0], 'no point was scored');
});

test('hitting the paddle off-centre angles the ball away from the middle', () => {
  const state = playing();
  state.p1.y = 240;
  state.ball.y = 240 + Game.PADDLE_H / 2 - 2; // low on the paddle
  state.ball.x = Game.PADDLE_MARGIN + Game.PADDLE_W + Game.BALL_R + 2;
  state.ball.vx = -400;
  state.ball.vy = 0;

  Game.step(state, IDLE, DT);

  assert.ok(state.ball.vy > 0, 'a hit below centre sends the ball downward');
});

test('a ball past a paddle scores for the other player and re-serves', () => {
  const state = playing();
  state.p1.y = 60; // out of the way
  state.ball.x = Game.BALL_R + 1;
  state.ball.y = 400;
  state.ball.vx = -600;
  state.ball.vy = 0;

  // The point is only conceded once the ball has fully left the field.
  for (let i = 0; i < 10 && state.phase === 'play'; i++) Game.step(state, IDLE, DT);

  assert.deepEqual(state.score, [0, 1], 'player 2 scored');
  assert.equal(state.phase, 'countdown', 'a new countdown started');
  assert.equal(state.serveTo, 1, 'the player who conceded receives');
  assert.ok(
    Game.takeEvents(state).some((e) => e.kind === 'score' && e.by === 2),
    'a score event was emitted',
  );
});

test('a fast ball cannot tunnel through a paddle', () => {
  const state = playing();
  state.p1.y = 240;
  state.ball.y = 240;
  state.ball.x = 300;
  state.ball.vx = -Game.BALL_SPEED_MAX;
  state.ball.vy = 0;

  for (let i = 0; i < 60 && state.ball.vx < 0; i++) Game.step(state, IDLE, DT);

  assert.deepEqual(state.score, [0, 0], 'the ball never got past the paddle');
  assert.ok(state.ball.vx > 0, 'it bounced instead');
});

test('paddles move with input and stay inside the field', () => {
  const state = Game.createState();
  const startY = state.p1.y;

  Game.step(state, { p1: { up: true }, p2: { down: true } }, DT);
  assert.ok(state.p1.y < startY, 'up moves the paddle up');
  assert.ok(state.p2.y > startY, 'down moves the paddle down');

  for (let i = 0; i < 600; i++) Game.step(state, { p1: { up: true }, p2: { down: true } }, DT);
  assert.equal(state.p1.y, Game.PADDLE_H / 2, 'clamped at the top');
  assert.equal(state.p2.y, Game.FIELD_H - Game.PADDLE_H / 2, 'clamped at the bottom');
});

test('pointer control moves toward the requested position without teleporting', () => {
  const state = Game.createState();
  Game.step(state, { p1: { absY: 0 }, p2: {} }, DT);
  assert.ok(state.p1.y < Game.FIELD_H / 2, 'moved toward the top');
  assert.ok(state.p1.y > Game.PADDLE_H / 2, 'did not jump straight there in one frame');
});

test('the match ends at the winning score', () => {
  const state = playing();
  state.score = [Game.WIN_SCORE - 1, 0];
  state.p2.y = 60;
  state.ball.x = Game.FIELD_W - Game.BALL_R - 1;
  state.ball.y = 400;
  state.ball.vx = 600;
  state.ball.vy = 0;

  for (let i = 0; i < 10 && state.phase === 'play'; i++) Game.step(state, IDLE, DT);

  assert.equal(state.phase, 'over');
  assert.equal(state.winner, 1);
  assert.deepEqual(state.score, [Game.WIN_SCORE, 0]);
  assert.ok(Game.takeEvents(state).some((e) => e.kind === 'over' && e.winner === 1));
});

test('a finished match does not keep simulating', () => {
  const state = playing();
  state.phase = 'over';
  state.winner = 1;
  const before = { ...state.ball };

  Game.step(state, IDLE, DT);

  assert.deepEqual({ ...state.ball }, before, 'the ball is frozen');
});

test('resetMatch clears the score but keeps the paddles put', () => {
  const state = playing();
  state.score = [7, 4];
  state.p1.y = 100;
  state.p2.y = 380;

  const fresh = Game.resetMatch(state, 42);

  assert.deepEqual(fresh.score, [0, 0]);
  assert.equal(fresh.phase, 'countdown');
  assert.equal(fresh.p1.y, 100);
  assert.equal(fresh.p2.y, 380);
});

test('the simulation is deterministic for a given seed', () => {
  const run = (seed) => {
    const state = Game.createState(seed);
    for (let i = 0; i < 900; i++) Game.step(state, { p1: { up: true }, p2: {} }, DT);
    return JSON.stringify({ score: state.score, ball: state.ball, p1: state.p1 });
  };
  assert.equal(run(99), run(99));
  assert.notEqual(run(99), run(100));
});
