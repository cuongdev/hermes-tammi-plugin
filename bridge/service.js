"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths");

const LABEL = "com.hermes.tammiplugin";
const WIN_TASK = "HermesTammiPlugin";
const SERVER_JS = path.join(__dirname, "server.js");

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plistPath() { return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`); }
function unitPath() { return path.join(os.homedir(), ".config", "systemd", "user", `${LABEL}.service`); }

function renderPlist({ nodeBin = process.execPath, serverJs = SERVER_JS, logFile = path.join(paths.dataDir, "bridge.log") } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeBin)}</string>
    <string>${xml(serverJs)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(path.dirname(serverJs))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TAMMI_DATA_DIR</key><string>${xml(paths.dataDir)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

function renderUnit({ nodeBin = process.execPath, serverJs = SERVER_JS } = {}) {
  return `[Unit]
Description=Hermes Tammi bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${path.dirname(serverJs)}
Environment=TAMMI_DATA_DIR=${paths.dataDir}
ExecStart=${nodeBin} ${serverJs}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function install(log = console.log) {
  paths.ensureDir();
  if (process.platform === "darwin") {
    const p = plistPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, renderPlist());
    spawnSync("launchctl", ["unload", p], { stdio: "ignore" });
    const r = spawnSync("launchctl", ["load", p], { stdio: "inherit" });
    if (r.status !== 0) { log(`⚠ launchctl load failed — start the bridge manually: hermes-tammi-plugin start`); return false; }
    log(`✓ launchd service installed: ${p}`);
    return true;
  }
  if (process.platform === "linux") {
    const p = unitPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, renderUnit());
    if (spawnSync("systemctl", ["--version"], { stdio: "ignore" }).status !== 0) {
      log(`⚠ systemd not available. Unit written to ${p}; run the bridge with: hermes-tammi-plugin start`);
      return false;
    }
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    spawnSync("systemctl", ["--user", "enable", "--now", `${LABEL}.service`], { stdio: "inherit" });
    log(`✓ systemd user service installed & started: ${p}`);
    log("  Tip: `loginctl enable-linger $USER` keeps it running without an active login session.");
    return true;
  }
  if (process.platform === "win32") {
    const cmd = `"${process.execPath}" "${SERVER_JS}"`;
    const r = spawnSync("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/TN", WIN_TASK, "/TR", cmd, "/RL", "LIMITED"], { stdio: "inherit", shell: true });
    if (r.status !== 0) { log("⚠ Could not register a Scheduled Task. Run the bridge with: hermes-tammi-plugin start"); return false; }
    spawnSync("schtasks", ["/Run", "/TN", WIN_TASK], { stdio: "ignore", shell: true });
    log(`✓ Scheduled Task '${WIN_TASK}' registered (runs at logon) and started.`);
    return true;
  }
  log(`⚠ No auto-start service for platform '${process.platform}'. Run: hermes-tammi-plugin start`);
  return false;
}

function remove(log = console.log) {
  if (process.platform === "darwin") {
    const p = plistPath();
    if (!fs.existsSync(p)) return log("• No launchd service found.");
    spawnSync("launchctl", ["unload", p], { stdio: "ignore" });
    fs.rmSync(p, { force: true });
    return log(`✓ Removed launchd service: ${p}`);
  }
  if (process.platform === "linux") {
    const p = unitPath();
    if (spawnSync("systemctl", ["--version"], { stdio: "ignore" }).status === 0) {
      spawnSync("systemctl", ["--user", "disable", "--now", `${LABEL}.service`], { stdio: "ignore" });
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    }
    if (!fs.existsSync(p)) return log("• No systemd unit found.");
    fs.rmSync(p, { force: true });
    return log(`✓ Removed systemd unit: ${p}`);
  }
  if (process.platform === "win32") {
    spawnSync("schtasks", ["/End", "/TN", WIN_TASK], { stdio: "ignore", shell: true });
    const r = spawnSync("schtasks", ["/Delete", "/F", "/TN", WIN_TASK], { stdio: "ignore", shell: true });
    return log(r.status === 0 ? `✓ Removed Scheduled Task '${WIN_TASK}'.` : `• No Scheduled Task '${WIN_TASK}'.`);
  }
  log(`• Unsupported platform '${process.platform}' — nothing to remove.`);
}

function isInstalled() {
  if (process.platform === "darwin") return fs.existsSync(plistPath());
  if (process.platform === "linux") return fs.existsSync(unitPath());
  if (process.platform === "win32") return spawnSync("schtasks", ["/Query", "/TN", WIN_TASK], { stdio: "ignore", shell: true }).status === 0;
  return false;
}

module.exports = { LABEL, WIN_TASK, install, remove, isInstalled, renderPlist, renderUnit };
