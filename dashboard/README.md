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
