// Three short blips, synthesised so there are no audio files to ship.
// The AudioContext is created on the first sound, which is always after a
// click or keypress, so browsers never block it.

let ctx = null;
let muted = false;

function audio() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function blip(startHz, endHz, seconds, gain = 0.06) {
  if (muted) return;
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(startHz, ac.currentTime);
  if (endHz !== startHz) osc.frequency.exponentialRampToValueAtTime(endHz, ac.currentTime + seconds);
  amp.gain.setValueAtTime(gain, ac.currentTime);
  amp.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + seconds);
  osc.connect(amp).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + seconds);
}

export const sfx = {
  wall: () => blip(220, 220, 0.05),
  paddle: () => blip(440, 460, 0.06),
  score: () => blip(660, 180, 0.35),
  win: () => blip(520, 880, 0.5, 0.07),
  setMuted(value) {
    muted = value;
  },
  get muted() {
    return muted;
  },
};
