"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { splitByBytes, rewriteHost, convTypeCode, isOfficialAccount, ZimClient } = require("../bridge/zimClient");
const { extractSdk, chunkRefs } = require("../bridge/sdkFetcher");
const { enableInConfig, disableInConfig } = require("../bridge/commands");
const { normalizePhone } = require("../bridge/tammiApi");

test("splitByBytes keeps every chunk under the byte limit and loses nothing", () => {
  const text = "Xin chào các bạn, đây là tiếng Việt có dấu. ".repeat(400);
  const chunks = splitByBytes(text, 4800);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(Buffer.byteLength(c, "utf8") <= 4800);
  assert.strictEqual(chunks.join(" ").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
  assert.deepStrictEqual(splitByBytes("ngắn"), ["ngắn"]);
});

test("rewriteHost maps *.tammi.vn to *.vietteltammi.vn only", () => {
  assert.strictEqual(rewriteHost("https://cdn.tammi.vn/a.png"), "https://cdn.vietteltammi.vn/a.png");
  assert.strictEqual(rewriteHost("https://tammi.vn/x"), "https://vietteltammi.vn/x");
  assert.strictEqual(rewriteHost("https://access.vietteltammi.vn/x"), "https://access.vietteltammi.vn/x");
  assert.strictEqual(rewriteHost("https://example.com/tammi.vn"), "https://example.com/tammi.vn");
});

test("convTypeCode / isOfficialAccount / normalizePhone", () => {
  assert.strictEqual(convTypeCode("peer"), 0);
  assert.strictEqual(convTypeCode("group"), 2);
  assert.strictEqual(convTypeCode("user"), 0);
  assert.strictEqual(convTypeCode(2), 2);
  assert.strictEqual(convTypeCode("auto"), null);
  assert.strictEqual(convTypeCode(undefined), null);
  assert.ok(isOfficialAccount("@RBT#OA_1"));
  assert.ok(isOfficialAccount("Tammi"));
  assert.ok(!isOfficialAccount("f1a2b3c4d5e6f7a8b9c0d1e2"));
  assert.strictEqual(normalizePhone("+84 912 345 678"), "0912345678");
  assert.strictEqual(normalizePhone("0912345678"), "0912345678");
});

test("extractSdk pulls the CommonJS-wrapped UMD module out of an esbuild chunk", () => {
  const chunk =
    'import{e as el}from"./chunk-A.js";var La=el((ui,Ua)=>{"use strict";((O,Ae)=>{if(typeof ui=="object"&&typeof Ua=="object")Ua.exports=Ae();})(Object(typeof self<"u"?self:ui),()=>{var Et={};Et.ZIM={create(){return 42},getVersion(){return"9.9"}};typeof window>"u"||window.ZIM||(window.ZIM=Et.ZIM);return Et})});var tl=1;export{La as a};';
  const src = extractSdk(chunk);
  assert.ok(src);
  const file = path.join(os.tmpdir(), `zim-test-${process.pid}.cjs`);
  fs.writeFileSync(file, src);
  const mod = require(file);
  assert.strictEqual(mod.ZIM.create(), 42);
  assert.strictEqual(extractSdk("no sdk here"), null);
  assert.deepStrictEqual(chunkRefs('import"./chunk-AB12.js";import("./chunk-CD34.js")').sort(), ["chunk-AB12.js", "chunk-CD34.js"]);
});

test("enableInConfig / disableInConfig handle every plugins.enabled shape idempotently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tammi-cfg-"));
  const cases = {
    block: "model: x\nplugins:\n  enabled:\n    - homeassistant\n  disabled: []\nother: 1\n",
    inline: "plugins:\n  enabled: [homeassistant, zalo-platform]\n",
    missingPlugins: "model: x\n",
    noEnabled: "plugins:\n  disabled: []\nother: 2\n",
  };
  for (const [name, text] of Object.entries(cases)) {
    const f = path.join(dir, `${name}.yaml`);
    fs.writeFileSync(f, text);
    assert.strictEqual(enableInConfig(f, "tammi-platform"), true, name);
    assert.strictEqual(enableInConfig(f, "tammi-platform"), false, `${name} idempotent`);
    const after = fs.readFileSync(f, "utf8");
    assert.ok(after.includes("tammi-platform"), name);
    assert.strictEqual((after.match(/tammi-platform/g) || []).length, 1, name);
    if (name === "block") assert.match(after, /enabled:\n    - homeassistant\n    - tammi-platform\n  disabled/);
    if (name === "noEnabled" || name === "block") assert.match(after, /other: \d/);
    assert.strictEqual(disableInConfig(f, "tammi-platform"), true, `${name} disable`);
    assert.ok(!fs.readFileSync(f, "utf8").includes("tammi-platform"), name);
  }
});

