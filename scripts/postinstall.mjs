#!/usr/bin/env node
// With the Node bundled by Hermes the npm global bin is ~/.hermes/node/bin, which is not on
// PATH. In that case link the CLI next to the `node` on PATH. Global installs only, never fails.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "hermes-tammi-plugin";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const CLI = path.join(PKG_ROOT, "bin", "cli.mjs");

const log = (m) => console.log(`[${NAME}] ${m}`);

const isGlobal = () =>
  process.env.npm_config_global === "true" ||
  String(process.env.npm_config_location || "").toLowerCase() === "global";

const pathDirs = () => (process.env.PATH || "").split(path.delimiter).filter(Boolean);
const canon = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isOnPath = (dir) => { const c = canon(dir); return pathDirs().some((d) => canon(d) === c); };
const isWritable = (dir) => {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
};

function nodeBinDirOnPath() {
  for (const d of pathDirs()) {
    try { if (fs.existsSync(path.join(d, "node"))) return path.resolve(d); } catch { /* ignore */ }
  }
  return null;
}

function pickTarget(prefixBin) {
  const seen = new Set();
  const candidates = [nodeBinDirOnPath(), path.join(os.homedir(), ".local", "bin"), ...pathDirs()];
  for (const c of candidates) {
    if (!c) continue;
    const dir = path.resolve(c);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (canon(dir) === canon(prefixBin)) continue;
    if (isOnPath(dir) && fs.existsSync(dir) && isWritable(dir)) return dir;
  }
  return null;
}

try {
  if (!isGlobal()) process.exit(0);
  if (process.platform === "win32") process.exit(0);

  try { fs.chmodSync(CLI, 0o755); } catch {}

  // PKG_ROOT is <prefix>/lib/node_modules/<name>
  const prefixBin = path.resolve(PKG_ROOT, "..", "..", "..", "bin");

  if (isOnPath(prefixBin)) process.exit(0);

  const target = pickTarget(prefixBin);
  if (!target) {
    log(`installed, but its bin dir isn't on your PATH (${prefixBin}).`);
    log(`Run it with:  npx ${NAME} <cmd>`);
    log(`or add to PATH:  export PATH="${prefixBin}:$PATH"`);
    process.exit(0);
  }

  const link = path.join(target, NAME);
  try {
    const st = fs.lstatSync(link);
    const ours =
      st.isSymbolicLink() &&
      (path.resolve(target, fs.readlinkSync(link)) === CLI ||
        fs.readlinkSync(link).includes(`${path.sep}${NAME}${path.sep}`));
    if (!ours) {
      log(`a different '${NAME}' already exists in ${target}; leaving it. Use: npx ${NAME}`);
      process.exit(0);
    }
    fs.rmSync(link);
  } catch { /* doesn't exist yet — good */ }

  fs.symlinkSync(CLI, link);

  // npm doesn't run uninstall scripts anymore, so remember the link for `uninstall`
  try {
    const stateDir = process.env.TAMMI_DATA_DIR
      ? path.resolve(process.env.TAMMI_DATA_DIR)
      : path.join(os.homedir(), ".hermes-tammi");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, ".binlink"), link + "\n");
  } catch { /* non-fatal */ }

  log(`linked '${NAME}' into ${target} (on your PATH).`);
  log(`If the command isn't found yet in THIS shell, run 'rehash' (zsh) / 'hash -r' (bash) or open a new terminal.`);
} catch (e) {
  try { log(`postinstall note (non-fatal): ${e && e.message ? e.message : e}`); } catch { /* ignore */ }
  process.exit(0);
}
