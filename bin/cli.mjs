#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { banner } from "./banner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const [, , cmd, ...rest] = process.argv;

function runNode(script, args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { stdio: "inherit", cwd: ROOT });
  process.exit(r.status ?? 0);
}

async function withCommands(fn) {
  const { default: commands } = await import("../bridge/commands.js");
  try {
    await fn(commands);
  } catch (e) {
    console.error(`✗ ${e?.message || e}`);
    process.exit(1);
  }
}

function help() {
  banner();
  console.log(`Usage: hermes-tammi-plugin <command> [options]

Commands:
  setup        Fetch the Tammi chat SDK, log in, install the background service and the Hermes plugin
               --no-service  --no-login  --relogin  --refresh-sdk  --service-only
               --hermes-home <path>   install into this Hermes profile (default ~/.hermes or HERMES_HOME)
  login        Log in to Tammi (--import | --password | --otp [--phone N] [--cf-token T], --force)
  logout       Revoke and delete the bridge's Tammi session
  start        Run the bridge in the foreground (Ctrl-C to stop)
  stop         Stop & remove the background service (plugin and login are kept)
  status       Show SDK / login / bridge / plugin state
  fetch-sdk    Re-extract the chat SDK from tammi.vn (--har file.har to use a HAR export)
  uninstall    Remove the service, the Hermes plugin and the CLI symlink (--purge also wipes login + SDK)
  help         Show this message

Data lives in ~/.hermes-tammi/ (override with TAMMI_DATA_DIR).
After 'setup':  hermes gateway setup  → choose Tammi,  then  hermes gateway`);
}

switch (cmd) {
  case "setup":
  case "install":
    runNode("install.mjs", rest);
    break;
  case "uninstall":
    runNode("uninstall.mjs", rest);
    break;
  case "stop":
    runNode("uninstall.mjs", ["--service-only", ...rest]);
    break;
  case "start":
    runNode("bridge/server.js", rest);
    break;
  case "login":
    await withCommands((c) => c.login(rest));
    break;
  case "logout":
    await withCommands((c) => c.logout());
    break;
  case "status":
    await withCommands((c) => c.status(rest));
    break;
  case "fetch-sdk":
    await withCommands((c) => c.fetchSdk(rest));
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    help();
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    help();
    process.exit(1);
}
