"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const paths = require("./paths");
const sdkFetcher = require("./sdkFetcher");
const { TammiApi, normalizePhone } = require("./tammiApi");

const CLI_NAME = "hermes-tammi-plugin";
const PLUGIN_KEY = "tammi-platform"; // must match `name` in hermes-plugin/plugin.yaml
const PLUGIN_DIR_NAME = "tammi";
const PKG_ROOT = path.resolve(__dirname, "..");
const BRIDGE_URL = process.env.TAMMI_BRIDGE_URL || `http://127.0.0.1:${process.env.TAMMI_BRIDGE_PORT || 8788}`;
const BROWSER_SNIPPET =
  "copy(JSON.stringify({token:localStorage.token,refresh_token:localStorage.refresh_token,device_id:localStorage.device_id}))";

function ask(q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    if (hidden && process.stdin.isTTY) {
      rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write("*"); };
    }
    rl.question(q, (a) => { rl.close(); if (hidden && process.stdin.isTTY) process.stdout.write("\n"); resolve(String(a || "").trim()); });
  });
}

async function choose(title, options, def = 1) {
  console.log(title);
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
  const a = await ask(`Chọn (1-${options.length}) [${def}]: `);
  const n = Number(a || def);
  return n >= 1 && n <= options.length ? n : def;
}

function flagValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const next = argv[i + 1];
      if (next == null || next.startsWith("-")) throw new Error(`${name} requires a value`);
      return next;
    }
    if (a.startsWith(`${name}=`)) {
      const v = a.slice(name.length + 1);
      if (!v) throw new Error(`${name} requires a value`);
      return v;
    }
  }
  return undefined;
}

function tokenHeader() {
  return process.env.TAMMI_BRIDGE_TOKEN ? { "x-bridge-token": process.env.TAMMI_BRIDGE_TOKEN } : {};
}

