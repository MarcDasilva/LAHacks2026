## Dashboard + Frame Stream

This dashboard now includes a frame-stream camera pipeline:
- `/camera` captures webcam frames and sends them as JPEG frames over WebSocket.
- `/dashboard` receives those frames and renders them in the live camera panel.

### Run

1. Install dependencies:

```bash
npm install
```

2. Start the frame relay server (default port `8787`):

```bash
npm run stream-server
```

3. In another terminal, start Next.js:

```bash
npm run dev
```

4. Open:
- source page: `http://localhost:3000/camera`
- dashboard page: `http://localhost:3000/dashboard`

### Optional config

- `FRAME_STREAM_PORT` controls the relay server port.
- `NEXT_PUBLIC_FRAME_STREAM_WS_URL` overrides the WebSocket URL used by sender/viewer clients.
- `NEXT_PUBLIC_CAMERA_FEED_ROOMS` sets bento feed rooms (comma-separated), for example:
  - `NEXT_PUBLIC_CAMERA_FEED_ROOMS=main-camera,cam-02,cam-03,cam-04`

## Receiving processed points from the GX10

The GX10 runs the lingbot bridge (HTTP ingest on `:8001`, viser streaming
viewer on `:8890`). It only has internet through this Mac's Tailscale relay,
so all browser → GX10 traffic is routed: **browser → ngrok → Mac → Tailscale
→ GX10**.

Two Next.js rewrites in `next.config.ts` handle the Mac→GX10 hop:

- `/bridge/*` → `http://100.85.113.12:8001/*` (LBMP HTTP fetch, sessions API)
- `/viser/*`  → `http://100.85.113.12:8890/*` (viser HTTP + WebSocket)

`dashboard/.env.local` sets `NEXT_PUBLIC_VISER_URL=/viser` and
`NEXT_PUBLIC_USE_VISER=1`, so the dashboard embeds the streaming viewer at
the same origin — one ngrok tunnel covers everything.

### Run order

1. **GX10** (over `tailscale ssh gx10-4f5f` or your usual SSH alias):
   ```bash
   cd ~/LAHacks2026/lingbot_bridge && ./scripts/restart.sh
   ```
   Confirm `:8001` and `:8890` are listening (`ss -tln | grep -E '8001|8890'`).

2. **Mac** — dashboard:
   ```bash
   cd dashboard && npm run dev
   ```

3. **Mac** — public tunnel:
   ```bash
   ngrok start dashboard
   ```
   Share the printed `https://<id>.ngrok-free.app/dashboard` URL.

### Fallback: direct viser tunnel

If viser's WebSocket struggles under the `/viser/` path prefix (some viser
client builds construct absolute WS URLs that bypass the rewrite), expose
viser on its own ngrok tunnel:

```bash
ngrok start --all   # boots both 'dashboard' and 'viser' tunnels
```

Then change `dashboard/.env.local`:
```
NEXT_PUBLIC_VISER_URL=https://<id>-viser.ngrok-free.app
```
The `viser` tunnel in `~/Library/Application Support/ngrok/ngrok.yml`
already points at `100.85.113.12:8890` with `host_header: rewrite`, so this
is a config-only switch.
