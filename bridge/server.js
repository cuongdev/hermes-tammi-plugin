#!/usr/bin/env node
"use strict";
const http = require("http");
const { TammiApi, AuthError } = require("./tammiApi");
const { ZimClient } = require("./zimClient");

const HOST = process.env.TAMMI_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.TAMMI_BRIDGE_PORT || 8788);
const TOKEN = process.env.TAMMI_BRIDGE_TOKEN || "";
const RING_SIZE = 500;

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 5e6) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function errMessage(e) {
  if (!e) return "unknown error";
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function createBridge({ api = new TammiApi(), client = null } = {}) {
  client = client || new ZimClient({ api, log });

  let seq = 0;
  const ring = [];
  const sseClients = new Set();

  function writeEvent(res, { id, event, data }) {
    res.write(`id: ${id}\nevent: ${event}\ndata: ${data}\n\n`);
  }

  function publish(event, data) {
    const item = { id: ++seq, event, data: JSON.stringify(data) };
    ring.push(item);
    if (ring.length > RING_SIZE) ring.shift();
    for (const res of sseClients) writeEvent(res, item);
  }

  client.on("message", (m) => publish("message", m));
  client.on("status", (s) => publish("status", s));
  client.on("session_dead", (d) => publish("session_dead", d));

  const routes = {
    "GET /health": async () => ({ ...client.health(), bridge: "hermes-tammi", hasCredentials: api.store.loggedIn }),
    "GET /conversations": async (_b, q) => ({ success: true, conversations: await client.conversations(Number(q.get("count") || 100)) }),
    "GET /contacts": async () => ({ success: true, ...(await client.contacts()) }),
    "POST /send": async (b) => {
      if (!b.conversationId || !b.text) throw Object.assign(new Error("conversationId and text are required"), { status: 400 });
      return { success: true, ...(await client.sendText(b.conversationId, b.conversationType, b.text, { replyTo: b.replyTo })) };
    },
    "POST /send-file": async (b) => {
      if (!b.conversationId || !b.path) throw Object.assign(new Error("conversationId and path are required"), { status: 400 });
      return { success: true, ...(await client.sendFile(b.conversationId, b.conversationType, b.path, b)) };
    },
    "POST /typing": async (b) => ({ success: true, ...(await client.typing(b.conversationId, b.conversationType, Boolean(b.stop))) }),
    "POST /read": async (b) => ({ success: true, ...(await client.markRead(b.conversationId, b.conversationType)) }),
    "POST /relogin": async () => ({ success: true, ...(await client.relogin()) }),
    "POST /shutdown": async () => { setTimeout(() => shutdown("POST /shutdown"), 50); return { success: true }; },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (TOKEN && req.headers["x-bridge-token"] !== TOKEN) return send(res, 401, { success: false, error: "bad bridge token" });

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      const last = Number(req.headers["last-event-id"] || 0);
      if (last) for (const item of ring) if (item.id > last) writeEvent(res, item);
      writeEvent(res, { id: seq, event: "status", data: JSON.stringify(client.health()) });
      sseClients.add(res);
      const hb = setInterval(() => res.write(": hb\n\n"), 15000);
      req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { success: false, error: "not found" });
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      send(res, 200, await handler(body, url.searchParams));
    } catch (e) {
      const status = e.status || (e instanceof AuthError ? 401 : 500);
      log.warn(`[http] ${req.method} ${url.pathname} failed:`, errMessage(e));
      send(res, status, { success: false, error: errMessage(e), code: e.code });
    }
  });

  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[bridge] shutting down (${reason})`);
    for (const res of sseClients) { try { res.end(); } catch {} }
    server.close();
    await Promise.race([client.stop(), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(0);
  }

  async function boot(attempt = 0) {
    try {
      await client.start();
    } catch (e) {
      const msg = errMessage(e);
      log.error("[bridge] Tammi login failed:", msg);
      client.state.lastError = msg;
      if (e instanceof AuthError) {
        client.state.sessionDead = true;
        publish("session_dead", { code: "auth_expired", message: msg });
        return;
      }
      if (client.zim) client._scheduleRelogin(`login failed: ${msg}`, attempt);
      else setTimeout(() => boot(attempt + 1), Math.min(60000, 2000 * 2 ** attempt));
    }
  }

  return { server, client, api, publish, shutdown, boot };
}

function main() {
  const bridge = createBridge();
  process.on("SIGINT", () => bridge.shutdown("SIGINT"));
  process.on("SIGTERM", () => bridge.shutdown("SIGTERM"));
  process.on("unhandledRejection", (e) => log.warn("[bridge] unhandled rejection:", errMessage(e)));
  bridge.server.on("error", (e) => {
    log.error(`[bridge] cannot listen on ${HOST}:${PORT}: ${errMessage(e)}`);
    process.exit(1);
  });
  bridge.server.listen(PORT, HOST, () => {
    log.info(`[bridge] listening on http://${HOST}:${PORT}`);
    if (!bridge.api.store.loggedIn) {
      log.error("[bridge] not logged in — run `hermes-tammi-plugin login` (bridge stays up and reports loggedIn:false)");
      return;
    }
    bridge.boot(0);
  });
  return bridge;
}

module.exports = { createBridge, main };

if (require.main === module) main();
