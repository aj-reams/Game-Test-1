// Peer-to-peer transport. The two browsers talk directly over a WebRTC data
// channel; the PeerJS broker is used only to introduce them and is out of the
// loop once the match starts. Nothing here knows any Pong rules.

/**
 * Signaling + ICE configuration. The defaults use PeerJS's free public broker
 * and Google's public STUN, which is enough for most home connections. To use
 * your own broker set `host`/`port`/`path`; to make strict/corporate networks
 * work, add a TURN server to `iceServers`.
 */
const DEFAULT_PEER_CONFIG = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      // { urls: 'turn:your.turn.server:3478', username: '...', credential: '...' },
    ],
  },
};

// Setting `window.PONG_PEER_CONFIG` before this module loads replaces any of the
// above — that is how you point the game at a broker you run yourself, and how
// the end-to-end tests run against a local one with no internet at all.
export const PEER_CONFIG = { ...DEFAULT_PEER_CONFIG, ...(globalThis.PONG_PEER_CONFIG || {}) };

export const MSG = {
  INPUT: 'i',
  SNAPSHOT: 's',
  EVENT: 'e',
  PING: 'p',
  PONG: 'q',
};

const ID_PREFIX = 'pong-';
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // no look-alike characters
const ID_LENGTH = 6;
const CONNECT_TIMEOUT_MS = 20000;
const HEARTBEAT_MS = 1000;
const SILENCE_TIMEOUT_MS = 8000;

export function makeRoomId() {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

/** Human-readable reasons for the failure screen. */
const ERROR_TEXT = {
  'peer-unavailable': "That game isn't open any more. The host may have closed their tab.",
  'browser-incompatible': 'This browser does not support WebRTC, which the game needs to connect.',
  network: 'Lost contact with the matchmaking server. Check your connection and try again.',
  'server-error': 'The matchmaking server is unreachable right now. Try again in a moment.',
  'socket-error': 'The matchmaking server is unreachable right now. Try again in a moment.',
  'socket-closed': 'The matchmaking server closed the connection. Try again.',
  webrtc: 'Could not open a direct connection between the two browsers.',
  timeout:
    'Could not open a direct connection. Some strict networks (offices, a few mobile carriers) block ' +
    'peer-to-peer traffic — trying from another network usually fixes it.',
  'connection-lost': 'The connection to the other player dropped.',
  full: 'That game already has two players.',
};

export function describeError(code) {
  return ERROR_TEXT[code] || 'Something went wrong with the connection.';
}

/**
 * @param {object} handlers
 *   onReady(roomId)    signaling is up; for a host, the room is joinable
 *   onConnected()      the data channel to the other player is open
 *   onMessage(msg)     a decoded message from the other player
 *   onDisconnected(code) the other player went away
 *   onError(code)      fatal: could not host or join
 *   onRtt(ms)          round-trip time sample
 */
export function createNet(handlers) {
  let peer = null;
  let conn = null;
  let role = null; // 'host' | 'guest'
  let roomId = null;
  let connectTimer = null;
  let heartbeatTimer = null;
  let lastHeard = 0;
  let closed = false;

  const emit = (name, ...args) => {
    if (!closed && typeof handlers[name] === 'function') handlers[name](...args);
  };

  function fail(code) {
    if (closed) return;
    stopTimers();
    emit('onError', code);
    closed = true;
    try {
      peer?.destroy();
    } catch {}
  }

  function stopTimers() {
    clearTimeout(connectTimer);
    clearInterval(heartbeatTimer);
    connectTimer = null;
    heartbeatTimer = null;
  }

  function startHeartbeat() {
    lastHeard = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!conn || !conn.open) return;
      if (Date.now() - lastHeard > SILENCE_TIMEOUT_MS) {
        handleDisconnect('connection-lost');
        return;
      }
      send({ t: MSG.PING, at: Date.now() });
    }, HEARTBEAT_MS);
  }

  function handleDisconnect(code) {
    if (closed || !conn) return;
    const gone = conn;
    conn = null;
    stopTimers();
    try {
      gone.close();
    } catch {}
    emit('onDisconnected', code);
  }

  function attach(connection) {
    conn = connection;
    connection.on('data', (msg) => {
      lastHeard = Date.now();
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === MSG.PING) {
        send({ t: MSG.PONG, at: msg.at });
        return;
      }
      if (msg.t === MSG.PONG) {
        emit('onRtt', Date.now() - msg.at);
        return;
      }
      emit('onMessage', msg);
    });
    connection.on('close', () => handleDisconnect('connection-lost'));
    connection.on('error', () => handleDisconnect('connection-lost'));

    const onOpen = () => {
      clearTimeout(connectTimer);
      connectTimer = null;
      startHeartbeat();
      emit('onConnected');
    };
    if (connection.open) onOpen();
    else connection.on('open', onOpen);
  }

  function createPeer(id) {
    const p = new window.Peer(id, PEER_CONFIG);
    p.on('error', (err) => {
      const code = err?.type || 'server-error';
      // A dropped data channel surfaces as a peer error too; don't turn a
      // mid-match hiccup into a fatal "couldn't host" screen.
      if (conn && (code === 'network' || code === 'webrtc' || code === 'peer-unavailable')) {
        handleDisconnect('connection-lost');
        return;
      }
      fail(code);
    });
    return p;
  }

  function send(msg) {
    if (conn && conn.open) {
      try {
        conn.send(msg);
      } catch {
        handleDisconnect('connection-lost');
      }
    }
  }

  return {
    get role() {
      return role;
    },
    get roomId() {
      return roomId;
    },
    get connected() {
      return !!(conn && conn.open);
    },

    host() {
      role = 'host';
      roomId = makeRoomId();
      peer = createPeer(ID_PREFIX + roomId);
      peer.on('open', () => emit('onReady', roomId));
      peer.on('connection', (incoming) => {
        if (conn) {
          // Someone else opened the link while a match is in progress.
          incoming.on('open', () => {
            incoming.send({ t: MSG.EVENT, kind: 'full' });
            setTimeout(() => incoming.close(), 250);
          });
          return;
        }
        attach(incoming);
      });
    },

    join(id) {
      role = 'guest';
      roomId = id;
      peer = createPeer(undefined);
      peer.on('open', () => {
        emit('onReady', id);
        attach(peer.connect(ID_PREFIX + id, { reliable: true, serialization: 'json' }));
        connectTimer = setTimeout(() => {
          if (!conn || !conn.open) fail('timeout');
        }, CONNECT_TIMEOUT_MS);
      });
    },

    send,

    close() {
      closed = true;
      stopTimers();
      try {
        conn?.close();
      } catch {}
      try {
        peer?.destroy();
      } catch {}
      conn = null;
      peer = null;
    },
  };
}
