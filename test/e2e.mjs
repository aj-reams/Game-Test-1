// End-to-end test: drives two real Chromium pages that connect to each other
// over a genuine WebRTC data channel, so the netcode is actually exercised.
//
//   npm run test:e2e
//
// Everything runs locally: a static file server for the site and a PeerJS
// broker for signalling, so no internet access is required.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PeerServer } from 'peer';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const SITE_PORT = 8123;
const BROKER_PORT = 9123;
const SHOTS = path.join(ROOT, 'e2e-artifacts');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function serveSite() {
  const server = http.createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', () => resolve(server)));
}

/**
 * The browser always talks to a proxy on one fixed port; the real broker sits
 * behind it on a port that is never reused. That makes "the broker went away
 * and a fresh one came back" reproducible, with no waiting for a port to be
 * released and no chance of binding a port that is still shutting down.
 */
function startProxy(port) {
  let target = null; // null means "refuse everything", i.e. the outage
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };

  const server = net.createServer((client) => {
    if (!target) {
      client.destroy();
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: target });
    track(client);
    track(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    upstream.on('close', () => client.destroy());
  });

  const dropAll = () => {
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {}
    }
    sockets.clear();
  };

  return {
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    pointAt: (upstreamPort) => {
      target = upstreamPort;
    },
    cutOff: () => {
      target = null;
      dropAll();
    },
    close: () =>
      new Promise((resolve) => {
        dropAll();
        server.close(() => resolve());
      }),
  };
}

const startBroker = (port) => PeerServer({ host: '127.0.0.1', port, path: '/' });

/** Poll until `fn` returns truthy, or throw after `timeout` ms. */
async function until(label, fn, timeout = 15000, interval = 100) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

const pongState = (page) => page.evaluate(() => window.__pong.state);
const visible = (page, id) => page.evaluate((i) => !document.getElementById(i).hidden, id);

