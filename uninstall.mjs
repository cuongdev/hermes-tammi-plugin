// hermes-tammi-plugin uninstall [--purge] [--hermes-home <path>]
// hermes-tammi-plugin stop  (= uninstall --service-only)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import commands from "./bridge/commands.js";
import service from "./bridge/service.js";
import paths from "./bridge/paths.js";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const log = (m) => console.log(m);

function removeBinLink() {
  try {
    const record = path.join(paths.dataDir, ".binlink");
    if (!fs.existsSync(record)) return;
    const link = fs.readFileSync(record, "utf8").trim();
    if (link && fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) {
      fs.rmSync(link, { force: true });
      log(`✓ Removed CLI symlink: ${link}`);
    }
    fs.rmSync(record, { force: true });
  } catch (e) {
    log(`• Could not remove CLI symlink: ${e.message}`);
  }
}

async function purge() {
  try { await commands.logout(); } catch (e) { log(`• Logout: ${e.message}`); }
  if (fs.existsSync(paths.dataDir) && path.resolve(paths.dataDir) !== os.homedir()) {
    fs.rmSync(paths.dataDir, { recursive: true, force: true });
    log(`✓ Deleted ${paths.dataDir} (credentials, SDK, logs).`);
  }
}

async function main() {
  if (has("--service-only")) {
    service.remove(log);
    log("\nBridge service stopped. Start it again with: hermes-tammi-plugin setup --service-only (or `start`).");
    return;
  }
  console.log("Hermes Tammi Plugin — uninstaller\n=================================");
  service.remove(log);
  commands.removeHermesPlugin(argv, log);
  removeBinLink();
  if (has("--purge")) await purge();
  console.log(`\nDone.${has("--purge") ? "" : " (Login + SDK kept in " + paths.dataDir + " — add --purge to delete.)"}`);
  console.log("Remove the package itself with: npm uninstall -g hermes-tammi-plugin");
}

main().catch((e) => { console.error(`✗ ${e.message || e}`); process.exit(1); });
