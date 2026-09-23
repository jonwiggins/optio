/**
 * Node preload (`node --import`) for the isolated test daemon, used by
 * apps/android/scripts/test-daemon.sh against an AUTH-ENABLED test API only.
 *
 * Works around an API race. The Optio WebSocket handlers attach their `message` listener only
 * after `await authenticateWs()`, which with auth enabled is a PAT lookup in Postgres, and
 * @fastify/websocket does not buffer frames that arrive before that. The CLI daemon sends its
 * `hello` the moment the socket opens, so on loopback about 19 in 20 hellos are dropped and the
 * server closes the socket with 4408 "Expected hello" after 10 s, over and over. (With auth
 * disabled the lookup is synchronous and nothing is lost.) Tracked for a server-side fix.
 *
 * This holds every frame a `ws` WebSocket sends during its first OPTIO_DEVLAB_WS_GRACE_MS
 * (default 300 ms) after `open`, then flushes them in order. It patches the `ws` module the CLI
 * itself loads (resolved from apps/cli), and nothing else.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "..", "..", "cli", "package.json"));
const WebSocket = require("ws");

const GRACE_MS = Number(process.env.OPTIO_DEVLAB_WS_GRACE_MS ?? 300);
const openedAt = new WeakMap();
const queues = new WeakMap();

const realEmit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function emit(event, ...args) {
  if (event === "open") openedAt.set(this, Date.now());
  return realEmit.call(this, event, ...args);
};

const realSend = WebSocket.prototype.send;
WebSocket.prototype.send = function send(data, options, cb) {
  const opened = openedAt.get(this);
  const wait = opened === undefined ? 0 : opened + GRACE_MS - Date.now();
  let queue = queues.get(this);
  if (wait <= 0 && !queue) return realSend.call(this, data, options, cb);
  if (!queue) {
    queue = [];
    queues.set(this, queue);
    setTimeout(
      () => {
        queues.delete(this);
        for (const [d, o, c] of queue) {
          if (this.readyState === WebSocket.OPEN) realSend.call(this, d, o, c);
        }
      },
      Math.max(wait, 0),
    );
  }
  queue.push([data, options, cb]);
};