async function newPage(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  // Point the game at the local broker and keep ICE to host candidates only.
  await page.addInitScript(
    ({ port }) => {
      window.PONG_PEER_CONFIG = {
        host: '127.0.0.1',
        port,
        path: '/',
        secure: false,
        key: 'peerjs',
        debug: 0,
        config: { iceServers: [] },
      };
    },
    { port: BROKER_PORT },
  );
  page.on('pageerror', (err) => {
    failures++;
    console.log(`  FAIL page error — ${err.message}`);
  });
  await page.goto(url);
  return page;
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const site = await serveSite();
  const proxy = startProxy(BROKER_PORT);
  await proxy.listen();
  const brokers = [startBroker(BROKER_PORT + 1)];
  proxy.pointAt(BROKER_PORT + 1);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const base = `http://127.0.0.1:${SITE_PORT}/`;

  try {
    console.log('\nhosting and joining');
    const host = await newPage(browser, base);
    await host.click('#btn-host');
    const link = await until('the share link', async () => {
      const value = await host.inputValue('#share-link');
      return value || null;
    });
    check('host gets a shareable link', /#[a-z2-9]{6}$/.test(link), link);

    const guest = await newPage(browser, link);
    await until('both players in the game', async () =>
      (await visible(host, 'screen-game')) && (await visible(guest, 'screen-game')),
    );
    check('host reaches the game screen', await visible(host, 'screen-game'));
    check('guest reaches the game screen', await visible(guest, 'screen-game'));
    check('data channel is open on the host', await host.evaluate(() => window.__pong.connected));
    check('data channel is open on the guest', await guest.evaluate(() => window.__pong.connected));

    console.log('\nmessages flow both ways');
    await until('a round-trip time reading', async () =>
      (await host.textContent('#hud-rtt')) && (await guest.textContent('#hud-rtt')),
    );
    check('host shows a ping time', /\d+ ms/.test(await host.textContent('#hud-rtt')));
    check('guest shows a ping time', /\d+ ms/.test(await guest.textContent('#hud-rtt')));

    console.log('\nguest input reaches the host');
    const before = (await pongState(host)).p2.y;
    await guest.keyboard.down('ArrowDown');
    await until('the guest paddle to move on the host', async () => (await pongState(host)).p2.y > before + 20);
    await guest.keyboard.up('ArrowDown');
    const afterHost = (await pongState(host)).p2.y;
    const afterGuest = (await pongState(guest)).p2.y;
    check('host sees the guest paddle move down', afterHost > before + 20, `${before} -> ${afterHost}`);
    check(
      'guest predicts its own paddle in the same place',
      Math.abs(afterGuest - afterHost) < 40,
      `guest ${afterGuest.toFixed(1)} vs host ${afterHost.toFixed(1)}`,
    );

    console.log('\na rally is played and scores agree');
    await until('a few points to be scored', async () => {
      const s = await pongState(host);
      return s.score[0] + s.score[1] >= 2;
    }, 30000);
    const hostScore = (await pongState(host)).score;
    const guestScore = (await until('the guest score to catch up', async () => {
      const s = await pongState(guest);
      return s && s.score[0] + s.score[1] >= hostScore[0] + hostScore[1] ? s.score : null;
    }));
    check('both sides show the same score', JSON.stringify(hostScore) === JSON.stringify(guestScore),
      `host ${hostScore} vs guest ${guestScore}`);

    console.log('\nthe field fits on screen');
    const fit = await host.evaluate(() => ({
      canvasBottom: Math.round(document.getElementById('field').getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    check('the playing field fits in the viewport', fit.canvasBottom <= fit.viewport,
      `field ends at ${fit.canvasBottom}px, viewport is ${fit.viewport}px`);
    check('the page does not scroll', fit.scrollHeight <= fit.viewport,
      `page is ${fit.scrollHeight}px tall`);

    await host.screenshot({ path: path.join(SHOTS, 'host.png') });
    await guest.screenshot({ path: path.join(SHOTS, 'guest.png') });
    console.log(`  ..   screenshots written to ${path.relative(ROOT, SHOTS)}/`);

    console.log('\nmatch point, win screen and rematch');
    await host.evaluate(() => {
      window.__pong.state.score = [10, 10];
    });
    await until('a winner', async () => (await visible(host, 'overlay')) && (await visible(guest, 'overlay')));
    const hostTitle = await host.textContent('#overlay-title');
    const guestTitle = await guest.textContent('#overlay-title');
    check('host sees a result', /You (win|lose)/.test(hostTitle), hostTitle);
    check('guest sees the opposite result', hostTitle !== guestTitle, `${hostTitle} / ${guestTitle}`);
    await host.screenshot({ path: path.join(SHOTS, 'host-result.png') });

    await host.click('#btn-rematch');
    await until('the rematch to start', async () => !(await visible(host, 'overlay')) && !(await visible(guest, 'overlay')));
    check('rematch clears the host score', (await pongState(host)).score.join() === '0,0');
    const guestReset = await until('the guest score to reset', async () => {
      const s = await pongState(guest);
      return s && s.score.join() === '0,0' ? s : null;
    });
    check('rematch clears the guest score', guestReset.score.join() === '0,0');

    console.log('\na third player is turned away');
    const third = await newPage(browser, link);
    await until('the room-full screen', async () => visible(third, 'screen-error'));
    check('third player is told the game is full', /two players/.test(await third.textContent('#error-text')));
    await third.close();

    console.log('\nthe guest drops and dials back into the same room');
    // Score a couple of points so we can tell a resumed match from a fresh one.
    await host.evaluate(() => {
      window.__pong.state.score = [3, 2];
    });
    await guest.close();
    await until('the disconnect overlay', async () => visible(host, 'overlay'), 20000);
    check('host is told the opponent left', /disconnected/i.test(await host.textContent('#overlay-title')));
    check('host says the link still works', /link still works/i.test(await host.textContent('#overlay-sub')));
    await host.screenshot({ path: path.join(SHOTS, 'host-disconnected.png') });

    const rejoined = await newPage(browser, link);
    await until('the rejoined guest to be in the game', async () => visible(rejoined, 'screen-game'));
    check('the original link still works after a drop', await rejoined.evaluate(() => window.__pong.connected));
    const resumed = (await pongState(host)).score;
    check(
      'the match resumes instead of restarting',
      resumed[0] >= 3 && resumed[1] >= 2,
      `score is ${resumed}, expected to still be at or past 3,2`,
    );
    await rejoined.close();
    await host.close();

    console.log('\nthe lobby survives losing the broker (the backgrounded-phone case)');
    const solo = await newPage(browser, base);
    await solo.click('#btn-host');
    const soloLink = await until('the share link', async () => (await solo.inputValue('#share-link')) || null);
    const lobbyState = (page) => page.evaluate(() => document.getElementById('lobby-status').className);
    await until('the room to go live', async () => (await lobbyState(solo)).includes('is-waiting'));
    // The QR generator is imported lazily, so give it a moment to land.
    await until('the QR code', async () => solo.evaluate(() => !!document.querySelector('#qr-image svg')));
    check('the lobby shows a QR code', true);

    // Killing and restarting the broker wipes its registry, so the room only
    // becomes joinable again if the page actively re-registers itself. A page
    // may or may not notice the socket dying — a suspended tab often comes back
    // holding one that looks fine — so the recovery deliberately does not wait
    // to be told, and neither does this test.
    proxy.cutOff();
    const noticed = await Promise.race([
      until('the lobby to notice', async () => {
        const state = await lobbyState(solo);
        return state.includes('is-reconnecting') || state.includes('is-lost');
      }, 8000).then(() => true),
      new Promise((r) => setTimeout(() => r(false), 8500)),
    ]).catch(() => false);
    console.log(`  ..   the page ${noticed ? 'noticed' : 'did not notice'} the broker dying on its own`);

    // A brand-new broker: its registry is empty, so the room is only joinable
    // again if the page re-registers itself under the same ID.
    brokers.push(startBroker(BROKER_PORT + 2));
    proxy.pointAt(BROKER_PORT + 2);
    // Exactly what iOS fires when you come back to Safari.
    await solo.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await until('the lobby to come back', async () => (await lobbyState(solo)).includes('is-waiting'), 30000);
    check('the lobby re-registers itself on return', true);
    check('the shared link is unchanged', (await solo.inputValue('#share-link')) === soloLink, soloLink);

    const late = await newPage(browser, soloLink);
    await until('the late guest to join', async () => visible(late, 'screen-game'), 25000);
    check('the link shared before the drop still joins the game', await late.evaluate(() => window.__pong.connected));
    await solo.screenshot({ path: path.join(SHOTS, 'lobby-recovered.png') });
    await late.close();
    await solo.close();

    console.log('\nthe share sheet is offered when the browser has one');
    const sharer = await browser.newPage({ viewport: { width: 420, height: 860 } });
    await sharer.addInitScript(({ port }) => {
      window.PONG_PEER_CONFIG = {
        host: '127.0.0.1',
        port,
        path: '/',
        secure: false,
        key: 'peerjs',
        debug: 0,
        config: { iceServers: [] },
      };
      window.__shared = [];
      navigator.share = (data) => {
        window.__shared.push(data);
        return Promise.resolve();
      };
    }, { port: BROKER_PORT });
    await sharer.goto(base);
    await sharer.click('#btn-host');
    await until('the share button', async () => visible(sharer, 'btn-share'));
    check('a Share button appears when navigator.share exists', await visible(sharer, 'btn-share'));
    await sharer.click('#btn-share');
    const shared = await until('the share payload', async () =>
      (await sharer.evaluate(() => window.__shared[0])) || null);
    check('sharing hands over the join link', shared.url === (await sharer.inputValue('#share-link')), shared.url);
    check('the page is still hosting after sharing', await sharer.evaluate(() => window.__pong.role === 'host'));
    await sharer.screenshot({ path: path.join(SHOTS, 'lobby-phone.png') });
    await sharer.close();
  } finally {
    await browser.close();
    await proxy.close();
    for (const b of brokers) {
      try {
        b.close?.();
      } catch {}
    }
    site.closeAllConnections?.();
    site.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
}

main()
  .catch((err) => {
    failures++;
    console.error('\ne2e run failed:', err.message);
  })
  // The broker holds its sockets open past close(), so exit rather than hang.
  .finally(() => process.exit(failures ? 1 : 0));
