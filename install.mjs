// hermes-tammi-plugin setup [--no-service] [--no-login] [--relogin] [--refresh-sdk] [--service-only] [--hermes-home <path>]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import commands from "./bridge/commands.js";
import service from "./bridge/service.js";
import sdkFetcher from "./bridge/sdkFetcher.js";
import { banner } from "./bin/banner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const PLATFORM = process.platform;
const MIN_NODE = 20;

const log = (m) => console.log(m);
const step = (n, m) => console.log(`\n[${n}] ${m}`);
function die(m) { console.error(`\n✗ ${m}`); process.exit(1); }

function checkPrereqs() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < MIN_NODE) {
    die(`Node >= ${MIN_NODE} required (found ${process.version}).\n` +
      "  macOS: brew install node · Linux: nvm / distro nodejs · Windows: https://nodejs.org (LTS)");
  }
  log(`✓ Node ${process.version}`);
}

function installDeps() {
  if (fs.existsSync(path.join(__dirname, "node_modules", "ws")) || fs.existsSync(path.join(__dirname, "..", "ws"))) {
    log("✓ Dependencies already present");
    return;
  }
  step(1, "Installing dependencies (npm install)…");
  const npm = PLATFORM === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["install", "--no-audit", "--no-fund", "--omit=dev"], { stdio: "inherit", cwd: __dirname, shell: PLATFORM === "win32" });
  if (r.status !== 0) die("npm install failed");
  log("✓ Dependencies installed");
}

async function ensureSdk() {
  step(2, "Tammi chat SDK…");
  if (sdkFetcher.hasSdk() && !has("--refresh-sdk")) {
    log(`✓ SDK present (${(sdkFetcher.loadMeta() || {}).version || "?"})`);
    return;
  }
  await commands.fetchSdk(argv);
}

async function ensureLogin() {
  step(3, "Tammi login…");
  if (has("--no-login")) {
    log(`• Skipped (--no-login). Log in later with: ${commands.CLI_NAME} login`);
    return;
  }
  await commands.login(argv);
}

function ensureService() {
  step(4, "Background service (auto-start + auto-restart)…");
  if (has("--no-service")) {
    log("• Skipped (--no-service). The Hermes gateway starts the bridge itself when it connects.");
    return;
  }
  service.install(log);
}

function nextSteps() {
  console.log(`
────────────────────────────────────────────────────────
✓ Tammi plugin is set up.

  Bridge:   ${commands.BRIDGE_URL}   (health: curl ${commands.BRIDGE_URL}/health)
  Status:   ${commands.CLI_NAME} status

Next, register Tammi in Hermes:
  1) hermes gateway setup   → choose "Tammi"
  2) hermes gateway         → start relaying

Re-login any time with: ${commands.CLI_NAME} login --force
────────────────────────────────────────────────────────
`);
}

async function main() {
  banner();
  console.log("Hermes Tammi Plugin — installer");
  console.log("(Safe to re-run: the SDK and login are skipped when already present, the service is re-registered.)\n");
  checkPrereqs();
  if (has("--service-only")) {
    ensureService();
    step(5, "Hermes plugin…");
    commands.installHermesPlugin(argv, log);
    nextSteps();
    return;
  }
  installDeps();
  await ensureSdk();
  await ensureLogin();
  ensureService();
  step(5, "Hermes plugin (so `hermes gateway` sees Tammi)…");
  commands.installHermesPlugin(argv, log);
  nextSteps();
}

main().catch((e) => die(e?.message || String(e)));
