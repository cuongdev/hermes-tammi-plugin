"use strict";
// Browser globals the ZIM web SDK expects. Require before loading the SDK.
require("fake-indexeddb/auto");
const WS = require("ws");

const { ORIGIN, UA } = require("./ua");

class MemStorage {
  constructor() { this._m = new Map(); }
  get length() { return this._m.size; }
  key(i) { return Array.from(this._m.keys())[i] ?? null; }
  getItem(k) { return this._m.has(String(k)) ? this._m.get(String(k)) : null; }
  setItem(k, v) { this._m.set(String(k), String(v)); }
  removeItem(k) { this._m.delete(String(k)); }
  clear() { this._m.clear(); }
}

// accesshub rejects connections without a browser Origin
class BrowserWebSocket extends WS {
  constructor(url, protocols) {
    super(url, protocols, { headers: { Origin: ORIGIN, "User-Agent": UA } });
  }
}

const g = globalThis;
g.window = g;
g.self = g;
g.location = new URL(ORIGIN + "/");
g.location.reload = () => {};
g.localStorage = new MemStorage();
g.sessionStorage = new MemStorage();
g.WebSocket = BrowserWebSocket;
Object.defineProperty(g, "navigator", {
  value: {
    userAgent: UA,
    language: "vi-VN",
    languages: ["vi-VN", "vi"],
    onLine: true,
    platform: "MacIntel",
    hardwareConcurrency: 8,
    storage: undefined,
    connection: { effectiveType: "4g", type: "wifi", addEventListener() {}, removeEventListener() {} },
  },
  configurable: true,
  writable: true,
});
const winListeners = {};
g.addEventListener = (t, f) => { (winListeners[t] ||= []).push(f); };
g.removeEventListener = (t, f) => { winListeners[t] = (winListeners[t] || []).filter((x) => x !== f); };
g.document = {
  hidden: false,
  visibilityState: "visible",
  cookie: "",
  referrer: "",
  readyState: "complete",
  addEventListener() {},
  removeEventListener() {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => null }),
  getElementsByTagName: () => [],
  getElementById: () => null,
  querySelector: () => null,
  head: { appendChild() {} },
  body: { appendChild() {} },
};
g.screen = { width: 1440, height: 900 };
g.devicePixelRatio = 2;

