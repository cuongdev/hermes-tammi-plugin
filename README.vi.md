<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/logo.svg" alt="hermes-tammi-plugin" width="660">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hermes-tammi-plugin"><img src="https://img.shields.io/npm/v/hermes-tammi-plugin.svg" alt="npm version"></a>
  <a href="https://github.com/cuongdev/hermes-tammi-plugin/actions/workflows/ci.yml"><img src="https://github.com/cuongdev/hermes-tammi-plugin/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/semantic-release/semantic-release"><img src="https://img.shields.io/badge/semantic--release-conventionalcommits-e10079" alt="semantic-release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/hermes-tammi-plugin.svg" alt="license"></a>
</p>

📖 [English](./README.md) · **Tiếng Việt**

Dùng [Hermes Agent](https://hermes-agent.nousresearch.com) ngay trong **Tammi** (app nhắn tin của Viettel, tammi.vn).
Bot trả lời bằng chính tài khoản Tammi của bạn.

```
Server Tammi ──ZIM websocket──> Node bridge (bridge/server.js) <──HTTP + SSE──> Adapter Hermes (hermes-plugin/)
```

Chat web của Tammi chạy trên bản ZEGO ZIM riêng của Viettel (`3.2.0.vtt`), giao thức nhị phân có mã hoá, nên
bridge chạy luôn SDK web của Tammi trong Node thay vì viết lại giao thức. SDK không được đóng gói kèm:
`setup` tải tammi.vn và tách SDK ra ngay trên máy bạn.

## Cài đặt

Cần Node.js 20+, Hermes Agent, `aiohttp` trong venv của Hermes. Chạy được trên macOS, Linux, Windows.

<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/setup-flow.svg" alt="Cài đặt 4 bước" width="620">
</p>

### 1. Cài

```bash
npm install -g hermes-tammi-plugin
hermes-tammi-plugin setup
```

`setup` tách SDK chat, đăng nhập (bước 2), cài service chạy nền (launchd / systemd --user / Scheduled Task)
và chép adapter vào `~/.hermes/plugins/tammi`. Chạy lại bao nhiêu lần cũng được.

<img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/cli-setup.svg" alt="hermes-tammi-plugin setup" width="860">

Tuỳ chọn: `--no-service` (không cài service, gateway tự bật bridge), `--no-login`, `--relogin`,
`--refresh-sdk`, `--service-only`, `--hermes-home <path>` (profile Hermes khác, hoặc đặt `HERMES_HOME`).

### 2. Đăng nhập bằng phiên của trình duyệt

tammi.vn chặn gửi OTP bằng Cloudflare captcha, nên bridge dùng lại phiên của trình duyệt bạn đã đăng nhập.

1. Mở [tammi.vn](https://tammi.vn) trên Chrome hoặc Edge, đăng nhập như bình thường (OTP qua SMS, mã QR hoặc mật khẩu).

   <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/tammi-login.png" alt="Trang đăng nhập tammi.vn" width="640">

2. Bấm `F12` (`Cmd+Option+J` trên macOS), mở tab **Console**. Lần đầu Chrome bắt gõ `allow pasting`.
   Sau đó dán lệnh này rồi Enter:

   ```js
   copy(JSON.stringify({token:localStorage.token,refresh_token:localStorage.refresh_token,device_id:localStorage.device_id}))
   ```

   <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/browser-console.svg" alt="DevTools console" width="860">

3. Dán vào dòng `Dán JSON:` của `setup`.
4. Đóng tab. Đừng bấm **Đăng xuất**, sẽ huỷ luôn phiên mà bridge vừa nhận.

Tài khoản có mật khẩu thì dùng: `hermes-tammi-plugin login --password`.

### 3. Thêm Tammi vào Hermes

```bash
hermes gateway setup     # chọn "Tammi"
```

Wizard liệt kê các cuộc trò chuyện để chọn ai được chat với bot, chế độ nhóm, kênh chat riêng và
home channel cho tin cron.

<img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/cli-gateway-setup.svg" alt="hermes gateway setup" width="860">

### 4. Chạy

```bash
hermes gateway
```

Mở nhóm riêng (nhóm chỉ có mình bạn) trên app Tammi ở điện thoại và nhắn cho Hermes ở đó.

<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/tammi-chat.svg" alt="Chat với Hermes trên Tammi (minh hoạ)" width="300">
</p>

## Phiên đăng nhập sống bao lâu

<img src="https://raw.githubusercontent.com/cuongdev/hermes-tammi-plugin/main/assets/cli-status.svg" alt="hermes-tammi-plugin status" width="860">

- Access token sống 15 ngày. Refresh token 90 ngày, và mỗi lần làm mới Tammi cấp refresh token mới.
  Bridge làm mới trước hạn 1 ngày, nên chỉ cần bridge chạy ít nhất một lần trong khoảng 3 tháng là không
  bao giờ phải đăng nhập lại. Token chat ZEGO (24 giờ) cũng tự gia hạn.
- Mất mạng hoặc Tammi trả lỗi 5xx thì thử lại mỗi 5 phút; chỉ khi refresh token bị từ chối mới coi là hết phiên.
- CLI và bridge dùng chung `credentials.json` có khoá file, nên chạy `login` hay `status` lúc bridge
  đang chạy không làm hỏng token của bridge.
- Nếu phiên thật sự hết (đăng xuất ở thiết bị khác, refresh token bị thu hồi): gateway báo Tammi lỗi và tự
  thử kết nối lại. Chạy `hermes-tammi-plugin login --force` là nó tự kết nối lại.
- Bridge chết thì service của hệ điều hành bật lại; không cài service thì gateway tự bật bridge mới.

## Cách bot hoạt động

- Tin bạn tự gửi bị bỏ qua, trừ trong kênh chat riêng đã chọn lúc setup.
- Người không có trong `TAMMI_ALLOWED_USERS` nhắn thì bot im lặng (trừ khi chọn pairing hoặc mọi người).
- Nhóm (`TAMMI_GROUP_MODE=mention`, mặc định): chỉ trả lời khi bạn bị @nhắc tên hoặc có người reply tin của bạn.
- Bỏ qua: tin offline cũ, tin cũ hơn 10 phút, tài khoản OA (`@RBT#OA_…`, bot `Tammi`).
- Nhận chữ, ảnh, file, ghi âm, video, album, danh thiếp. Gửi chữ (tự chia ở 4.8 KB), ảnh, file,
  âm thanh, video và trạng thái "đang nhập".
- Mở tammi.vn trên trình duyệt cùng tài khoản có thể đá bridge ra (cùng là client web). App điện thoại
  thì không sao. Khôi phục: `curl -X POST http://127.0.0.1:8788/relogin`.

## Cấu hình

`hermes gateway setup` ghi vào `~/.hermes/.env`.

| Biến | Mặc định | |
|---|---|---|
| `TAMMI_BRIDGE_URL` | `http://127.0.0.1:8788` | Địa chỉ bridge, bật platform |
| `TAMMI_BRIDGE_AUTOSTART` | `true` | Gateway tự bật bridge nếu chưa chạy |
| `TAMMI_ALLOWED_USERS` | | zegoId được chat với bot |
| `TAMMI_ALLOW_ALL_USERS` / `TAMMI_PAIRING` | `false` | Mọi người / gửi mã ghép đôi cho người lạ |
| `TAMMI_SELF_CHAT_ID` | | Nhóm riêng: tin của bạn ở đây được gửi cho Hermes |
| `TAMMI_GROUP_MODE` | `mention` | `mention`, `all` hoặc `off` |
| `TAMMI_ALLOWED_CONVERSATIONS` | | Chỉ hoạt động trong các cuộc trò chuyện này |
| `TAMMI_HOME_CHANNEL` | | Đích cho cron: `<id>` hoặc `group:<id>` |
| `TAMMI_BRIDGE_TOKEN` | | Mã bí mật gửi qua header `x-bridge-token` |
| `TAMMI_LOG_IDS` | `false` | Ghi log id người gửi và cuộc trò chuyện |

Dữ liệu bridge: `~/.hermes-tammi/` (`credentials.json` quyền 600, `sdk/`, `bridge.log`), đổi bằng `TAMMI_DATA_DIR`.

## CLI

```
hermes-tammi-plugin setup       SDK, đăng nhập, service, adapter Hermes
hermes-tammi-plugin login       --import | --password | --otp, --force để thay phiên
hermes-tammi-plugin logout      huỷ và xoá phiên
hermes-tammi-plugin start       chạy bridge ở foreground
hermes-tammi-plugin stop        gỡ service chạy nền
hermes-tammi-plugin status      SDK, token, bridge, plugin
hermes-tammi-plugin fetch-sdk   tách lại SDK (--har file.har để dùng file HAR)
hermes-tammi-plugin uninstall   gỡ service và adapter, --purge xoá luôn ~/.hermes-tammi
```

## API của bridge

`GET /health` · `GET /events` (SSE `message`, `status`, `session_dead`, hỗ trợ `Last-Event-ID`) ·
`POST /send {conversationId, conversationType?, text, replyTo?}` · `POST /send-file {conversationId, path, kind?, caption?}` ·
`POST /typing` · `POST /read` · `GET /conversations` · `GET /contacts` · `POST /relogin` · `POST /shutdown`.

## Phát triển

```bash
npm install
npm test                                                     # bridge
~/.hermes/hermes-agent/venv/bin/python -m pytest tests/ -q   # adapter
python3 assets/src/render.py                                 # dựng lại ảnh terminal
```

Commit theo [Conventional Commits](https://www.conventionalcommits.org) (commitlint kiểm tra).
semantic-release tự ra bản từ `main`: `fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major.

## Lưu ý

Tích hợp không chính thức, dựng từ web client tammi.vn. Viettel có thể đổi bất cứ lúc nào; chạy
`hermes-tammi-plugin fetch-sdk` khi web Tammi cập nhật. Tin trả lời được gửi từ tài khoản thật của bạn.

## License

MIT
