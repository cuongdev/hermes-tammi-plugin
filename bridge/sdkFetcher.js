"use strict";
// The ZIM SDK is not ours to redistribute, so it is pulled out of the tammi.vn bundle
// (or a HAR export) on the user's machine.
const fs = require("fs");
const crypto = require("crypto");
const paths = require("./paths");

const BASE = "https://tammi.vn";
const ZIM_MARKER = "window.ZIM||(window.ZIM=";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

const CHUNK_RE = /["'(](\.?\/?(?:chunk|main)-[A-Za-z0-9_-]+\.js)["')]/g;

function chunkRefs(text) {
  const out = new Set();
  for (const m of text.matchAll(CHUNK_RE)) out.add(m[1].replace(/^\.?\//, ""));
  return [...out];
}

// esbuild wraps the SDK as var X=__commonJS((exports,module)=>{...}); unwrap it into a plain CJS module
function extractSdk(chunkText) {
  const marker = chunkText.indexOf(ZIM_MARKER);
  if (marker < 0) return null;
  const startRe = /var [\w$]+=[\w$]+\(\(([\w$]+),([\w$]+)\)=>\{"use strict";\(\(/g;
  let start = null;
  for (const m of chunkText.matchAll(startRe)) {
    if (m.index > marker) break;
    start = m;
  }
  if (!start) throw new Error("ZIM SDK found but its module wrapper start was not recognised");
  const endIdx = chunkText.indexOf("})});", marker);
  if (endIdx < 0) throw new Error("ZIM SDK found but its module wrapper end was not recognised");
  const bodyStart = start.index + start[0].length - '"use strict";(('.length;
  const body = chunkText.slice(bodyStart, endIdx + 2);
  const [exportsName, moduleName] = [start[1], start[2]];
  return `/* Extracted from ${BASE} at ${new Date().toISOString()} — proprietary, do not redistribute. */\n` +
    `(function(${exportsName},${moduleName}){${body}\n})(module.exports,module);\n`;
}

function readAppConfig(text) {
  const appId = text.match(/ZEGO_APP_ID:(\d+)/);
  return appId ? { appID: Number(appId[1]) } : null;
}

async function fetchFromWeb({ log = console.log, maxFiles = 400 } = {}) {
  const index = await fetchText(BASE + "/");
  const queue = [];
  for (const m of index.matchAll(/src="\/?((?:main|chunk)-[A-Za-z0-9_-]+\.js)"/g)) queue.push(m[1]);
  if (!queue.length) throw new Error("Could not find main-*.js in tammi.vn index.html");
  const seen = new Set(queue);
  let sdk = null;
  let appConfig = null;
  let sourceFile = null;
  let fetched = 0;
  while (queue.length && fetched < maxFiles && (!sdk || !appConfig)) {
    const batch = queue.splice(0, 8);
    const texts = await Promise.all(batch.map((f) => fetchText(`${BASE}/${f}`).catch(() => "")));
    fetched += batch.length;
    batch.forEach((file, i) => {
      const text = texts[i];
      if (!text) return;
      if (!appConfig) appConfig = readAppConfig(text);
      if (!sdk && text.includes(ZIM_MARKER)) {
        sdk = extractSdk(text);
        sourceFile = file;
        log(`  found ZIM SDK in ${file}`);
      }
      for (const ref of chunkRefs(text)) {
        if (!seen.has(ref)) { seen.add(ref); queue.push(ref); }
      }
    });
  }
  if (!sdk) throw new Error(`ZIM SDK not found after scanning ${fetched} bundle files`);
  return { sdk, appConfig, sourceFile, source: BASE };
}

function fromHar(harPath, { log = console.log } = {}) {
  const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
  let sdk = null;
  let appConfig = null;
  let sourceFile = null;
  for (const e of har.log.entries) {
    const url = e.request.url;
    if (!/\.js(\?|$)/.test(url)) continue;
    const c = e.response && e.response.content;
    if (!c || !c.text) continue;
    const text = c.encoding === "base64" ? Buffer.from(c.text, "base64").toString("utf8") : c.text;
    if (!appConfig) appConfig = readAppConfig(text);
    if (!sdk && text.includes(ZIM_MARKER)) {
      sdk = extractSdk(text);
      sourceFile = url;
      log(`  found ZIM SDK in ${url}`);
    }
  }
  if (!sdk) throw new Error("ZIM SDK not found in HAR (export it with content: 'Save all as HAR with content')");
  return { sdk, appConfig, sourceFile, source: harPath };
}

function saveSdk({ sdk, appConfig, sourceFile, source }) {
  paths.ensureDir(paths.sdkDir);
  fs.writeFileSync(paths.sdkPath, sdk);
  const version = (sdk.match(/getVersion=function\(\)\{return"([^"]+)"/) || [])[1] || "unknown";
  const meta = {
    version,
    appID: (appConfig && appConfig.appID) || 1090612485,
    source,
    sourceFile,
    sha256: crypto.createHash("sha256").update(sdk).digest("hex"),
    fetchedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.sdkMetaPath, JSON.stringify(meta, null, 2));
  return meta;
}

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(paths.sdkMetaPath, "utf8")); } catch { return null; }
}

function hasSdk() {
  return fs.existsSync(paths.sdkPath);
}

module.exports = { extractSdk, fetchFromWeb, fromHar, saveSdk, loadMeta, hasSdk, chunkRefs };
