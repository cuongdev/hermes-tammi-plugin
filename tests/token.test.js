"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = { refreshCalls: 0, plan: [], gen: 0, valid: new Set() };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith("/api/v1/auth/refresh-webapp-token")) {
      state.refreshCalls++;
      const step = state.plan.shift() || "ok";
      if (step === "502") return reply(502, { message: "Bad Gateway" });
      if (step === "401") return reply(401, { success: false, message: "Refresh token invalid" });
      const { refresh_token } = JSON.parse(body || "{}");
      if (!state.valid.has(refresh_token)) return reply(400, { success: false, message: "Refresh token revoked" });
      state.valid.delete(refresh_token); // Tammi rotates: the old refresh token stops working
      const gen = ++state.gen;
      state.valid.add(`r${gen}`);
      return reply(200, { success: true, data: { access_token: `a${gen}`, refresh_token: `r${gen}`, expires_in: 15 * 86400, refresh_expires_in: 90 * 86400 } });
    }
    if (req.url.startsWith("/api/v1/user/user-info")) {
      const tok = (req.headers.authorization || "").replace("Bearer ", "");
      if (tok !== `a${state.gen}`) return reply(401, { success: false });
      return reply(200, { success: true, data: { zegoId: "z1", nickname: "Me" } });
    }
    reply(404, {});
  });
});

let api;
let tmp;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.TAMMI_API_BASE = `http://127.0.0.1:${server.address().port}/api/v1`;
  api = require("../bridge/tammiApi");
});
test.after(() => server.close());

function freshStore({ expired = true } = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tammi-tok-"));
  const file = path.join(tmp, "credentials.json");
  state.gen = 0; state.valid = new Set(["r0"]); state.refreshCalls = 0; state.plan = [];
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(file, JSON.stringify({ access_token: "a0", refresh_token: "r0", device_id: "d", ip: "1.1.1.1",
    expiry_time_seconds: expired ? now - 10 : now + 10 * 86400 }));
  return file;
}

test("expired access token is refreshed and the rotated refresh token is persisted", async () => {
  const file = freshStore();
  const a = new api.TammiApi(new api.CredentialStore(file));
  const u = await a.userInfo();
  assert.strictEqual(u.zegoId, "z1");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(saved.access_token, "a1");
  assert.strictEqual(saved.refresh_token, "r1");
  assert.ok(saved.refresh_expiry_time_seconds > Date.now() / 1000 + 89 * 86400);
  if (process.platform !== "win32") assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), "600");
});

test("a 5xx from the refresh endpoint is transient, not a dead session", async () => {
  const file = freshStore();
  const a = new api.TammiApi(new api.CredentialStore(file));
  state.plan = ["502"];
  await assert.rejects(() => a.ensureFreshToken(), (e) => e instanceof api.TransientError);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).refresh_token, "r0", "nothing burned");
  await a.ensureFreshToken(); // next attempt succeeds
  assert.strictEqual(a.store.data.access_token, "a1");
});

test("a rejected refresh token is an AuthError", async () => {
  const file = freshStore();
  const a = new api.TammiApi(new api.CredentialStore(file));
  state.plan = ["401"];
  await assert.rejects(() => a.ensureFreshToken(), (e) => e instanceof api.AuthError);
});

test("network failure is transient", async () => {
  const file = freshStore();
  const saved = process.env.TAMMI_API_BASE;
  const a = new api.TammiApi(new api.CredentialStore(file));
  a.raw = async () => { throw new api.TransientError("network error (ECONNREFUSED)"); };
  await assert.rejects(() => a.ensureFreshToken(), (e) => e instanceof api.TransientError);
  process.env.TAMMI_API_BASE = saved;
});

test("two processes sharing credentials.json never reuse a rotated refresh token", async () => {
  const file = freshStore();
  const bridge = new api.TammiApi(new api.CredentialStore(file)); // long-lived, loaded the old tokens
  const cli = new api.TammiApi(new api.CredentialStore(file));
  await cli.userInfo(); // CLI refreshes first: r0 -> r1 (r0 now revoked)
  assert.strictEqual(state.refreshCalls, 1);
  const u = await bridge.userInfo(); // bridge must pick up a1/r1 from disk, not refresh with r0
  assert.strictEqual(u.zegoId, "z1");
  assert.strictEqual(state.refreshCalls, 1);
  assert.strictEqual(bridge.store.data.refresh_token, "r1");
});

test("concurrent refreshes from two processes hit the endpoint once", async () => {
  const file = freshStore();
  const a = new api.TammiApi(new api.CredentialStore(file));
  const b = new api.TammiApi(new api.CredentialStore(file));
  await Promise.all([a.ensureFreshToken(), b.ensureFreshToken()]);
  assert.strictEqual(state.refreshCalls, 1);
  assert.strictEqual(a.store.sync().access_token, b.store.sync().access_token);
  assert.ok(!fs.existsSync(`${file}.lock`), "lock released");
});

test("a 401 after another process refreshed reuses its token instead of refreshing again", async () => {
  const file = freshStore({ expired: false });
  const a = new api.TammiApi(new api.CredentialStore(file));
  const b = new api.TammiApi(new api.CredentialStore(file));
  await b.refresh(true); // b rotates; a still holds a0 in memory
  assert.strictEqual(state.refreshCalls, 1);
  await a.userInfo(); // a syncs before sending, so it uses a1 directly
  assert.strictEqual(state.refreshCalls, 1);
});

test("a stale lock left by a crashed process is ignored", async () => {
  const file = freshStore();
  fs.writeFileSync(`${file}.lock`, "");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  const a = new api.TammiApi(new api.CredentialStore(file));
  await a.ensureFreshToken();
  assert.strictEqual(a.store.data.access_token, "a1");
});
