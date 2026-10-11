"use strict";
// api.tammi.vn client, sends the same headers as the web app
const fs = require("fs");
const crypto = require("crypto");
const paths = require("./paths");
const { ORIGIN, UA } = require("./ua");

const API = process.env.TAMMI_API_BASE || "https://api.tammi.vn/api/v1";
const REFRESH_MARGIN_SEC = 24 * 3600;

const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 15000;

// refresh token rejected, needs a new login
class AuthError extends Error {
  constructor(msg) { super(msg); this.name = "AuthError"; }
}

// network error, 5xx or 429: retry later
class TransientError extends Error {
  constructor(msg) { super(msg); this.name = "TransientError"; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizePhone(p) {
  let s = String(p || "").replace(/[^\d]/g, "");
  if (s.startsWith("84") && s.length >= 11) s = "0" + s.slice(2);
  return s;
}

function osVersion() {
  const m = UA.match(/Mac OS X ([0-9_]+)/);
  return m ? `macOS ${m[1].replace(/_/g, ".")}` : "Unknown OS";
}

// credentials.json is shared by the bridge and the CLI. Every refresh rotates the refresh token,
// so reload the file before using it and take a lock around refreshes.
class CredentialStore {
  constructor(file = paths.credentialsPath) { this.file = file; this._mtimeMs = 0; this.data = this.load(); }
  _stat() { try { return fs.statSync(this.file).mtimeMs; } catch { return 0; } }
  load() {
    this._mtimeMs = this._stat();
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return {}; }
  }
  sync() {
    if (this._stat() !== this._mtimeMs) this.data = this.load();
    return this.data;
  }
  save(patch) {
    this.data = { ...this.data, ...patch, updatedAt: new Date().toISOString() };
    paths.ensureDir(require("path").dirname(this.file));
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    this._mtimeMs = this._stat();
    return this.data;
  }
  clear() { try { fs.unlinkSync(this.file); } catch {} this.data = {}; this._mtimeMs = 0; }
  async withLock(fn) {
    const lock = `${this.file}.lock`;
    paths.ensureDir(require("path").dirname(this.file));
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lock, "wx"));
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let age = 0;
        try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (age > LOCK_STALE_MS) { try { fs.unlinkSync(lock); } catch {} continue; }
        if (Date.now() > deadline) throw new TransientError("credentials are locked by another hermes-tammi process");
        await sleep(150);
      }
    }
    try { return await fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
  }
  get deviceId() {
    if (!this.data.device_id) this.save({ device_id: crypto.randomUUID() });
    return this.data.device_id;
  }
  get loggedIn() { return Boolean(this.data.refresh_token); }
}

class TammiApi {
  constructor(store = new CredentialStore()) {
    this.store = store;
    this._refreshing = null;
  }