// minimal XHR on top of fetch, the SDK uses it for uploads
class XHR {
  constructor() {
    this.readyState = 0; this.status = 0; this.statusText = ""; this.responseType = "";
    this.response = null; this.responseText = ""; this.timeout = 0; this.withCredentials = false;
    this._headers = {}; this._resHeaders = null; this._ls = {}; this._ac = null;
    this.upload = { onprogress: null, addEventListener: (t, f) => { if (t === "progress") this.upload.onprogress = f; } };
  }
  addEventListener(t, f) { (this._ls[t] ||= []).push(f); }
  removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
  _emit(t, ev = {}) {
    const e = { type: t, target: this, currentTarget: this, ...ev };
    if (typeof this["on" + t] === "function") this["on" + t](e);
    for (const f of this._ls[t] || []) f.call(this, e);
  }
  open(method, url) { this._method = method; this._url = String(url); this.readyState = 1; this._emit("readystatechange"); }
  setRequestHeader(k, v) { this._headers[k] = v; }
  getResponseHeader(k) { return this._resHeaders ? this._resHeaders.get(k) : null; }
  getAllResponseHeaders() {
    if (!this._resHeaders) return "";
    let s = "";
    this._resHeaders.forEach((v, k) => { s += `${k}: ${v}\r\n`; });
    return s;
  }
  abort() { if (this._ac) this._ac.abort(); this._emit("abort"); }
  overrideMimeType() {}
  send(body) {
    this._ac = new AbortController();
    let timer = null;
    if (this.timeout > 0) {
      timer = setTimeout(() => { this._ac.abort(); this._emit("timeout"); this._emit("loadend"); }, this.timeout);
    }
    const headers = { Origin: ORIGIN, "User-Agent": UA, ...this._headers };
    const size = body ? (body.byteLength ?? body.size ?? (typeof body === "string" ? body.length : 0)) : 0;
    fetch(this._url, { method: this._method, headers, body: body ?? undefined, signal: this._ac.signal, duplex: "half" })
      .then(async (res) => {
        this.status = res.status; this.statusText = res.statusText; this._resHeaders = res.headers;
        this.readyState = 2; this._emit("readystatechange");
        if (size && this.upload.onprogress) this.upload.onprogress({ loaded: size, total: size, lengthComputable: true });
        const buf = Buffer.from(await res.arrayBuffer());
        this.responseText = this.responseType === "" || this.responseType === "text" ? buf.toString("utf8") : "";
        if (this.responseType === "arraybuffer") this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        else if (this.responseType === "blob") this.response = new Blob([buf]);
        else if (this.responseType === "json") { try { this.response = JSON.parse(buf.toString("utf8")); } catch { this.response = null; } }
        else this.response = this.responseText;
        this.readyState = 4;
        if (timer) clearTimeout(timer);
        this._emit("progress", { loaded: buf.length, total: buf.length, lengthComputable: true });
        this._emit("readystatechange"); this._emit("load"); this._emit("loadend");
      })
      .catch((err) => {
        if (timer) clearTimeout(timer);
        if (err && err.name === "AbortError") return;
        this.readyState = 4; this.status = 0;
        this._emit("readystatechange"); this._emit("error", { error: err }); this._emit("loadend");
      });
  }
}
XHR.UNSENT = 0; XHR.OPENED = 1; XHR.HEADERS_RECEIVED = 2; XHR.LOADING = 3; XHR.DONE = 4;
g.XMLHttpRequest = XHR;

class FileReaderShim {
  constructor() { this.readyState = 0; this.result = null; this.error = null; this._ls = {}; }
  addEventListener(t, f) { (this._ls[t] ||= []).push(f); }
  removeEventListener(t, f) { this._ls[t] = (this._ls[t] || []).filter((x) => x !== f); }
  _emit(t) {
    const e = { type: t, target: this, currentTarget: this };
    if (typeof this["on" + t] === "function") this["on" + t](e);
    for (const f of this._ls[t] || []) f.call(this, e);
  }
  _read(blob, conv) {
    this.readyState = 1;
    this._emit("loadstart");
    Promise.resolve(blob.arrayBuffer())
      .then((ab) => { this.result = conv(ab, blob); this.readyState = 2; this._emit("load"); this._emit("loadend"); })
      .catch((err) => { this.error = err; this.readyState = 2; this._emit("error"); this._emit("loadend"); });
  }
  readAsArrayBuffer(b) { this._read(b, (ab) => ab); }
  readAsText(b) { this._read(b, (ab) => Buffer.from(ab).toString("utf8")); }
  readAsBinaryString(b) { this._read(b, (ab) => Buffer.from(ab).toString("binary")); }
  readAsDataURL(b) {
    this._read(b, (ab, bl) => `data:${bl.type || "application/octet-stream"};base64,${Buffer.from(ab).toString("base64")}`);
  }
  abort() { this._emit("abort"); }
}
g.FileReader = FileReaderShim;
if (!URL.createObjectURL) URL.createObjectURL = () => "blob:node";
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

// the SDK prints "[MMDD HH:MM:SS...]" debug lines for everything, hide them unless TAMMI_SDK_LOG=1
if (!/^(1|true|yes)$/i.test(process.env.TAMMI_SDK_LOG || "")) {
  const SDK_LINE = /^\[\d{4} \d{2}:\d{2}:\d{2}/;
  for (const k of ["log", "info", "warn", "debug", "error"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      if (typeof a[0] === "string" && SDK_LINE.test(a[0])) return;
      orig(...a);
    };
  }
}

module.exports = { ORIGIN, UA };
