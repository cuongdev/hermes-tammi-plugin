"""Tammi platform adapter. Talks to the Node bridge (bridge/server.js) over HTTP + SSE."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
    cache_audio_from_bytes,
    cache_document_from_bytes,
    cache_image_from_bytes,
)

logger = logging.getLogger(__name__)

DEFAULT_BRIDGE_URL = "http://127.0.0.1:8788"
CLI_NAME = "hermes-tammi-plugin"
DATA_DIR = Path(os.getenv("TAMMI_DATA_DIR") or (Path.home() / ".hermes-tammi"))
MAX_MESSAGE_LENGTH = 4000


def _truthy(v: Any, default: bool = False) -> bool:
    if v is None or str(v).strip() == "":
        return default
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


def _csv(raw: Optional[str]) -> List[str]:
    return [x.strip() for x in str(raw or "").split(",") if x.strip()]


def parse_target(raw: str) -> Tuple[str, Optional[str]]:
    raw = str(raw or "").strip()
    if ":" in raw:
        prefix, _, rest = raw.partition(":")
        p = prefix.strip().lower()
        if p in {"group", "g"}:
            return rest.strip(), "group"
        if p in {"peer", "user", "dm", "p"}:
            return rest.strip(), "peer"
    return raw, None


def is_official_account(conv_id: str) -> bool:
    return isinstance(conv_id, str) and (conv_id.startswith("@") or conv_id == "Tammi")


def addressed_text(msg: Dict[str, Any], own_id: Optional[str], own_name: Optional[str]) -> Optional[str]:
    """Text to handle if a group message is aimed at us (@mention, reply to us, or starts with our name)."""
    text = str(msg.get("text") or "")
    names = [n for n in [own_name, "hermes", "bot"] if n]

    def strip_names(t: str) -> str:
        out = t
        for n in names:
            out = out.replace("@" + n, " ")
        return " ".join(out.split()).strip()

    mentions = {str(x) for x in (msg.get("mentions") or [])}
    if own_id and str(own_id) in mentions:
        return strip_names(text) or text or " "
    reply = msg.get("replyTo") or {}
    if own_id and str(reply.get("senderId") or "") == str(own_id):
        return text or " "
    low = text.strip().lower()
    for n in names:
        nl = n.lower()
        for cand in ("@" + nl, nl):
            if low.startswith(cand):
                nxt = low[len(cand):len(cand) + 1]
                if nxt and nxt.isalnum():
                    continue
                rest = text.strip()[len(cand):].lstrip(" :,@-").strip()
                return rest or text.strip()
    return None


def _media_message_type(kind: str) -> MessageType:
    return {
        "image": MessageType.PHOTO,
        "audio": MessageType.VOICE,
        "video": MessageType.VIDEO,
    }.get(kind, MessageType.DOCUMENT)


def _find_bridge_dir() -> Optional[str]:
    candidates: List[str] = []
    if os.getenv("TAMMI_BRIDGE_DIR"):
        candidates.append(os.getenv("TAMMI_BRIDGE_DIR", ""))
    marker = Path(__file__).with_name("bridge_dir.txt")
    if marker.exists():
        candidates.append(marker.read_text(encoding="utf-8").strip())
    candidates.append(str(Path(__file__).resolve().parent.parent / "bridge"))
    cli = shutil.which(CLI_NAME)  # global install: <pkg>/bin/cli.mjs
    if cli:
        candidates.append(str(Path(os.path.realpath(cli)).parent.parent / "bridge"))
    for c in candidates:
        if c and (Path(c) / "server.js").exists():
            return c
    return None


def _is_local_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1"}


SERVICE_LABEL = "com.hermes.tammiplugin"  # same as bridge/service.js
_service_cache: Dict[str, bool] = {}


def _service_installed() -> bool:
    if "v" in _service_cache:
        return _service_cache["v"]
    home = Path.home()
    if sys.platform == "darwin":
        found = (home / "Library" / "LaunchAgents" / f"{SERVICE_LABEL}.plist").exists()
    elif sys.platform.startswith("linux"):
        found = (home / ".config" / "systemd" / "user" / f"{SERVICE_LABEL}.service").exists()
    elif sys.platform == "win32":
        try:
            found = subprocess.run(["schtasks", "/Query", "/TN", "HermesTammiPlugin"], capture_output=True, timeout=10).returncode == 0
        except Exception:
            found = False
    else:
        found = False
    _service_cache["v"] = found
    return found


class TammiAdapter(BasePlatformAdapter):

    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform("tammi"))
        extra = getattr(config, "extra", {}) or {}

        self.bridge_url = (os.getenv("TAMMI_BRIDGE_URL") or extra.get("bridge_url") or DEFAULT_BRIDGE_URL).rstrip("/")
        self.bridge_token = os.getenv("TAMMI_BRIDGE_TOKEN") or extra.get("bridge_token", "")
        self.autostart = _truthy(os.getenv("TAMMI_BRIDGE_AUTOSTART", extra.get("autostart")), default=True)

        self.allowed_users = set(_csv(os.getenv("TAMMI_ALLOWED_USERS")))
        self.allow_all = _truthy(os.getenv("TAMMI_ALLOW_ALL_USERS"))
        self.pairing = _truthy(os.getenv("TAMMI_PAIRING"))
        self.allowed_conversations = set(_csv(os.getenv("TAMMI_ALLOWED_CONVERSATIONS")))
        mode = (os.getenv("TAMMI_GROUP_MODE") or extra.get("group_mode") or "mention").strip().lower()
        self.group_mode = mode if mode in {"mention", "all", "off"} else "mention"
        self.self_chat_id = (os.getenv("TAMMI_SELF_CHAT_ID") or "").strip()
        self.ignore_oa = _truthy(os.getenv("TAMMI_IGNORE_OA"), default=True)
        self.process_offline = _truthy(os.getenv("TAMMI_PROCESS_OFFLINE"))
        self.max_age = int(os.getenv("TAMMI_MAX_MESSAGE_AGE") or 600)
        self.log_ids = _truthy(os.getenv("TAMMI_LOG_IDS"))

        self._own_id: Optional[str] = None
        self._own_name: Optional[str] = None
        self._conv_types: Dict[str, str] = {}
        self._conv_names: Dict[str, str] = {}
        self._denied_logged: set = set()

        self._session = None
        self._sse_task: Optional[asyncio.Task] = None
        self._stop = False
        self._last_event_id = 0
        self._bridge_proc: Optional[subprocess.Popen] = None

    @property
    def name(self) -> str:
        return "Tammi"

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.bridge_token:
            h["x-bridge-token"] = self.bridge_token
        return h

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        del is_reconnect
        try:
            import aiohttp
        except ImportError:
            self._set_fatal_error("dependency_missing", "aiohttp is required (pip install aiohttp)", retryable=False)
            return False

        self._stop = False
        self._session = aiohttp.ClientSession()

        health = await self._health()
        if health is None and _service_installed():
            # the OS service restarts it, don't fight it for the port
            health = await self._wait_for(lambda h: h is not None, timeout=30)
        if health is None and self.autostart and _is_local_url(self.bridge_url) and not _service_installed():
            err = self._spawn_bridge()
            if err:
                await self._close_session()
                self._set_fatal_error("bridge_spawn_failed", err, retryable=False)
                return False
            health = await self._wait_for(lambda h: h is not None, timeout=25)

        if health is None:
            await self._close_session()
            self._set_fatal_error(
                "bridge_unreachable",
                f"Tammi bridge unreachable at {self.bridge_url}. Start it with `hermes-tammi-plugin start` "
                f"or set TAMMI_BRIDGE_AUTOSTART=true.",
                retryable=True,
            )
            return False

        if not health.get("hasCredentials", True):
            await self._close_session()
            self._set_fatal_error(
                "not_logged_in", "Tammi bridge has no saved login — run `hermes-tammi-plugin login`, then restart the gateway.",
                retryable=True,
            )
            return False

        if not health.get("loggedIn"):
            health = await self._wait_for(lambda h: bool(h and (h.get("loggedIn") or h.get("sessionDead"))), timeout=40) or health
        if not health.get("loggedIn"):
            await self._close_session()
            reason = health.get("lastError") or "bridge did not finish logging in"
            self._set_fatal_error("not_logged_in", f"Tammi login failed: {reason}", retryable=True)
            return False

        self._apply_health(health)
        self._sse_task = asyncio.create_task(self._sse_loop())
        self._mark_connected()
        logger.info("Tammi: connected via %s as %s (%s)", self.bridge_url, self._own_name, self._own_id)
        return True

    async def disconnect(self) -> None:
        self._stop = True
        self._mark_disconnected()
        if self._sse_task and not self._sse_task.done():
            self._sse_task.cancel()
            try:
                await self._sse_task
            except (asyncio.CancelledError, Exception):
                pass
        await self._close_session()
        if self._bridge_proc and self._bridge_proc.poll() is None:
            logger.info("Tammi: stopping the bridge started by this gateway (pid %s)", self._bridge_proc.pid)
            self._bridge_proc.terminate()
            try:
                self._bridge_proc.wait(timeout=5)
            except Exception:
                self._bridge_proc.kill()
        self._bridge_proc = None

    async def _close_session(self) -> None:
        if self._session and not self._session.closed:
            try:
                await self._session.close()
            except Exception:
                pass
        self._session = None

    def _apply_health(self, health: Dict[str, Any]) -> None:
        user = health.get("user") or {}
        if user.get("zegoId"):
            self._own_id = str(user["zegoId"])
            self._own_name = str(user.get("name") or "") or None

    def _spawn_bridge(self) -> Optional[str]:
        node = shutil.which("node")
        if not node:
            return "Node.js (>=20) is required for the Tammi bridge but `node` was not found on PATH."
        bridge_dir = _find_bridge_dir()
        if not bridge_dir:
            return "Cannot find the Tammi bridge (server.js). Run `npm install -g hermes-tammi-plugin && hermes-tammi-plugin setup`, or set TAMMI_BRIDGE_DIR."
        parsed = urlparse(self.bridge_url)
        env = dict(os.environ)
        env.setdefault("TAMMI_BRIDGE_HOST", parsed.hostname or "127.0.0.1")
        env["TAMMI_BRIDGE_PORT"] = str(parsed.port or 8788)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        log_path = DATA_DIR / "bridge.log"
        try:
            log_fh = open(log_path, "a", encoding="utf-8")
            self._bridge_proc = subprocess.Popen(
                [node, str(Path(bridge_dir) / "server.js")],
                cwd=bridge_dir, env=env, stdout=log_fh, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, start_new_session=True,
            )
        except Exception as e:
            return f"Failed to start the Tammi bridge: {e}"
        logger.info("Tammi: started bridge pid %s (log: %s)", self._bridge_proc.pid, log_path)
        return None

    async def _health(self) -> Optional[Dict[str, Any]]:
        import aiohttp
        if not self._session:
            return None
        try:
            async with self._session.get(
                f"{self.bridge_url}/health", headers=self._headers(), timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                return await resp.json()
        except Exception:
            return None

    async def _wait_for(self, pred, timeout: float) -> Optional[Dict[str, Any]]:
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = await self._health()
            if pred(last):
                return last
            if self._bridge_proc and self._bridge_proc.poll() is not None:
                logger.error("Tammi: bridge exited early (code %s) — see %s", self._bridge_proc.returncode, DATA_DIR / "bridge.log")
                return last
            await asyncio.sleep(1.0)
        return last

    async def _sse_loop(self) -> None:
        import aiohttp
        backoff = 1.0
        while not self._stop:
            try:
                headers = self._headers()
                headers.pop("Content-Type", None)
                if self._last_event_id:
                    headers["Last-Event-ID"] = str(self._last_event_id)
                async with self._session.get(
                    f"{self.bridge_url}/events", headers=headers,
                    timeout=aiohttp.ClientTimeout(total=None, sock_read=60),
                ) as resp:
                    if resp.status != 200:
                        raise RuntimeError(f"SSE status {resp.status}")
                    backoff = 1.0
                    await self._consume_sse(resp)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._stop:
                    break
                logger.warning("Tammi: SSE disconnected (%s); reconnecting in %.0fs", e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
                await self._respawn_bridge_if_dead()

    async def _respawn_bridge_if_dead(self) -> None:
        if not self.autostart or not _is_local_url(self.bridge_url) or _service_installed():
            return
        if self._bridge_proc and self._bridge_proc.poll() is None:
            return
        if await self._health() is not None:
            return
        logger.warning("Tammi: bridge at %s is not running — starting it", self.bridge_url)
        err = self._spawn_bridge()
        if err:
            logger.error("Tammi: %s", err)

    async def _consume_sse(self, resp) -> None:
        event_type, data_lines, event_id = "message", [], None
        async for raw in resp.content:
            if self._stop:
                return
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line == "":
                if data_lines:
                    await self._handle_event(event_type, "\n".join(data_lines))
                    if event_id is not None:
                        self._last_event_id = event_id
                event_type, data_lines, event_id = "message", [], None
            elif line.startswith(":"):
                continue
            elif line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            elif line.startswith("id:"):
                try:
                    event_id = int(line[3:].strip())
                except ValueError:
                    event_id = None

    async def _handle_event(self, event_type: str, payload: str) -> None:
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return
        if event_type == "message":
            try:
                await self._on_message(data)
            except Exception:
                logger.exception("Tammi: failed to handle inbound message")
        elif event_type == "status":
            self._apply_health(data)
            if data.get("sessionDead"):
                await self._on_session_dead({"message": data.get("lastError") or "session dead"})
        elif event_type == "session_dead":
            await self._on_session_dead(data)

    async def _on_session_dead(self, data: Dict[str, Any]) -> None:
        msg = (data or {}).get("message") or "Tammi session ended."
        logger.error("Tammi: SESSION DEAD: %s", msg)
        self._set_fatal_error(
            "session_dead",
            f"{msg} Fix: close other tammi.vn tabs, or run `hermes-tammi-plugin login --force`; then "
            f"`curl -X POST {self.bridge_url}/relogin` (or restart the gateway).",
            retryable=True,
        )
        try:
            await self._notify_fatal_error()
        except Exception:
            pass

    def _sender_allowed(self, sender_id: str) -> bool:
        if self.allow_all or self.pairing:
            return True
        return sender_id in self.allowed_users

    async def _on_message(self, m: Dict[str, Any]) -> None:
        if not self._message_handler:
            return
        conv_id = str(m.get("conversationId") or "")
        conv_type = "group" if m.get("conversationType") == "group" else "peer"
        sender_id = str(m.get("senderId") or "")
        sender_name = str(m.get("senderName") or "")
        if not conv_id:
            return
        self._conv_types[conv_id] = conv_type
        if m.get("conversationName"):
            self._conv_names[conv_id] = str(m["conversationName"])

        if self.log_ids:
            logger.info("Tammi inbound: sender=%s (%r) conversation=%s type=%s self=%s",
                        sender_id, sender_name, conv_id, conv_type, m.get("isSelf"))

        # our own messages only count in the self chat, and never the bot's own replies
        if m.get("isSelf"):
            if not (self.self_chat_id and conv_id == self.self_chat_id) or m.get("sentByBridge"):
                return
        if m.get("isOffline") and not self.process_offline:
            return
        ts = m.get("timestamp")
        if isinstance(ts, (int, float)) and ts > 0 and time.time() - ts / 1000.0 > self.max_age:
            return
        if self.ignore_oa and is_official_account(conv_id):
            return
        if self.allowed_conversations and conv_id not in self.allowed_conversations and conv_id != self.self_chat_id:
            return
        if not m.get("isSelf") and not self._sender_allowed(sender_id):
            if sender_id not in self._denied_logged:
                self._denied_logged.add(sender_id)
                logger.info("Tammi: ignoring %r (%s) — not in TAMMI_ALLOWED_USERS", sender_name, sender_id)
            return

        text = str(m.get("text") or "")
        if conv_type == "group" and conv_id != self.self_chat_id:
            if self.group_mode == "off":
                return
            if self.group_mode == "mention":
                hit = addressed_text(m, self._own_id, self._own_name)
                if hit is None:
                    return
                text = hit

        media_urls: List[str] = []
        media_types: List[str] = []
        message_type = MessageType.TEXT
        for media in m.get("media") or []:
            path = await self._download_media(media)
            if path:
                media_urls.append(path)
                media_types.append(media.get("kind") or "file")
                if message_type == MessageType.TEXT:
                    message_type = _media_message_type(media.get("kind") or "file")
        if not text.strip() and not media_urls:
            return

        chat_type = "group" if conv_type == "group" else "dm"
        chat_name = self._conv_names.get(conv_id) or (sender_name if chat_type == "dm" else conv_id)
        source = self.build_source(
            chat_id=conv_id, chat_name=chat_name, chat_type=chat_type,
            user_id=sender_id, user_name=sender_name or sender_id, message_id=str(m.get("messageId") or "") or None,
        )
        reply = m.get("replyTo") or {}
        event = MessageEvent(
            text=text,
            message_type=message_type,
            source=source,
            user_id=sender_id,
            user_name=sender_name or sender_id,
            message_id=str(m.get("messageId") or "") or None,
            raw_message=m,
            media_urls=media_urls,
            media_types=media_types,
            reply_to_message_id=reply.get("messageId") or None,
            reply_to_text=reply.get("text") or None,
            reply_to_author_id=reply.get("senderId") or None,
            reply_to_is_own_message=bool(self._own_id and reply.get("senderId") == self._own_id),
            timestamp=datetime.fromtimestamp(ts / 1000.0) if isinstance(ts, (int, float)) and ts > 0 else datetime.now(),
        )
        await self.handle_message(event)

    async def _download_media(self, media: Dict[str, Any]) -> Optional[str]:
        import aiohttp
        url = media.get("url")
        if not url or not self._session:
            return None
        kind = media.get("kind") or "file"
        try:
            async with self._session.get(url, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                if resp.status != 200:
                    logger.warning("Tammi: media download HTTP %s (%s)", resp.status, kind)
                    return None
                data = await resp.read()
                ctype = resp.headers.get("Content-Type", "")
        except Exception as e:
            logger.warning("Tammi: media download failed (%s): %s", kind, e)
            return None
        ext = (media.get("ext") or "").lstrip(".")
        if not ext and "/" in ctype:
            ext = ctype.split("/")[-1].split(";")[0].replace("jpeg", "jpg").replace("mpeg", "mp3")
        try:
            if kind == "image":
                return cache_image_from_bytes(data, ext="." + (ext or "jpg"))
            if kind == "audio":
                return cache_audio_from_bytes(data, ext="." + (ext or "m4a"))
            name = media.get("fileName") or f"tammi.{ext or 'bin'}"
            return cache_document_from_bytes(data, name)
        except Exception as e:
            logger.warning("Tammi: failed to cache media: %s", e)
            return None

    async def _post(self, path: str, body: Dict[str, Any], timeout: float = 120) -> Dict[str, Any]:
        import aiohttp
        if not self._session or self._session.closed:
            return {"success": False, "error": "Tammi adapter not connected"}
        try:
            async with self._session.post(
                f"{self.bridge_url}{path}", data=json.dumps(body), headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                data = await resp.json(content_type=None)
                if resp.status >= 400 and data.get("success") is not False:
                    data = {"success": False, "error": f"HTTP {resp.status}"}
                return data
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _resolve(self, chat_id: str, metadata: Optional[Dict[str, Any]]) -> Tuple[str, str]:
        conv_id, explicit = parse_target(chat_id)
        if explicit:
            return conv_id, explicit
        md_type = (metadata or {}).get("conversation_type") or (metadata or {}).get("thread_type")
        if md_type in {"group", "peer"}:
            return conv_id, md_type
        return conv_id, self._conv_types.get(conv_id, "auto")

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        conv_id, conv_type = self._resolve(chat_id, metadata)
        if not (content or "").strip():
            return SendResult(success=True)
        last_id = None
        for i, chunk in enumerate(self.truncate_message(content, max_length=MAX_MESSAGE_LENGTH)):
            if not chunk.strip():
                continue
            body: Dict[str, Any] = {"conversationId": conv_id, "conversationType": conv_type, "text": chunk}
            if reply_to and i == 0 and conv_type == "group":
                body["replyTo"] = reply_to
            res = await self._post("/send", body)
            if not res.get("success"):
                return SendResult(success=False, error=str(res.get("error") or "send failed"))
            last_id = res.get("messageId") or last_id
        return SendResult(success=True, message_id=last_id)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        conv_id, conv_type = self._resolve(chat_id, metadata)
        await self._post("/typing", {"conversationId": conv_id, "conversationType": conv_type}, timeout=10)

    async def _send_file(self, chat_id: str, path: str, kind: str, caption: Optional[str],
                         metadata: Optional[Dict[str, Any]], file_name: Optional[str] = None) -> SendResult:
        conv_id, conv_type = self._resolve(chat_id, metadata)
        body = {"conversationId": conv_id, "conversationType": conv_type, "path": str(path), "kind": kind,
                "caption": caption or ""}
        if file_name:
            body["fileName"] = file_name
        res = await self._post("/send-file", body, timeout=300)
        if not res.get("success"):
            return SendResult(success=False, error=str(res.get("error") or "send-file failed"))
        return SendResult(success=True, message_id=res.get("messageId"))

    async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self._send_file(chat_id, image_path, "image", caption, metadata)

    async def send_image(self, chat_id, image_url, caption=None, reply_to=None, metadata=None):
        import aiohttp
        try:
            async with self._session.get(image_url, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                if resp.status == 200:
                    data = await resp.read()
                    ext = "." + (resp.headers.get("Content-Type", "image/jpeg").split("/")[-1].split(";")[0] or "jpg")
                    path = cache_image_from_bytes(data, ext=ext.replace("jpeg", "jpg"))
                    return await self.send_image_file(chat_id, path, caption=caption, metadata=metadata)
        except Exception as e:
            logger.debug("Tammi: send_image download failed: %s", e)
        text = f"{caption}\n{image_url}" if caption else image_url
        return await self.send(chat_id, text, reply_to=reply_to, metadata=metadata)

    async def send_document(self, chat_id, file_path, caption=None, file_name=None, reply_to=None, metadata=None, **kwargs):
        return await self._send_file(chat_id, file_path, "file", caption, metadata, file_name=file_name)

    async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self._send_file(chat_id, video_path, "video", caption, metadata)

    async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self._send_file(chat_id, audio_path, "audio", caption, metadata)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        conv_id, conv_type = self._resolve(chat_id, None)
        return {
            "chat_id": conv_id,
            "name": self._conv_names.get(conv_id, conv_id),
            "type": "group" if conv_type == "group" else "dm",
        }


def check_requirements() -> bool:
    try:
        import aiohttp  # noqa: F401
    except ImportError:
        return False
    return True


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(os.getenv("TAMMI_BRIDGE_URL") or extra.get("bridge_url"))


def _is_connected(config) -> bool:
    return validate_config(config)


def _env_enablement() -> Optional[dict]:
    url = os.getenv("TAMMI_BRIDGE_URL")
    if not url:
        return None
    result: Dict[str, Any] = {"extra": {"bridge_url": url.rstrip("/")}}
    home = os.getenv("TAMMI_HOME_CHANNEL")
    if home:
        conv_id, conv_type = parse_target(home)
        if conv_id:
            result["home_channel"] = {"chat_id": home.strip(), "name": "Home"}
    return result


def _http_json(url: str, token: str, method: str = "GET", timeout: float = 15) -> Optional[Dict[str, Any]]:
    import urllib.request
    req = urllib.request.Request(url, method=method)
    if token:
        req.add_header("x-bridge-token", token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _norm(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFD", str(s or "")).replace("đ", "d").replace("Đ", "D")
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower()


def _pick_ids(items: List[Dict[str, Any]], label: str, prompt_fn, print_fn) -> List[str]:
    print_fn(label)
    print_fn(f"   {len(items)} mục. Gõ tên để tìm, gõ số để chọn (vd 1,3), 'all' để xem hết, Enter trống để xong.")
    selected: Dict[str, str] = {}
    shown = items[:20]

    def render(lst):
        if not lst:
            print_fn("   (không có kết quả)")
        for i, it in enumerate(lst, 1):
            mark = "✓" if it["id"] in selected else " "
            print_fn(f"   [{mark}] {i}. {it.get('name') or '?'}  ({it['id']})")

    render(shown)
    while True:
        raw = (prompt_fn("tìm / số / all / Enter=xong", default="") or "").strip()
        if not raw:
            break
        if raw.lower() == "all":
            shown = items
            render(shown)
            continue
        toks = [t for t in raw.replace(" ", "").split(",") if t]
        if toks and all(t.isdigit() and len(t) <= 4 for t in toks):
            for t in toks:
                idx = int(t) - 1
                if 0 <= idx < len(shown):
                    selected[shown[idx]["id"]] = shown[idx].get("name") or shown[idx]["id"]
            print_fn("   Đã chọn: " + (", ".join(selected.values()) or "(chưa có)"))
            continue
        q = _norm(raw)
        matches = [it for it in items if q in _norm(it.get("name", "")) or q == it["id"].lower()]
        if not matches and len(raw) >= 12:
            selected[raw] = raw
            print_fn("   Đã chọn: " + ", ".join(selected.values()))
            continue
        shown = matches
        render(shown)
    return list(selected.keys())


def _numbered(prompt_fn, print_fn, title: str, options: List[Tuple[str, str]], default: int) -> int:
    print_fn(title)
    for i, (name, desc) in enumerate(options, 1):
        print_fn(f"   {i}. {name} — {desc}")
    while True:
        raw = (prompt_fn(f"Chọn (1-{len(options)})", default=str(default)) or str(default)).strip()
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            print_fn(f"   → {options[int(raw) - 1][0]}")
            return int(raw)
        for i, (name, _) in enumerate(options, 1):
            if raw.lower() == name.lower():
                return i


def _run_cli(bridge_dir: str, *args: str) -> bool:
    node = shutil.which("node")
    if not node:
        return False
    try:
        cli = Path(bridge_dir).parent / "bin" / "cli.mjs"
        return subprocess.run([node, str(cli), *args]).returncode == 0
    except Exception as e:
        logger.warning("Tammi: CLI failed: %s", e)
        return False


def interactive_setup() -> None:
    from hermes_cli.setup import get_env_value, print_header, print_info, print_warning, prompt, prompt_yes_no, save_env_value

    def say(s=""):
        print(s)

    print_header("Tammi")
    print_info("Kết nối Hermes với tài khoản Tammi (tammi.vn) qua bridge Node.js chạy SDK chat của Tammi.")
    print_warning("Đây là API web không chính thức của Tammi — bot trả lời BẰNG CHÍNH TÀI KHOẢN của anh.")

    if not shutil.which("node"):
        print_warning("Chưa có Node.js (>=20). Cài Node trước (vd `brew install node`) rồi chạy lại.")
        return
    bridge_dir = _find_bridge_dir()
    if not bridge_dir:
        print_warning("Không tìm thấy bridge. Cài: `npm install -g hermes-tammi-plugin && hermes-tammi-plugin setup`.")
        return
    print_info(f"Bridge: {bridge_dir}")

    if not (DATA_DIR / "sdk" / "zim-sdk.cjs").exists():
        print_info("Chưa có SDK chat — đang tải từ tammi.vn …")
        _run_cli(bridge_dir, "fetch-sdk")
    if not (DATA_DIR / "credentials.json").exists():
        if prompt_yes_no("Chưa đăng nhập Tammi. Đăng nhập ngay?", True):
            _run_cli(bridge_dir, "login")
    if not (DATA_DIR / "credentials.json").exists():
        print_warning("Chưa có phiên đăng nhập — chạy `hermes-tammi-plugin login` rồi `hermes gateway setup` lại.")
        return

    url = (prompt("Bridge URL", default=get_env_value("TAMMI_BRIDGE_URL") or DEFAULT_BRIDGE_URL) or DEFAULT_BRIDGE_URL).strip().rstrip("/")
    save_env_value("TAMMI_BRIDGE_URL", url)
    autostart = prompt_yes_no("Để gateway tự bật bridge khi chạy `hermes gateway`?", True)
    save_env_value("TAMMI_BRIDGE_AUTOSTART", "true" if autostart else "false")
    token = get_env_value("TAMMI_BRIDGE_TOKEN") or ""

    health = _http_json(f"{url}/health", token, timeout=5)
    if health is None and _is_local_url(url):
        if prompt_yes_no("Bridge chưa chạy. Bật nền ngay để liệt kê cuộc trò chuyện?", True):
            parsed = urlparse(url)
            env = dict(os.environ, TAMMI_BRIDGE_PORT=str(parsed.port or 8788))
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            subprocess.Popen([shutil.which("node"), str(Path(bridge_dir) / "server.js")], cwd=bridge_dir, env=env,
                             stdout=open(DATA_DIR / "bridge.log", "a"), stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
            for _ in range(40):
                time.sleep(1)
                health = _http_json(f"{url}/health", token, timeout=3)
                if health and (health.get("loggedIn") or health.get("sessionDead") or health.get("lastError")):
                    break
    own_id = ((health or {}).get("user") or {}).get("zegoId") or ""
    contacts = None
    convs: List[Dict[str, Any]] = []
    if health and health.get("loggedIn"):
        print_info(f"Bridge OK — đăng nhập: {(health.get('user') or {}).get('name')} ({own_id})")
        contacts = _http_json(f"{url}/contacts", token, timeout=30)
        convs = ((_http_json(f"{url}/conversations?count=200", token, timeout=30) or {}).get("conversations")) or []
    else:
        print_warning(f"Bridge chưa sẵn sàng ({(health or {}).get('lastError') or 'không phản hồi'}) — bỏ qua phần chọn danh bạ.")

    # private chat = a group where the owner is the only member
    allowed: List[str] = []
    self_chat = ""
    candidates = (contacts or {}).get("selfChats") or [c for c in convs if c.get("isDocument")]
    if candidates:
        say()
        say("Kênh chat riêng: anh nhắn vào một nhóm chỉ có mình anh (từ app Tammi trên điện thoại) → Hermes trả lời ở đó.")
        opts = [(c.get("name") if c.get("name") and c.get("name") != c["id"] else f"Nhóm riêng {c['id']}",
                 f"id {c['id']}") for c in candidates]
        opts.append(("không dùng", "bỏ qua kênh chat riêng"))
        cur = get_env_value("TAMMI_SELF_CHAT_ID") or ""
        default = next((i for i, c in enumerate(candidates, 1) if c["id"] == cur), 1)
        pick = _numbered(prompt, say, "Chọn kênh chat riêng với Hermes:", opts, default=default)
        if pick <= len(candidates):
            self_chat = candidates[pick - 1]["id"]
            if own_id:
                allowed.append(own_id)
    save_env_value("TAMMI_SELF_CHAT_ID", self_chat)

    say()
    choice = _numbered(prompt, say, "Ai được nói chuyện với bot?", [
        ("chọn người", "chỉ những người anh chọn; người khác nhắn bot im lặng (khuyên dùng)"),
        ("chỉ mình tôi", "chỉ kênh chat riêng ở trên"),
        ("pairing", "người lạ nhắn sẽ NHẬN MÃ ghép đôi từ tài khoản anh, anh duyệt bằng `hermes pairing approve tammi <mã>`"),
        ("mọi người", "AI trả lời TẤT CẢ ai nhắn tài khoản này (rủi ro)"),
    ], default=1 if not self_chat else 2)
    allow_all = choice == 4
    pairing = choice == 3
    if choice == 1:
        friends = (contacts or {}).get("friends") or [c for c in convs if c.get("type") == "peer" and not c.get("isOA")]
        if friends:
            allowed += _pick_ids([{"id": f["id"], "name": f.get("name")} for f in friends], "Chọn người được dùng bot:", prompt, say)
        else:
            raw = prompt("Nhập zegoId (phẩy ngăn cách)", default=get_env_value("TAMMI_ALLOWED_USERS") or "")
            allowed += _csv(raw)
    save_env_value("TAMMI_ALLOWED_USERS", ",".join(dict.fromkeys(allowed)))
    save_env_value("TAMMI_ALLOW_ALL_USERS", "true" if allow_all else "false")
    save_env_value("TAMMI_PAIRING", "true" if pairing else "false")

    say()
    gm = _numbered(prompt, say, "Trong nhóm, bot trả lời khi nào?", [
        ("mention", "chỉ khi được @nhắc tên hoặc reply tin của anh (khuyên dùng)"),
        ("all", "mọi tin trong nhóm được phép"),
        ("off", "không trả lời trong nhóm"),
    ], default={"mention": 1, "all": 2, "off": 3}.get((get_env_value("TAMMI_GROUP_MODE") or "mention").lower(), 1))
    save_env_value("TAMMI_GROUP_MODE", ["mention", "all", "off"][gm - 1])
    groups = (contacts or {}).get("groups") or [c for c in convs if c.get("type") == "group" and not c.get("isDocument")]
    if gm != 3 and groups and prompt_yes_no("Giới hạn bot trong một số nhóm cụ thể?", False):
        picked = _pick_ids([{"id": g["id"], "name": g.get("name")} for g in groups], "Chọn nhóm:", prompt, say)
        save_env_value("TAMMI_ALLOWED_CONVERSATIONS", ",".join(picked))
    else:
        save_env_value("TAMMI_ALLOWED_CONVERSATIONS", "")

    say()
    default_home = f"group:{self_chat}" if self_chat else (get_env_value("TAMMI_HOME_CHANNEL") or "")
    home = prompt("Home channel cho cron/thông báo (<id> hoặc group:<id>, trống = bỏ qua)", default=default_home)
    save_env_value("TAMMI_HOME_CHANNEL", (home or "").strip())

    say()
    print_info("Xong. Chạy `hermes gateway` — gateway sẽ " + ("tự bật bridge." if autostart else "kết nối bridge đang chạy (`hermes-tammi-plugin start`)."))
    print_info(f"Kiểm tra: curl {url}/health   |   log bridge: {DATA_DIR / 'bridge.log'}")
    print_info("Lưu ý: mở tammi.vn trên trình duyệt có thể đá bridge ra (cùng nền tảng web). Dùng app điện thoại thì không sao.")


def register(ctx):
    ctx.register_platform(
        name="tammi",
        label="Tammi",
        adapter_factory=lambda cfg: TammiAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=_is_connected,
        required_env=["TAMMI_BRIDGE_URL"],
        install_hint="npm install -g hermes-tammi-plugin && hermes-tammi-plugin setup (needs Node.js >= 20 and aiohttp)",
        setup_fn=interactive_setup,
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="TAMMI_HOME_CHANNEL",
        allowed_users_env="TAMMI_ALLOWED_USERS",
        allow_all_env="TAMMI_ALLOW_ALL_USERS",
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="💬",
        pii_safe=False,
        allow_update_command=False,
        platform_hint=(
            "You are chatting via Tammi (Viettel's Vietnamese messenger), replying from the owner's personal "
            "account. Tammi does not render markdown — write plain text only (no **, #, tables or code fences). "
            "Users usually write Vietnamese; reply in Vietnamese unless they switch. Keep replies short and "
            "conversational. You can send images, files, audio and video."
        ),
    )
