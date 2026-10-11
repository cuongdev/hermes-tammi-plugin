"use strict";
// keep runtime data out of the package dir, a global install can be read-only
const os = require("os");
const path = require("path");
const fs = require("fs");

const dataDir = process.env.TAMMI_DATA_DIR || path.join(os.homedir(), ".hermes-tammi");

function ensureDir(dir = dataDir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

module.exports = {
  dataDir,
  ensureDir,
  credentialsPath: process.env.TAMMI_CREDENTIALS_PATH || path.join(dataDir, "credentials.json"),
  sdkDir: path.join(dataDir, "sdk"),
  sdkPath: path.join(dataDir, "sdk", "zim-sdk.cjs"),
  sdkMetaPath: path.join(dataDir, "sdk", "meta.json"),
};