test("normalize maps ZIM messages to the bridge event shape", () => {
  const c = new ZimClient({ api: {}, log: { info() {}, warn() {}, error() {} } });
  c.selfId = "me";
  const text = c.normalize({
    type: 1, message: "chào", senderUserID: "u1", conversationID: "u1", conversationType: 0, messageID: "1", timestamp: 5,
    extendedData: JSON.stringify({ senderName: "Bạn A" }),
  });
  assert.strictEqual(text.text, "chào");
  assert.strictEqual(text.senderName, "Bạn A");
  assert.strictEqual(text.conversationType, "peer");
  assert.strictEqual(text.isSelf, false);

  const img = c.normalize({
    type: 11, senderUserID: "u1", conversationID: "g1", conversationType: 2, messageID: "2",
    largeImageDownloadUrl: "https://x.tammi.vn/i?Type=larger", fileName: "a.png", fileSize: 10,
  });
  assert.strictEqual(img.conversationType, "group");
  assert.strictEqual(img.media[0].kind, "image");
  assert.strictEqual(img.media[0].url, "https://x.vietteltammi.vn/i?Type=larger");

  const multi = c.normalize({
    type: 10, senderUserID: "me", conversationID: "u1", conversationType: 0, messageID: "3",
    messageInfoList: [{ type: 1, message: "caption" }, { type: 12, fileDownloadUrl: "https://f/x", fileName: "r.pdf" }],
  });
  assert.strictEqual(multi.text, "caption");
  assert.strictEqual(multi.media[0].kind, "file");
  assert.strictEqual(multi.isSelf, true);

  const card = c.normalize({ type: 200, subType: 5, message: JSON.stringify({ username: "Vũ", phoneNumber: "09" }), senderUserID: "u1", conversationID: "u1", conversationType: 0 });
  assert.strictEqual(card.text, "[Danh thiếp] Vũ 09");

  assert.strictEqual(c.normalize({ type: 2, message: "typing", senderUserID: "u1", conversationID: "u1", conversationType: 0 }), null);
  assert.strictEqual(c.normalize({ type: 32, senderUserID: "u1", conversationID: "g1", conversationType: 2 }), null);
  assert.strictEqual(c.normalize({ type: 1, message: "room", senderUserID: "u1", conversationID: "r", conversationType: 1 }), null);

  c._sentIds.add("99");
  assert.strictEqual(c.normalize({ type: 1, message: "echo", senderUserID: "me", conversationID: "g1", conversationType: 2, messageID: "99" }).sentByBridge, true);
});

test("service files point at this package's server.js and the data dir", () => {
  const { renderPlist, renderUnit, LABEL } = require("../bridge/service");
  const plist = renderPlist({ nodeBin: "/usr/bin/node", serverJs: "/pkg/bridge/server.js", logFile: "/d/bridge.log" });
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  assert.match(plist, /<string>\/usr\/bin\/node<\/string>\s*<string>\/pkg\/bridge\/server.js<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  const unit = renderUnit({ nodeBin: "/usr/bin/node", serverJs: "/pkg/bridge/server.js" });
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/pkg\/bridge\/server.js/);
  assert.match(unit, /Restart=always/);
});

test("resolveHermesHome: --hermes-home > HERMES_HOME > ~/.hermes", () => {
  const { resolveHermesHome } = require("../bridge/commands");
  const saved = process.env.HERMES_HOME;
  delete process.env.HERMES_HOME;
  assert.strictEqual(resolveHermesHome([]).source, "default");
  process.env.HERMES_HOME = "/tmp/hx";
  assert.deepStrictEqual(resolveHermesHome([]), { dir: "/tmp/hx", source: "env" });
  assert.deepStrictEqual(resolveHermesHome(["--hermes-home", "/tmp/hy"]), { dir: "/tmp/hy", source: "flag" });
  assert.strictEqual(resolveHermesHome(["--hermes-home=~/p"]).dir, path.join(os.homedir(), "p"));
  assert.throws(() => resolveHermesHome(["--hermes-home"]));
  if (saved === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = saved;
});