async function bridgeHealth(url = BRIDGE_URL) {
  try {
    const r = await fetch(`${url}/health`, { headers: tokenHeader(), signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch { return null; }
}

async function fetchSdk(argv = []) {
  const har = flagValue(argv, "--har");
  console.log(har ? `Extracting the Tammi chat SDK from ${har} …` : "Downloading the Tammi web bundle and extracting the chat SDK …");
  const found = har ? sdkFetcher.fromHar(har) : await sdkFetcher.fetchFromWeb();
  const meta = sdkFetcher.saveSdk(found);
  console.log(`✓ SDK ${meta.version} (appID ${meta.appID}) saved to ${paths.sdkPath}`);
  return meta;
}

async function currentUser() {
  const api = new TammiApi();
  if (!api.store.loggedIn) return null;
  try { return await api.userInfo(); } catch { return null; }
}

async function login(argv = []) {
  const has = (f) => argv.includes(f);
  const api = new TammiApi();
  if (api.store.loggedIn && !has("--force") && !has("--relogin")) {
    const u = await currentUser();
    if (u) {
      console.log(`✓ Đã đăng nhập: ${u.nickname || u.username} (${u.phoneNumber}). Dùng --force để đăng nhập lại.`);
      return u;
    }
    console.log("Phiên cũ không còn dùng được — đăng nhập lại.");
  }

  let method = has("--import") ? 1 : has("--password") ? 2 : has("--otp") ? 3 : 0;
  if (!method) {
    method = await choose("\nCách đăng nhập Tammi:", [
      "Lấy phiên từ trình duyệt (khuyên dùng — tammi.vn bắt Cloudflare captcha khi gửi OTP)",
      "Số điện thoại + mật khẩu (chỉ khi tài khoản đã đặt mật khẩu trong app Tammi)",
      "Số điện thoại + OTP (cần Cloudflare Turnstile token — nâng cao)",
    ], 1);
  }

  if (method === 1) {
    console.log(`
  1) Mở https://tammi.vn trên Chrome/Edge và đăng nhập như bình thường (OTP qua SMS).
  2) Bấm F12 (hoặc Cmd+Option+J) → tab Console, gõ allow pasting nếu Chrome hỏi, rồi dán lệnh sau + Enter:

     ${BROWSER_SNIPPET}

  3) Quay lại đây và dán (Cmd+V / Ctrl+V) kết quả vừa copy.
  ⚠ Lấy xong thì ĐÓNG tab tammi.vn, KHÔNG bấm "Đăng xuất" (sẽ huỷ luôn phiên của bridge).
`);
    const raw = await ask("Dán JSON: ", { hidden: true });
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("Không đọc được JSON — copy lại đúng lệnh ở bước 2."); }
    const u = await api.importSession(parsed);
    api.store.save({ phone: normalizePhone(u.phoneNumber) });
    return loggedIn(u);
  }

  const phone = normalizePhone(flagValue(argv, "--phone") || (await ask("Số điện thoại Tammi: ")));
  if (!(await api.checkUserExists(phone))) throw new Error(`Số ${phone} chưa có tài khoản Tammi.`);

  if (method === 2) {
    const pw = await ask("Mật khẩu: ", { hidden: true });
    await api.loginPassword(phone, pw);
    return loggedIn(await api.userInfo());
  }

  const cfToken = flagValue(argv, "--cf-token") || (await ask("Cloudflare Turnstile token (để trống để thử không cần): "));
  const otpCfg = await api.requestOtp(phone, cfToken);
  console.log(`Đã gửi OTP (${otpCfg.length} số, hết hạn sau ${otpCfg.expired}s).`);
  const otp = await ask("Nhập OTP: ");
  await api.loginOtp(phone, otp);
  return loggedIn(await api.userInfo());
}

async function loggedIn(u) {
  console.log(`\n✓ Đăng nhập thành công: ${u.nickname || u.username} (${u.phoneNumber}), zegoId ${u.zegoId}`);
  console.log(`  Phiên lưu tại ${paths.credentialsPath} (chmod 600).`);
  if (await bridgeHealth()) {
    try {
      await fetch(`${BRIDGE_URL}/relogin`, { method: "POST", headers: tokenHeader() });
      console.log("  Bridge đang chạy → đã yêu cầu đăng nhập lại với phiên mới.");
    } catch {}
  }
  return u;
}

async function logout() {
  const api = new TammiApi();
  await api.logout();
  console.log("✓ Đã đăng xuất và xoá phiên Tammi của bridge.");
}

function expandUserPath(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.resolve(path.join(os.homedir(), p.slice(2)));
  return path.resolve(p);
}

// --hermes-home, then HERMES_HOME, then ~/.hermes
function resolveHermesHome(argv = []) {
  const flagged = flagValue(argv, "--hermes-home");
  if (flagged != null) return { dir: expandUserPath(flagged), source: "flag" };
  const env = (process.env.HERMES_HOME || "").trim();
  if (env) return { dir: expandUserPath(env), source: "env" };
  return { dir: path.join(os.homedir(), ".hermes"), source: "default" };
}

function enableInConfig(cfgPath, key = PLUGIN_KEY) {
  let text = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "";
  const lines = text.split("\n");
  const pIdx = lines.findIndex((l) => /^plugins:\s*(#.*)?$/.test(l));
  if (pIdx < 0) {
    text = (text ? text.replace(/\n*$/, "\n") : "") + `plugins:\n  enabled:\n    - ${key}\n`;
    fs.writeFileSync(cfgPath, text);
    return true;
  }
  let end = lines.length;
  for (let i = pIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() && !/^\s/.test(lines[i]) && !lines[i].startsWith("#")) { end = i; break; }
  }
  let eIdx = -1;
  for (let i = pIdx + 1; i < end; i++) if (/^\s+enabled:/.test(lines[i])) { eIdx = i; break; }
  if (eIdx < 0) {
    lines.splice(pIdx + 1, 0, "  enabled:", `    - ${key}`);
  } else {
    const m = lines[eIdx].match(/^(\s+)enabled:\s*(.*)$/);
    const indent = m[1];
    const inline = m[2].replace(/#.*$/, "").trim();
    if (inline.startsWith("[")) {
      const items = inline.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      if (items.includes(key)) return false;
      items.push(key);
      lines[eIdx] = `${indent}enabled: [${items.join(", ")}]`;
    } else {
      let last = eIdx;
      let itemIndent = indent + "  ";
      for (let i = eIdx + 1; i < end; i++) {
        const im = lines[i].match(/^(\s*)-\s*(.+?)\s*$/);
        if (!im) { if (lines[i].trim() === "") continue; break; }
        itemIndent = im[1];
        if (im[2].replace(/^['"]|['"]$/g, "") === key) return false;
        last = i;
      }
      lines.splice(last + 1, 0, `${itemIndent}- ${key}`);
    }
  }
  fs.writeFileSync(cfgPath, lines.join("\n"));
  return true;
}

function disableInConfig(cfgPath, key = PLUGIN_KEY) {
  if (!fs.existsSync(cfgPath)) return false;
  const lines = fs.readFileSync(cfgPath, "utf8").split("\n");
  let changed = false;
  const out = [];
  for (const l of lines) {
    const block = l.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*$/);
    if (block && block[1] === key) { changed = true; continue; }
    const inline = l.match(/^(\s+enabled:\s*)\[(.*)\](.*)$/);
    if (inline) {
      const items = inline[2].split(",").map((s) => s.trim()).filter(Boolean);
      const kept = items.filter((s) => s.replace(/^['"]|['"]$/g, "") !== key);
      if (kept.length !== items.length) { changed = true; out.push(`${inline[1]}[${kept.join(", ")}]${inline[3]}`); continue; }
    }
    out.push(l);
  }
  if (changed) fs.writeFileSync(cfgPath, out.join("\n"));
  return changed;
}

function installHermesPlugin(argv = [], log = console.log) {
  const src = path.join(PKG_ROOT, "hermes-plugin");
  const home = resolveHermesHome(argv);
  const from = home.source === "flag" ? "--hermes-home" : home.source === "env" ? "HERMES_HOME" : "default ~/.hermes";
  log(`Hermes home: ${home.dir} (${from})`);
  if (!fs.existsSync(home.dir)) {
    if (home.source === "default") {
      log(`⚠ Hermes home not found at ${home.dir} — skipping the plugin install.`);
      log(`  Install Hermes, or pass --hermes-home <path>, then re-run: ${CLI_NAME} setup --service-only`);
      return false;
    }
    fs.mkdirSync(home.dir, { recursive: true });
  }
  const dst = path.join(home.dir, "plugins", PLUGIN_DIR_NAME);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f === "__pycache__" || f.endsWith(".pyc")) continue;
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  // the adapter reads this to find the bridge of a global install
  fs.writeFileSync(path.join(dst, "bridge_dir.txt"), path.join(PKG_ROOT, "bridge") + "\n");
  log(`✓ Plugin copied to ${dst}`);
  const cfgPath = path.join(home.dir, "config.yaml");
  try {
    log(enableInConfig(cfgPath) ? `✓ Added "${PLUGIN_KEY}" to plugins.enabled in config.yaml` : `✓ "${PLUGIN_KEY}" already in plugins.enabled`);
  } catch (e) {
    log(`⚠ Could not edit ${cfgPath}: ${e.message}`);
    log(`  Add "${PLUGIN_KEY}" under plugins.enabled manually.`);
  }
  return true;
}

function removeHermesPlugin(argv = [], log = console.log) {
  const home = resolveHermesHome(argv);
  if (home.source === "default" && !fs.existsSync(home.dir)) {
    log(`• No Hermes home at ${home.dir}. Pass --hermes-home <path> if the plugin lives in another profile.`);
    return;
  }
  const dst = path.join(home.dir, "plugins", PLUGIN_DIR_NAME);
  if (fs.existsSync(dst)) {
    fs.rmSync(dst, { recursive: true, force: true });
    log(`✓ Removed Hermes plugin: ${dst}`);
  } else {
    log("• No Hermes plugin directory to remove.");
  }
  try {
    log(disableInConfig(path.join(home.dir, "config.yaml"))
      ? `✓ Removed "${PLUGIN_KEY}" from plugins.enabled in config.yaml`
      : "• Plugin was not enabled in config.yaml (nothing to remove).");
  } catch (e) {
    log(`⚠ Could not edit config.yaml: ${e.message}`);
  }
}

async function status(argv = []) {
  const h = await bridgeHealth();
  const api = new TammiApi();
  const meta = sdkFetcher.loadMeta();
  const home = resolveHermesHome(argv);
  const user = api.store.data.user || {};
  const exp = api.tokenExpiry();
  const fmt = (s) => (s ? `${new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC (${Math.round((s * 1000 - Date.now()) / 86400000)}d)` : "?");
  console.log(`Data dir:    ${paths.dataDir}`);
  console.log(`SDK:         ${meta ? `${meta.version} (${meta.fetchedAt})` : `missing — run \`${CLI_NAME} fetch-sdk\``}`);
  console.log(`Login:       ${api.store.loggedIn ? `yes (${user.nickname || api.store.data.phone || "?"})` : `no — run \`${CLI_NAME} login\``}`);
  if (api.store.loggedIn) console.log(`Tokens:      access until ${fmt(exp.accessExpiresAt)}, refresh until ${fmt(exp.refreshExpiresAt)} — auto-renewed while the bridge runs`);
  if (!h) console.log(`Bridge:      NOT running at ${BRIDGE_URL} (service off; the Hermes gateway auto-starts it, or run \`${CLI_NAME} start\`)`);
  else console.log(`Bridge:      ${BRIDGE_URL} loggedIn=${h.loggedIn} state=${h.connectionState}${h.sessionDead ? " SESSION DEAD" : ""}${h.lastError ? ` lastError=${h.lastError}` : ""}`);
  const installed = fs.existsSync(path.join(home.dir, "plugins", PLUGIN_DIR_NAME, "adapter.py"));
  console.log(`Plugin:      ${installed ? `installed in ${home.dir}` : `not installed — run \`${CLI_NAME} setup\``}`);
}

module.exports = {
  CLI_NAME, PLUGIN_KEY, PKG_ROOT, BRIDGE_URL,
  ask, choose, flagValue, bridgeHealth,
  fetchSdk, currentUser, login, logout, status,
  resolveHermesHome, enableInConfig, disableInConfig, installHermesPlugin, removeHermesPlugin,
};
