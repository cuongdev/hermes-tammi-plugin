<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/logo.svg" alt="hermes-tammi-plugin" width="660">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hermes-tammi-plugin"><img src="https://img.shields.io/npm/v/hermes-tammi-plugin.svg" alt="npm version"></a>
  <a href="https://github.com/cuongdev/hermes-tammi-plugin/actions/workflows/ci.yml"><img src="https://github.com/cuongdev/hermes-tammi-plugin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/semantic-release/semantic-release"><img src="https://img.shields.io/badge/semantic--release-conventionalcommits-e10079" alt="semantic-release"></a>
  <a href="https://github.com/cuongdev/hermes-tammi-plugin/stargazers"><img src="https://img.shields.io/github/stars/cuongdev/hermes-tammi-plugin?style=social" alt="GitHub stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/hermes-tammi-plugin.svg" alt="license"></a>
</p>

📖 **English** · [Tiếng Việt](./README.vi.md)

Use your [Hermes Agent](https://hermes-agent.nousresearch.com) from **Tammi**, Viettel's messenger (tammi.vn).
The agent replies from your own Tammi account.

```
Tammi servers ──ZIM websocket──> Node bridge (bridge/server.js) <──HTTP + SSE──> Hermes adapter (hermes-plugin/)
```

Tammi's web chat runs on a Viettel build of ZEGO ZIM (`3.2.0.vtt`) with an encrypted binary protocol, so the
bridge loads Tammi's own web SDK in Node instead of reimplementing it. The SDK isn't redistributed here:
`setup` downloads tammi.vn and extracts it on your machine.

## Setup

Requirements: Node.js 20+, Hermes Agent, `aiohttp` in the Hermes venv. Works on macOS, Linux and Windows.

<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/setup-flow.svg" alt="Setup in 4 steps" width="620">
</p>

### 1. Install

```bash
npm install -g hermes-tammi-plugin
hermes-tammi-plugin setup
```

`setup` extracts the chat SDK, logs you in (step 2), registers a background service
(launchd / systemd --user / Scheduled Task) and installs the adapter into `~/.hermes/plugins/tammi`.
Re-running it is safe.

<img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/cli-setup.svg" alt="hermes-tammi-plugin setup" width="860">

Options: `--no-service` (no OS service, the gateway starts the bridge itself), `--no-login`, `--relogin`,
`--refresh-sdk`, `--service-only`, `--hermes-home <path>` (other Hermes profile, `HERMES_HOME` works too).

### 2. Log in with your browser session

tammi.vn protects the OTP SMS with a Cloudflare captcha, so the bridge reuses the session of a browser
you are logged in with.

1. Open [tammi.vn](https://tammi.vn) in Chrome or Edge and log in as usual (OTP by SMS, QR or password).

   <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/tammi-login.png" alt="tammi.vn login page" width="640">

2. Press `F12` (`Cmd+Option+J` on macOS), open **Console**. Chrome asks you to type `allow pasting`
   the first time. Then paste this and press Enter:

   ```js
   copy(JSON.stringify({token:localStorage.token,refresh_token:localStorage.refresh_token,device_id:localStorage.device_id}))
   ```

   <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/browser-console.svg" alt="DevTools console" width="860">

3. Paste the clipboard into the `Dán JSON:` prompt of `setup`.
4. Close the tab. Don't click **Đăng xuất** (log out), that revokes the session the bridge just took over.

If your account has a password: `hermes-tammi-plugin login --password`.

### 3. Register Tammi in Hermes

```bash
hermes gateway setup     # pick "Tammi"
```

The wizard lists your chats so you can pick who may talk to the bot, the group mode, your private
chat and the home channel for cron messages.

<img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/cli-gateway-setup.svg" alt="hermes gateway setup" width="860">

### 4. Run

```bash
hermes gateway
```

Open your private group (a group with only you in it) in the Tammi phone app and write to Hermes there.

<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/tammi-chat.svg" alt="Chatting with Hermes from Tammi (illustration)" width="300">
</p>

## Login lifetime

<img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/cli-status.svg" alt="hermes-tammi-plugin status" width="860">

- Access token: 15 days. Refresh token: 90 days, and Tammi issues a new one on every refresh.
  The bridge refreshes a day before expiry, so as long as it runs at least once every ~3 months
  you never log in again. The 24h ZEGO chat token is renewed in the background too.
- Network errors and Tammi 5xx responses are retried (every 5 minutes); only a rejected refresh token ends the session.
- The CLI and the bridge share `credentials.json` with a file lock, so running `login` or `status`
  while the bridge is up can't invalidate its token.
- If the session does end (logged out from another device, refresh token revoked): the gateway marks Tammi
  as down and keeps retrying. Run `hermes-tammi-plugin login --force` and it reconnects by itself.
- If the bridge process dies, the OS service restarts it; without a service the gateway starts a new one.

## Behaviour

- Your own messages are ignored except in the private chat chosen during setup.
- People not in `TAMMI_ALLOWED_USERS` get no reply (unless you choose pairing or everyone).
- Groups (`TAMMI_GROUP_MODE=mention`, default): replies when you're @mentioned or someone replies to your message.
- Skipped: offline backlog, messages older than 10 minutes, official accounts (`@RBT#OA_…`, the `Tammi` bot).
- Receives text, images, files, voice, video, albums and contact cards. Sends text (split at 4.8 KB),
  images, files, audio, video and the typing indicator.
- Opening tammi.vn in a browser with the same account can kick the bridge (both are "web" clients).
  The phone app is fine. Recover with `curl -X POST http://127.0.0.1:8788/relogin`.

## Configuration

Written to `~/.hermes/.env` by `hermes gateway setup`.

| Variable | Default | |
|---|---|---|
| `TAMMI_BRIDGE_URL` | `http://127.0.0.1:8788` | Bridge address, enables the platform |
| `TAMMI_BRIDGE_AUTOSTART` | `true` | Gateway starts the bridge when it isn't running |
| `TAMMI_ALLOWED_USERS` | | zegoIds allowed to talk to the bot |
| `TAMMI_ALLOW_ALL_USERS` / `TAMMI_PAIRING` | `false` | Everyone / pairing codes for strangers |
| `TAMMI_SELF_CHAT_ID` | | Private group where your own messages go to Hermes |
| `TAMMI_GROUP_MODE` | `mention` | `mention`, `all` or `off` |
| `TAMMI_ALLOWED_CONVERSATIONS` | | Only these conversations |
| `TAMMI_HOME_CHANNEL` | | Cron target: `<id>` or `group:<id>` |
| `TAMMI_BRIDGE_TOKEN` | | Shared secret sent as `x-bridge-token` |
| `TAMMI_LOG_IDS` | `false` | Log sender and conversation ids |

Bridge data: `~/.hermes-tammi/` (`credentials.json` mode 600, `sdk/`, `bridge.log`), override with `TAMMI_DATA_DIR`.

## CLI

```
hermes-tammi-plugin setup       SDK, login, service, Hermes adapter
hermes-tammi-plugin login       --import | --password | --otp, --force to replace the session
hermes-tammi-plugin logout      revoke and delete the session
hermes-tammi-plugin start       run the bridge in the foreground
hermes-tammi-plugin stop        remove the background service
hermes-tammi-plugin status      SDK, tokens, bridge and plugin state
hermes-tammi-plugin fetch-sdk   re-extract the SDK (--har file.har to use a HAR export)
hermes-tammi-plugin uninstall   remove service and adapter, --purge also deletes ~/.hermes-tammi
```

## Bridge API

`GET /health` · `GET /events` (SSE `message`, `status`, `session_dead`, supports `Last-Event-ID`) ·
`POST /send {conversationId, conversationType?, text, replyTo?}` · `POST /send-file {conversationId, path, kind?, caption?}` ·
`POST /typing` · `POST /read` · `GET /conversations` · `GET /contacts` · `POST /relogin` · `POST /shutdown`.

## Development

```bash
npm install
npm test                                                     # bridge
~/.hermes/hermes-agent/venv/bin/python -m pytest tests/ -q   # adapter
python3 assets/src/render.py                                 # rebuild the terminal screenshots
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org) (checked by commitlint).
Releases are cut by semantic-release from `main`: `fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major.

## Caveats

Unofficial, built from the tammi.vn web client. Viettel can change it at any time; run
`hermes-tammi-plugin fetch-sdk` after a Tammi web update. Replies are sent from your real account.

## Star History

If this is useful to you, a ⭐ helps other people find it.
[Star history chart](https://star-history.com/#cuongdev/hermes-tammi-plugin&Date)

## License

MIT
