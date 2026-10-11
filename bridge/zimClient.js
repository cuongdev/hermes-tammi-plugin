"use strict";
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const paths = require("./paths");
const sdkFetcher = require("./sdkFetcher");
const { AuthError, REFRESH_MARGIN_SEC } = require("./tammiApi");

const TOKEN_CHECK_MS = 6 * 3600 * 1000;
const TOKEN_RETRY_MS = 5 * 60 * 1000;

const CONV = { peer: 0, room: 1, group: 2, channel: 3 };
const CONV_NAME = { 0: "peer", 1: "room", 2: "group", 3: "group" };
const MSG = { Text: 1, Command: 2, Multiple: 10, Image: 11, File: 12, Audio: 13, Video: 14, Revoke: 31, Tips: 32, Custom: 200 };
const CONN_EVENT = { Success: 0, ActiveLogin: 1, LoginTimeout: 2, LoginInterrupted: 3, KickedOut: 4, TokenExpired: 5, Unregistered: 6 };
const CUSTOM_LABEL = {
  5: "Danh thiếp", 16: "Bình chọn", 17: "Bình chọn", 19: "Mời họp", 20: "Cuộc gọi", 22: "Tin nhắn tự huỷ",
  33: "Lời mời vào nhóm", 68: "Chuyển khoản", 86: "Chuyển khoản (QR)", 99: "", 111: "", 196: "Vị trí", 197: "Vị trí",
  198: "Vị trí trực tiếp", 199: "Sticker", 200: "Thông báo", 104: "OA", 105: "OA", 106: "OA", 107: "OA", 109: "OA",
};
const TEXT_MAX_BYTES = Number(process.env.TAMMI_TEXT_MAX_BYTES || 4800); // web client limit is 5000

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "amr", "flac"]);
const MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
  wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", pdf: "application/pdf", txt: "text/plain",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip", csv: "text/csv", json: "application/json",
};