  headers(auth) {
    if (auth) this.store.sync();
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Origin: ORIGIN,
      Referer: ORIGIN + "/",
      "User-Agent": UA,
      "Accept-Language": "vi",
      "X-Device-Name": "Browser",
      "X-Device-ID": this.store.deviceId,
      "X-Os-Version": osVersion(),
      "X-IP-Address": this.store.data.ip || "0.0.0.0",
    };
    if (auth) h.Authorization = `Bearer ${this.store.data.access_token || ""}`;
    return h;
  }

  async raw(method, path, { body, auth = true, extraHeaders = {}, query } = {}) {
    let url = API + path;
    if (query) url += "?" + new URLSearchParams(query).toString();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { ...this.headers(auth), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new TransientError(`${method} ${path}: network error (${(e && e.cause && e.cause.code) || e.message || e})`);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  }

  async call(method, path, opts = {}) {
    await this.ensureFreshToken();
    const used = this.store.data.access_token;
    let r = await this.raw(method, path, opts);
    if (r.status === 401) {
      await this.refresh(true, used);
      r = await this.raw(method, path, opts);
    }
    if (r.status === 401) throw new AuthError("Tammi session expired — run `hermes-tammi-plugin login` again");
    if (r.status >= 500 || r.status === 429) throw new TransientError(`${method} ${path}: HTTP ${r.status}`);
    if (r.status >= 400 || (r.json && r.json.success === false)) {
      const msg = (r.json && (r.json.message || r.json.error_description || r.json.error)) || `HTTP ${r.status}`;
      const err = new Error(`${method} ${path}: ${msg}`);
      err.status = r.status;
      err.body = r.json;
      throw err;
    }
    return r.json;
  }

  async ensureIp() {
    if (this.store.data.ip) return;
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      const j = await r.json();
      if (j && j.ip) this.store.save({ ip: j.ip });
    } catch {}
  }

  _saveTokens(d) {
    if (!d || !d.access_token) throw new AuthError("Tammi did not return an access token");
    const now = Math.floor(Date.now() / 1000);
    return this.store.save({
      access_token: d.access_token,
      refresh_token: d.refresh_token || this.store.data.refresh_token,
      expiry_time_seconds: d.expires_in ? now + Number(d.expires_in) : now + 3600,
      refresh_expiry_time_seconds: d.refresh_expires_in ? now + Number(d.refresh_expires_in) : this.store.data.refresh_expiry_time_seconds,
    });
  }

  _needsRefresh(d = this.store.data) {
    const now = Math.floor(Date.now() / 1000);
    return !d.access_token || !d.expiry_time_seconds || now >= Number(d.expiry_time_seconds) - REFRESH_MARGIN_SEC;
  }

  async ensureFreshToken() {
    const d = this.store.sync();
    if (!d.refresh_token) throw new AuthError("Not logged in — run `hermes-tammi-plugin login`");
    if (this._needsRefresh(d)) await this.refresh();
  }

  tokenExpiry() {
    const d = this.store.sync();
    return { accessExpiresAt: Number(d.expiry_time_seconds || 0) || null, refreshExpiresAt: Number(d.refresh_expiry_time_seconds || 0) || null };
  }

  // staleToken: the access token that just got a 401. If the file already has a different one,
  // another process refreshed in the meantime and we reuse it.
  async refresh(force = false, staleToken = undefined) {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this.store.withLock(async () => {
      const d = this.store.sync();
      if (!d.refresh_token) throw new AuthError("Not logged in — run `hermes-tammi-plugin login`");
      if (!force && !this._needsRefresh(d)) return d;
      if (force && staleToken !== undefined && d.access_token && d.access_token !== staleToken) return d;
      const r = await this.raw("POST", "/auth/refresh-webapp-token", { body: { refresh_token: d.refresh_token } });
      const data = r.json && r.json.data;
      if (r.status === 200 && r.json && r.json.success && data && data.access_token) return this._saveTokens(data);
      const why = `HTTP ${r.status}: ${(r.json && r.json.message) || "no message"}`;
      if (r.status >= 500 || r.status === 429 || r.status === 408) throw new TransientError(`Token refresh failed (${why}), will retry`);
      throw new AuthError(`Tammi session expired (${why}) — run \`hermes-tammi-plugin login\``);
    });
    try { return await this._refreshing; } finally { this._refreshing = null; }
  }

  async checkUserExists(phone) {
    const r = await this.raw("GET", "/user/check-user-exist", { auth: false, query: { username: normalizePhone(phone) } });
    return Boolean(r.json && r.json.data);
  }

  async loginPassword(phone, password) {
    await this.ensureIp();
    const r = await this.raw("POST", "/auth/login-password", { auth: false, body: { username: normalizePhone(phone), password } });
    if (!r.json || !r.json.success) throw new AuthError((r.json && r.json.message) || `HTTP ${r.status}`);
    this.store.save({ phone: normalizePhone(phone) });
    return this._saveTokens(r.json.data);
  }

  // prod requires a Cloudflare Turnstile token here
  async requestOtp(phone, cfToken = "") {
    await this.ensureIp();
    const r = await this.raw("POST", "/auth/request-otp", {
      auth: false,
      body: { username: normalizePhone(phone), scope: "login" },
      extraHeaders: { "cf-token": cfToken || "" },
    });
    if (!r.json || !r.json.success) throw new AuthError((r.json && r.json.message) || `HTTP ${r.status}`);
    return r.json.data;
  }

  async loginOtp(phone, otp) {
    const r = await this.raw("POST", "/auth/login-webapp-otp", {
      auth: false,
      body: { username: normalizePhone(phone), otpCode: String(otp).trim() },
      extraHeaders: { "Os-Type": "web" },
    });
    if (!r.json || !r.json.success) throw new AuthError((r.json && r.json.message) || `HTTP ${r.status}`);
    this.store.save({ phone: normalizePhone(phone) });
    return this._saveTokens(r.json.data);
  }

  // tokens copied from localStorage of a logged-in tammi.vn tab
  async importSession({ token, refresh_token, device_id }) {
    if (!refresh_token) throw new AuthError("refresh_token is required");
    if (device_id) this.store.save({ device_id });
    this.store.save({ access_token: token || "", refresh_token, expiry_time_seconds: 0 });
    await this.refresh(true);
    return this.userInfo();
  }

  async logout() {
    const d = this.store.data;
    if (d.refresh_token) {
      try { await this.raw("POST", "/auth/logout-webapp", { body: { refreshToken: d.refresh_token } }); } catch {}
    }
    this.store.clear();
  }

  async userInfo() {
    const j = await this.call("GET", "/user/user-info");
    const u = j.data || {};
    this.store.save({ user: { zegoId: u.zegoId, nickname: u.nickname || u.username, phoneNumber: u.phoneNumber, imageUrl: u.imageUrl || "" } });
    return u;
  }

  async zegoToken(zegoId) {
    const j = await this.call("POST", "/meeting/zego/token", { body: { userId: zegoId } });
    const d = j.data || {};
    if (!d.data) throw new Error("Tammi returned no ZEGO token");
    return { token: d.data, expireTime: Number(d.expireTime || 0) };
  }

  async contacts() {
    const j = await this.call("GET", "/user/contacts");
    return (j.data || []).filter((c) => c.zegoId).map((c) => ({ id: c.zegoId, name: c.contactName || c.contactPhoneNumber, phone: c.contactPhoneNumber }));
  }
}

module.exports = { TammiApi, CredentialStore, AuthError, TransientError, normalizePhone, REFRESH_MARGIN_SEC };
