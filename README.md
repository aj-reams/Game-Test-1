# Pong

Two-player Pong in the browser. One player clicks **Host a Game**, gets a link, and sends it to
whoever they want to play. Opening that link drops the second player straight into the match.

There is no game server. The host's browser *is* the server — it runs the authoritative
simulation and streams the state to the guest over a direct WebRTC connection. That means the
whole thing is a folder of static files you can host anywhere, for free.

## Play

```bash
npm start           # or: python3 -m http.server 8000
```

Then open <http://localhost:8000>. ES modules need to be served over HTTP, so opening
`index.html` from the filesystem won't work.

**Controls** — <kbd>W</kbd>/<kbd>S</kbd> or <kbd>↑</kbd>/<kbd>↓</kbd>, or drag anywhere on the
field (works on touch). First to 11 points wins; either player can start a rematch.

## How the hosting works

```
Host browser                                   Guest browser
┌───────────────────────────┐                 ┌───────────────────────────┐
│ input → own paddle        │ ◀─── input ──── │ input → predicted paddle  │
│ AUTHORITATIVE simulation  │                 │                           │
│ at a fixed 60 Hz          │ ─── snapshot ─▶ │ interpolated ball,        │
│                           │     ~30/s       │ opponent paddle, score    │
└───────────────────────────┘                 └───────────────────────────┘
         └────── broker used only for the initial handshake ──────┘
```

1. Hosting mints a random six-character room ID and registers it with a
   [PeerJS](https://peerjs.com) broker. The ID goes in the URL fragment: `…/#a4f9c2`.
2. Opening that link looks the ID up, and the two browsers negotiate a direct WebRTC data
   channel. From that point the broker is out of the loop.
3. The host simulates the match and sends ~30 snapshots a second. The guest sends its paddle
   input, renders everything else ~90 ms in the past so it has two snapshots to interpolate
   between, and predicts its own paddle locally so the controls feel instant.

Because the host is authoritative there is no state to reconcile between the two machines —
whatever the host says the ball did is what happened.

### The one caveat

Pure peer-to-peer WebRTC needs the two networks to let the browsers reach each other. Home
connections almost always work. Some corporate networks and a few mobile carriers use NATs
strict enough to block it, and the free path here has no TURN relay to fall back on — the game
says so plainly instead of hanging. To cover those cases, add a TURN server to `iceServers` in
[`js/net.js`](js/net.js).

### Using your own broker

The default is PeerJS's free public broker, which is fine for casual play but is rate-limited and
occasionally down. To run your own, set `window.PONG_PEER_CONFIG` before the app loads (in
`index.html`), with any [PeerJS options](https://peerjs.com/docs/#peer-options):

```html
<script>
  window.PONG_PEER_CONFIG = { host: 'peer.example.com', port: 443, path: '/', secure: true };
</script>
```

## Deploying

Any static host works — copy the repository contents up and you're done. For GitHub Pages,
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and publishes on
every push to `main`. It needs **Settings → Pages → Source: GitHub Actions** set once in the
repository; after that the site is at `https://<user>.github.io/<repo>/`.

Serve it over HTTPS. Browsers only allow WebRTC and the clipboard on secure origins (`localhost`
counts as one).

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | Every screen, toggled by JavaScript |
| `js/game.js` | The simulation. Pure — no DOM, no network, no globals |
| `js/net.js` | PeerJS wrapper: hosting, joining, heartbeats, error mapping |
| `js/main.js` | Screen flow, the host's game loop and the guest's interpolating loop |
| `js/render.js` | Canvas drawing, shared by both players |
| `js/input.js` | Keyboard, mouse and touch → paddle intent |
| `js/sfx.js` | Synthesised blips, so there are no audio files |
| `vendor/peerjs.min.js` | Vendored PeerJS 1.5.5 — no CDN at runtime |

## Tests

```bash
npm test        # the simulation, under node --test. No dependencies.
npm run test:e2e    # two real Chromium pages actually playing each other
```

The end-to-end run needs the dev dependencies (`npm install`) and a Chromium
(`npx playwright install chromium`, or point `CHROMIUM_PATH` at an existing one). It starts a
local static server and a local PeerJS broker, then drives two browser pages through hosting,
joining, a rally, a rematch, a turned-away third player and a disconnect — over a real WebRTC
data channel, with no internet access required.
