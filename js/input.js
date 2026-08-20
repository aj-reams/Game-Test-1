// Turns keyboard, mouse and touch into the {up, down} / {absY} shape the
// simulation expects. Keyboard wins while a key is held so the two control
// schemes never fight each other.

const UP_KEYS = new Set(['KeyW', 'ArrowUp']);
const DOWN_KEYS = new Set(['KeyS', 'ArrowDown']);

export function createInput(surface) {
  let up = false;
  let down = false;
  let absY = null;
  let pointerDown = false;

  const onKeyDown = (e) => {
    if (UP_KEYS.has(e.code)) up = true;
    else if (DOWN_KEYS.has(e.code)) down = true;
    else return;
    absY = null; // keyboard takes over from the pointer
    e.preventDefault(); // stop the arrow keys scrolling the page
  };

  const onKeyUp = (e) => {
    if (UP_KEYS.has(e.code)) up = false;
    else if (DOWN_KEYS.has(e.code)) down = false;
  };

  const track = (e) => {
    const rect = surface.getBoundingClientRect();
    if (!rect.height) return;
    absY = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    up = false;
    down = false;
  };

  const onPointerDown = (e) => {
    pointerDown = true;
    surface.setPointerCapture?.(e.pointerId);
    track(e);
    e.preventDefault();
  };
  const onPointerMove = (e) => {
    // Follow the mouse whenever it is over the field; on touch, only while held.
    if (e.pointerType === 'mouse' || pointerDown) track(e);
  };
  const onPointerUp = (e) => {
    pointerDown = false;
    surface.releasePointerCapture?.(e.pointerId);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove);
  surface.addEventListener('pointerup', onPointerUp);
  surface.addEventListener('pointercancel', onPointerUp);

  return {
    read() {
      if (up || down) return { up, down };
      if (absY !== null) return { absY };
      return {};
    },
    reset() {
      up = down = false;
      absY = null;
      pointerDown = false;
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