// the web app rewrites *.tammi.vn file hosts to *.vietteltammi.vn, downloads fail otherwise
function rewriteHost(url) {
  if (typeof url !== "string" || !url) return url;
  return url.replace(/^(https?:\/\/(?:[^/?#@]*@)?)((?:[^/?#:]+\.)?tammi\.vn)(?=[:/?#]|$)/i, (_m, pre, host) =>
    `${pre}${host.slice(0, host.length - "tammi.vn".length)}vietteltammi.vn`);
}

function splitByBytes(text, maxBytes = TEXT_MAX_BYTES) {
  const out = [];
  let rest = String(text || "");
  while (Buffer.byteLength(rest, "utf8") > maxBytes) {
    let lo = 0, hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(rest.slice(0, mid), "utf8") <= maxBytes) lo = mid; else hi = mid - 1;
    }
    let cut = lo;
    const window = rest.slice(0, lo);
    const nl = window.lastIndexOf("\n");
    const sp = window.lastIndexOf(" ");
    if (nl > lo * 0.5) cut = nl + 1; else if (sp > lo * 0.5) cut = sp + 1;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) out.push(rest);
  return out;
}

function convTypeCode(t) {
  if (t === undefined || t === null || t === "" || t === "auto") return null;
  if (typeof t === "number") return t;
  const s = String(t).toLowerCase();
  if (s in CONV) return CONV[s];
  if (s === "user" || s === "dm") return 0;
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

class ZimClient extends EventEmitter {
  constructor({ api, log = console }) {
    super();
    this.api = api;
    this.log = log;
    this.zim = null;
    this.ZIM = null;
    this.appID = 1090612485;
    this.selfId = null;
    this.selfName = "";
    this.selfAvatar = "";
    this.state = { loggedIn: false, connectionState: "disconnected", sessionDead: false, lastError: null, since: null };
    this._groupIds = new Set();
    this._peerIds = new Set();
    this._convNames = new Map();
    this._userNames = new Map();
    this._recent = new Map(); // messageID -> ZIM message, replyMessage needs the original
    this._reloginTimer = null;
    this._refreshTimer = null;
    this._stopping = false;
    this._lastTyping = new Map();
    this._sentIds = new Set(); // our own sends, so their echoes don't loop back to the agent
  }

  _rememberSent(r) {
    const m = r && r.message;
    if (!m) return "";
    for (const id of [m.messageID, m.localMessageID]) if (id) this._sentIds.add(String(id));
    if (this._sentIds.size > 2000) this._sentIds.delete(this._sentIds.values().next().value);
    return m.messageID || "";
  }

  async start() {
    if (!sdkFetcher.hasSdk()) {
      this.log.info("[tammi] SDK not found — extracting it from tammi.vn …");
      sdkFetcher.saveSdk(await sdkFetcher.fetchFromWeb({ log: (m) => this.log.info("[tammi]" + m) }));
    }
    const meta = sdkFetcher.loadMeta() || {};
    if (meta.appID) this.appID = meta.appID;
    require("./polyfill");
    const sdk = require(paths.sdkPath);
    this.ZIM = sdk.ZIM || sdk.default;
    this.sdkVersion = (this.ZIM.getVersion && this.ZIM.getVersion()) || meta.version || "?";
    try {
      this.ZIM.setAdvancedConfig("zim_enable_message_fuzzy_search", "1");
      this.ZIM.setAdvancedConfig("zim_enable_conv_name_fuzzy_search", "1");
    } catch {}
    this.zim = this.ZIM.create({ appID: this.appID });
    this._wireEvents();
    await this._login();
    this._scheduleTokenCheck(TOKEN_CHECK_MS);
  }

  // Access token lasts 15 days, refresh token 90 days and rotates on every refresh,
  // so a running bridge never has to log in again.
  _scheduleTokenCheck(delayMs) {
    clearTimeout(this._refreshTimer);
    if (this._stopping) return;
    this._refreshTimer = setTimeout(async () => {
      try {
        await this.api.ensureFreshToken();
        const { accessExpiresAt } = this.api.tokenExpiry();
        const untilRefresh = accessExpiresAt ? (accessExpiresAt - REFRESH_MARGIN_SEC) * 1000 - Date.now() : TOKEN_CHECK_MS;
        this._scheduleTokenCheck(Math.max(60000, Math.min(TOKEN_CHECK_MS, untilRefresh + 1000)));
      } catch (e) {
        if (e instanceof AuthError) return this._authFailed(e);
        this.log.warn(`[tammi] token check failed (${e.message || e}); retrying in ${TOKEN_RETRY_MS / 60000} min`);
        this._scheduleTokenCheck(TOKEN_RETRY_MS);
      }
    }, delayMs);
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  async stop() {
    this._stopping = true;
    clearTimeout(this._refreshTimer);
    clearTimeout(this._reloginTimer);
    if (this.zim) {
      try { await this.zim.logout(); } catch {}
    }
    this.state.loggedIn = false;
  }

  _wireEvents() {
    const z = this.zim;
    z.on("connectionStateChanged", (_z, d) => this._onConnState(d));
    z.on("tokenWillExpire", (_z, d) => this._renewToken(d).catch((e) => this.log.warn("[tammi] renewToken failed:", e.message || e)));
    z.on("error", (_z, d) => this.log.warn("[tammi] ZIM error:", JSON.stringify(d)));
    z.on("peerMessageReceived", (_z, d) => this._onMessages(d));
    z.on("groupMessageReceived", (_z, d) => this._onMessages(d));
    z.on("roomMessageReceived", () => {});
  }

  async _login() {
    const user = await this.api.userInfo();
    if (!user.zegoId) throw new Error("Tammi profile has no zegoId");
    this.selfId = user.zegoId;
    this.selfName = (user.nickname || user.username || "").trim();
    this.selfAvatar = (user.imageUrl || "").trim();
    const { token } = await this.api.zegoToken(this.selfId);
    try {
      await this.zim.login(this.selfId, { userName: "", token, customStatus: "online", isOfflineLogin: false, customStatusDuration: 0 });
    } catch (e) {
      if (!(e && e.code === 6000111)) throw e; // already logged in
    }
    this.state = { ...this.state, loggedIn: true, sessionDead: false, lastError: null, since: Date.now() };
    this.log.info(`[tammi] logged in as ${this.selfName} (${this.selfId}), SDK ${this.sdkVersion}`);
    this.emit("status", this.health());
    this._primeCaches().catch((e) => this.log.warn("[tammi] cache prime failed:", e.message || e));
  }

  async _primeCaches() {
    try {
      const gl = await this.zim.queryGroupList();
      for (const g of gl.groupList || []) {
        const gi = g.baseInfo || g.groupInfo || {};
        if (gi.groupID) { this._groupIds.add(gi.groupID); if (gi.groupName) this._convNames.set(gi.groupID, gi.groupName); }
      }
    } catch {}
    try { await this.conversations(100); } catch {}
  }

  // ZEGO token lasts 24h
  async _renewToken() {
    let last;
    for (let i = 0; i < 4; i++) {
      try {
        const { token } = await this.api.zegoToken(this.selfId);
        await this.zim.renewToken(token);
        this.log.info("[tammi] ZEGO token renewed");
        return;
      } catch (e) {
        last = e;
        if (e instanceof AuthError) return this._authFailed(e);
        await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
      }
    }
    this._scheduleRelogin(`ZEGO token renew failed (${(last && last.message) || last})`);
  }

  _onConnState(d) {
    const names = { 0: "disconnected", 1: "connecting", 2: "connected", 3: "reconnecting" };
    this.state.connectionState = names[d.state] || String(d.state);
    this.log.info(`[tammi] connection ${this.state.connectionState} (event ${d.event})`);
    if (d.state !== 0 || this._stopping) { this.emit("status", this.health()); return; }
    this.state.loggedIn = false;
    if (d.event === CONN_EVENT.KickedOut) {
      this._sessionDead("kicked_out",
        "Tài khoản Tammi vừa đăng nhập ở nơi khác (tab tammi.vn khác?) nên bridge bị đá ra. Đóng tab đó rồi gọi POST /relogin.");
      return;
    }
    if (d.event === CONN_EVENT.Unregistered) {
      this._sessionDead("unregistered", "Tài khoản Tammi không còn hợp lệ (unregistered).");
      return;
    }
    if (d.event !== CONN_EVENT.ActiveLogin) this._scheduleRelogin(`connection lost (event ${d.event})`);
  }

  _scheduleRelogin(reason, attempt = 0) {
    clearTimeout(this._reloginTimer);
    const delay = Math.min(60000, 2000 * 2 ** attempt);
    this.log.warn(`[tammi] ${reason}; re-login in ${Math.round(delay / 1000)}s`);
    this._reloginTimer = setTimeout(async () => {
      try {
        try { await this.zim.logout(); } catch {}
        await this._login();
      } catch (e) {
        if (e instanceof AuthError) return this._authFailed(e);
        this.state.lastError = String(e.message || JSON.stringify(e));
        this._scheduleRelogin(`re-login failed: ${this.state.lastError}`, attempt + 1);
      }
    }, delay);
  }

  _authFailed(e) {
    if (e instanceof AuthError) this._sessionDead("auth_expired", e.message);
    else this.log.warn("[tammi] token check failed:", e.message || e);
  }

  _sessionDead(code, message) {
    this.state = { ...this.state, loggedIn: false, sessionDead: true, lastError: message };
    this.log.error(`[tammi] SESSION DEAD (${code}): ${message}`);
    this.emit("session_dead", { code, message });
  }

  async relogin() {
    clearTimeout(this._reloginTimer);
    this.api.store.data = this.api.store.load();
    if (!this.zim) { await this.start(); return this.health(); }
    try { await this.zim.logout(); } catch {}
    await this._login();
    return this.health();
  }

  health() {
    const exp = this.api && this.api.tokenExpiry ? this.api.tokenExpiry() : {};
    const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
    return {
      ok: true,
      loggedIn: this.state.loggedIn,
      sessionDead: this.state.sessionDead,
      connectionState: this.state.connectionState,
      lastError: this.state.lastError,
      since: this.state.since,
      sdkVersion: this.sdkVersion,
      user: this.selfId ? { zegoId: this.selfId, name: this.selfName } : null,
      tokenExpiresAt: iso(exp.accessExpiresAt),
      refreshTokenExpiresAt: iso(exp.refreshExpiresAt),
    };
  }

  _onMessages(data) {
    const info = data.info || {};
    for (const m of data.messageList || []) {
      try {
        if (m.messageID) {
          this._recent.set(m.messageID, m);
          if (this._recent.size > 1000) this._recent.delete(this._recent.keys().next().value);
        }
        const n = this.normalize(m, info);
        if (n) this.emit("message", n);
      } catch (e) {
        this.log.warn("[tammi] failed to normalise message:", e.message || e);
      }
    }
  }

  normalize(m, info = {}) {
    const code = m.conversationType ?? info.conversationType ?? 0;
    if (code === 1) return null; // meeting rooms
    const isGroup = code === 2 || code === 3;
    const convId = m.conversationID || info.conversationID || data_fromConv(info);
    if (isGroup) this._groupIds.add(convId); else this._peerIds.add(convId);
    if (m.type === MSG.Command || m.type === MSG.Revoke || m.type === MSG.Tips || m.type === 30) return null;

    let ext = {};
    try { ext = m.extendedData ? JSON.parse(m.extendedData) : {}; } catch {}
    const senderId = m.senderUserID || "";
    const senderName = String(ext.senderName || this._userNames.get(senderId) || "").trim();
    if (senderName) this._userNames.set(senderId, senderName);

    const media = [];
    const texts = [];
    const pushMedia = (x) => {
      const kind = { [MSG.Image]: "image", [MSG.File]: "file", [MSG.Audio]: "audio", [MSG.Video]: "video" }[x.type];
      if (!kind) return;
      const url = rewriteHost(kind === "image" ? (x.largeImageDownloadUrl || x.fileDownloadUrl) : x.fileDownloadUrl);
      if (!url) return;
      const fileName = x.fileName || "";
      media.push({
        kind, url, fileName, size: x.fileSize || 0,
        ext: (fileName.split(".").pop() || "").toLowerCase(),
        duration: x.audioDuration || x.videoDuration || 0,
      });
    };

    let type = "unknown";
    switch (m.type) {
      case MSG.Text: type = "text"; texts.push(m.message || ""); break;
      case MSG.Image: type = "image"; pushMedia(m); break;
      case MSG.File: type = "file"; pushMedia(m); break;
      case MSG.Audio: type = "audio"; pushMedia(m); break;
      case MSG.Video: type = "video"; pushMedia(m); break;
      case MSG.Multiple:
        type = "multiple";
        for (const it of m.messageInfoList || []) {
          if (it.type === MSG.Text) texts.push(it.message || ""); else pushMedia(it);
        }
        break;
      case MSG.Custom: {
        type = "custom";
        const label = CUSTOM_LABEL[m.subType];
        const body = typeof m.message === "string" ? m.message : "";
        if (m.subType === 99 || m.subType === 111) texts.push(body); // markdown / bot text
        else if (m.subType === 5) {
          try { const c = JSON.parse(body); texts.push(`[Danh thiếp] ${c.username || ""} ${c.phoneNumber || ""}`.trim()); } catch { texts.push("[Danh thiếp]"); }
        } else texts.push(`[${label || "custom " + m.subType}]`);
        break;
      }
      case 100: type = "combine"; texts.push(`[Tin nhắn chuyển tiếp] ${m.title || ""} ${m.summary || ""}`.trim()); break;
      default: return null;
    }

    let replyTo = null;
    const ri = m.repliedInfo;
    if (ri) {
      const mi = ri.messageInfo || {};
      replyTo = {
        messageId: ri.messageID || mi.messageID || "",
        senderId: ri.senderUserID || mi.senderUserID || "",
        text: typeof mi.message === "string" ? mi.message.slice(0, 500) : "",
      };
    }

    return {
      messageId: m.messageID || "",
      localMessageId: m.localMessageID || "",
      messageSeq: m.messageSeq || 0,
      conversationId: convId,
      conversationType: isGroup ? "group" : "peer",
      conversationName: this._convNames.get(convId) || (!isGroup && senderId !== this.selfId ? senderName : ""),
      senderId,
      senderName,
      isSelf: Boolean(this.selfId && senderId === this.selfId),
      sentByBridge: this._sentIds.has(String(m.messageID || "")) || this._sentIds.has(String(m.localMessageID || "")),
      isOffline: Boolean(info.isOfflineMessage),
      timestamp: m.timestamp || Date.now(),
      type,
      subType: m.subType || 0,
      text: texts.filter(Boolean).join("\n"),
      mentions: m.mentionedUserIDs || [],
      isMentionAll: Boolean(m.isMentionAll),
      mentionedUsers: ext.mentionedUsers || {},
      isForward: Boolean(ext.isForward),
      replyTo,
      media,
    };
  }

  _ensureReady() {
    if (!this.zim || !this.state.loggedIn) throw new Error("Tammi bridge is not logged in");
  }

  async resolveType(convId, hint) {
    const code = convTypeCode(hint);
    if (code !== null) return code;
    if (this._groupIds.has(convId)) return 2;
    if (this._peerIds.has(convId)) return 0;
    try {
      const r = await this.zim.queryGroupInfo(convId);
      if (r && (r.groupInfo || r.baseInfo)) { this._groupIds.add(convId); return 2; }
    } catch {}
    return 0;
  }

  _extendedData(mentionedUsers = {}) {
    const ext = { senderName: this.selfName, mentionedUsers, isForward: false };
    if (this.selfAvatar) ext.senderAvatar = this.selfAvatar;
    return JSON.stringify(ext);
  }

  // same push payload as the web app, otherwise phones show no notification
  _pushConfig(convId, code, preview, mentionedUsers = {}, attachment) {
    const convName = this._convNames.get(convId) || "";
    const isGroup = code === 2 || code === 3;
    const payload = {
      id: convId, conversation_id: convId, lastMessagePreview: "", lastMessageAt: null, unreadCount: undefined,
      isPinned: false, isMuted: false, avatarURL: undefined,
      conversation_avatar: isGroup ? undefined : this.selfAvatar,
      type: CONV_NAME[code] || "peer", conversation_type: code, mentionedMe: false, mentionedAll: false,
      conversation_sender_id: this.selfId, conversation_sender_name: this.selfName || this.selfId,
      conversation_sender_avatar: this.selfAvatar, name: isGroup ? convName : this.selfId,
      conversation_name: convName, originalName: convName, action: "message", relatedUsers: mentionedUsers,
    };
    if (attachment) payload.attachment = attachment;
    return {
      title: isGroup ? convName : this.selfName,
      content: preview,
      payload: JSON.stringify(payload),
      badgeIncrement: 1,
      enableBadge: true,
      resourcesID: "appviettel_sms",
      threadID: "",
      voIPConfig: { iOSVoIPHasVideo: false, iOSVoIPHandleType: 1, iOSVoIPHandleValue: "" },
    };
  }

  _sendConfig(convId, code, preview, attachment) {
    return {
      priority: 2,
      hasReceipt: false,
      isNotifyMentionedUsers: true,
      disableUnreadMessageCount: false,
      isRetrySend: false,
      isAllowMultipleMessagePartialFailed: false,
      pushConfig: this._pushConfig(convId, code, preview, {}, attachment),
    };
  }

  async _sendWithRetry(fn) {
    let last;
    for (let i = 0; i < 4; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (!(e && e.code === 6000004)) break; // network hiccup, retry
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw last;
  }

  async sendText(convId, convType, text, { replyTo } = {}) {
    this._ensureReady();
    const code = await this.resolveType(convId, convType);
    const chunks = splitByBytes(text);
    const ids = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const msg = { type: MSG.Text, message: chunk, mentionedUserIDs: [], isMentionAll: false, extendedData: this._extendedData() };
      const config = this._sendConfig(convId, code, chunk.slice(0, 200));
      const original = i === 0 && replyTo ? this._recent.get(replyTo) : null;
      const r = await this._sendWithRetry(() =>
        original ? this.zim.replyMessage(msg, original, config, {}) : this.zim.sendMessage(msg, convId, code, config, {}));
      ids.push(this._rememberSent(r));
    }
    return { messageIds: ids, messageId: ids[ids.length - 1] || "" };
  }

  async sendFile(convId, convType, filePath, { kind, caption, fileName } = {}) {
    this._ensureReady();
    const code = await this.resolveType(convId, convType);
    const abs = path.resolve(filePath);
    const buf = fs.readFileSync(abs);
    const name = fileName || path.basename(abs);
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (!kind || kind === "auto") kind = IMAGE_EXT.has(ext) ? "image" : VIDEO_EXT.has(ext) ? "video" : AUDIO_EXT.has(ext) ? "audio" : "file";
    // Tammi apps don't play ogg/opus voice notes inline
    if (kind === "audio" && !["m4a", "mp3", "aac", "wav"].includes(ext)) kind = "file";
    const type = { image: MSG.Image, video: MSG.Video, audio: MSG.Audio, file: MSG.File }[kind] || MSG.File;
    const file = new File([buf], name, { type: MIME[ext] || "application/octet-stream" });
    let attachment;
    let ext2 = this._extendedData();
    if (type === MSG.File) {
      attachment = { type: "file", name, ext, size: buf.length };
      ext2 = JSON.stringify({ ...JSON.parse(ext2), attachment });
    }
    const msg = { type, fileLocalPath: file, fileName: name, fileSize: buf.length, extendedData: ext2 };
    if (type === MSG.Audio) msg.audioDuration = 1;
    if (type === MSG.Video) { msg.videoDuration = 1; msg.videoFirstFrameWidth = 0; msg.videoFirstFrameHeight = 0; }
    const preview = { [MSG.Image]: "[Ảnh]", [MSG.File]: "[Tệp tin]", [MSG.Audio]: "[Âm thanh]", [MSG.Video]: "[Video]" }[type];
    const r = await this._sendWithRetry(() =>
      this.zim.sendMessage(msg, convId, code, this._sendConfig(convId, code, preview, attachment), {
        onMediaUploadingProgress: () => {},
      }));
    const out = { messageId: this._rememberSent(r), kind };
    if (caption && String(caption).trim()) {
      const t = await this.sendText(convId, code, caption);
      out.captionMessageId = t.messageId;
    }
    return out;
  }

  async typing(convId, convType, stop = false) {
    this._ensureReady();
    const code = await this.resolveType(convId, convType);
    const key = `${convId}:${stop ? 1 : 0}`;
    const now = Date.now();
    if (!stop && now - (this._lastTyping.get(key) || 0) < 9000) return { skipped: true };
    this._lastTyping.set(key, now);
    const payload = new Uint8Array([...(stop ? "stop_typing" : "typing")].map((c) => c.charCodeAt(0)));
    await this.zim.sendMessage({ type: MSG.Command, message: payload }, convId, code, { priority: 3 });
    return { ok: true };
  }

  async markRead(convId, convType) {
    this._ensureReady();
    const code = await this.resolveType(convId, convType);
    try { await this.zim.clearConversationUnreadMessageCount(convId, code); } catch {}
    try { await this.zim.sendConversationMessageReceiptRead(convId, code); } catch {}
    return { ok: true };
  }

  async conversations(count = 100) {
    this._ensureReady();
    const out = [];
    let next = null;
    while (out.length < count) {
      const r = await this.zim.queryConversationList({ count: Math.min(100, count - out.length), nextConversation: next });
      const list = r.conversationList || [];
      for (const c of list) {
        const isGroup = c.type === 2 || c.type === 3;
        if (c.conversationName) this._convNames.set(c.conversationID, c.conversationName);
        if (isGroup) this._groupIds.add(c.conversationID); else if (c.type === 0) this._peerIds.add(c.conversationID);
        if (c.type === 1) continue;
        out.push({
          id: c.conversationID,
          type: isGroup ? "group" : "peer",
          name: c.conversationName || c.conversationID,
          unread: c.unreadMessageCount || 0,
          lastMessageAt: c.lastMessage ? c.lastMessage.timestamp : null,
          isOA: isOfficialAccount(c.conversationID),
          isDocument: Array.isArray(c.marks) && c.marks.includes(4),
        });
      }
      if (list.length === 0 || list.length < Math.min(100, count)) break;
      next = list[list.length - 1];
    }
    return out;
  }

  async contacts() {
    const convs = await this.conversations(200).catch(() => []);
    let book = [];
    try { book = await this.api.contacts(); } catch {}
    const friends = new Map();
    for (const c of convs) if (c.type === "peer" && !c.isOA) friends.set(c.id, { id: c.id, name: c.name });
    for (const b of book) if (!friends.has(b.id)) friends.set(b.id, { id: b.id, name: b.name });
    const groups = convs.filter((c) => c.type === "group");
    // a group with only the owner in it works as a private chat with the bot
    const selfChats = [];
    for (const g of groups.slice(0, 40)) {
      try {
        const r = await this.zim.queryGroupMemberCount(g.id);
        if (r && Number(r.count) === 1) selfChats.push({ id: g.id, name: g.name });
      } catch {}
    }
    for (const g of groups) if (g.isDocument && !selfChats.some((s) => s.id === g.id)) selfChats.unshift({ id: g.id, name: g.name });
    return {
      friends: [...friends.values()],
      groups: groups.filter((c) => !selfChats.some((s) => s.id === c.id)).map((c) => ({ id: c.id, name: c.name })),
      selfChats,
      oa: convs.filter((c) => c.isOA).map((c) => ({ id: c.id, name: c.name })),
    };
  }
}

function data_fromConv(info) { return info.fromConversationID || ""; }

// official accounts (@RBT#OA_...) and the built-in "Tammi" assistant
function isOfficialAccount(id) {
  return typeof id === "string" && (id.startsWith("@") || id === "Tammi");
}

module.exports = { ZimClient, rewriteHost, splitByBytes, convTypeCode, isOfficialAccount, CONV };
