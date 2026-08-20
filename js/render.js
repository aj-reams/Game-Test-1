// Canvas drawing. Takes any object shaped like a game state, so the host draws
// its own simulation and the guest draws its interpolated copy through exactly
// the same code path.

import {
  FIELD_W,
  FIELD_H,
  PADDLE_W,
  PADDLE_H,
  PADDLE_MARGIN,
  BALL_R,
} from './game.js';

const COLORS = {
  bg: '#0b0f19',
  net: 'rgba(122, 162, 247, 0.25)',
  paddle: '#c0caf5',
  you: '#7ee787',
  ball: '#ffffff',
  score: 'rgba(192, 202, 245, 0.35)',
  text: '#c0caf5',
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function draw(state, { youAre = 1 } = {}) {
    resize();
    // One transform maps the fixed 800x480 play field onto whatever size the
    // canvas happens to be, so all drawing below is in field units.
    ctx.setTransform(canvas.width / FIELD_W, 0, 0, canvas.height / FIELD_H, 0, 0);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);

    ctx.strokeStyle = COLORS.net;
    ctx.lineWidth = 4;
    ctx.setLineDash([14, 18]);
    ctx.beginPath();
    ctx.moveTo(FIELD_W / 2, 0);
    ctx.lineTo(FIELD_W / 2, FIELD_H);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = 'bold 90px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COLORS.score;
    ctx.textAlign = 'right';
    ctx.fillText(String(state.score[0]), FIELD_W / 2 - 40, 28);
    ctx.textAlign = 'left';
    ctx.fillText(String(state.score[1]), FIELD_W / 2 + 40, 28);

    paddle(PADDLE_MARGIN, state.p1.y, youAre === 1);
    paddle(FIELD_W - PADDLE_MARGIN - PADDLE_W, state.p2.y, youAre === 2);

    if (state.phase === 'play') {
      ctx.fillStyle = COLORS.ball;
      ctx.beginPath();
      ctx.arc(state.ball.x, state.ball.y, BALL_R, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.textAlign = 'center';
    if (state.phase === 'countdown') {
      ctx.fillStyle = COLORS.text;
      ctx.font = 'bold 76px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(String(Math.ceil(state.countdown)), FIELD_W / 2, FIELD_H / 2 - 48);
    }
  }

  function paddle(x, y, isYou) {
    ctx.fillStyle = isYou ? COLORS.you : COLORS.paddle;
    const top = y - PADDLE_H / 2;
    const r = 6;
    ctx.beginPath();
    ctx.roundRect(x, top, PADDLE_W, PADDLE_H, r);
    ctx.fill();
  }

  return { draw, resize };
}
