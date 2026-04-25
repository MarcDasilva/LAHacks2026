import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.FRAME_STREAM_PORT ?? 8787);
const rooms = new Map();
const frameCounts = new Map();

function log(event, data = {}) {
  const time = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[relay ${time}] ${event}`, data);
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { sender: null, viewers: new Set() };
    rooms.set(roomId, room);
    frameCounts.set(roomId, 0);
    log("room_created", { roomId });
  }
  return room;
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastStreamState(room) {
  const payload = { type: "stream-state", senderOnline: Boolean(room.sender) };
  for (const viewer of room.viewers) {
    sendJson(viewer, payload);
  }
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.sender && room.viewers.size === 0) {
    rooms.delete(roomId);
    frameCounts.delete(roomId);
    log("room_deleted", { roomId });
  }
}

function detachFromCurrentRoom(socket) {
  const { roomId, role } = socket.meta;
  if (!roomId || !role) return;

  const room = rooms.get(roomId);
  if (!room) return;

  if (role === "sender" && room.sender === socket) {
    room.sender = null;
    broadcastStreamState(room);
    log("sender_detached", { roomId, viewers: room.viewers.size });
  }

  if (role === "viewer") {
    room.viewers.delete(socket);
    log("viewer_detached", { roomId, viewers: room.viewers.size });
  }

  cleanupRoom(roomId);
}

const server = http.createServer((_, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Frame stream relay is running.\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.meta = { roomId: null, role: null };
  log("socket_connected");

  socket.on("message", (raw, isBinary) => {
    const { roomId, role } = socket.meta;
    if (isBinary) {
      if (!roomId || role !== "sender") return;
      const room = rooms.get(roomId);
      if (!room) return;

      const nextCount = (frameCounts.get(roomId) ?? 0) + 1;
      frameCounts.set(roomId, nextCount);

      const size = typeof raw === "string" ? raw.length : raw.byteLength;
      if (nextCount === 1 || nextCount % 30 === 0) {
        log("frame_received", {
          roomId,
          frameCount: nextCount,
          frameBytes: size,
          viewers: room.viewers.size,
        });
      }

      let forwarded = 0;
      for (const viewer of room.viewers) {
        if (viewer.readyState === WebSocket.OPEN) {
          viewer.send(raw, { binary: true });
          forwarded += 1;
        }
      }
      if (nextCount === 1 || nextCount % 30 === 0) {
        log("frame_forwarded", { roomId, frameCount: nextCount, forwarded });
      }
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (payload.type !== "join" || !payload.roomId || !payload.role) return;

    const nextRoomId = String(payload.roomId);
    const nextRole = payload.role === "sender" ? "sender" : "viewer";
    log("join_received", { role: nextRole, roomId: nextRoomId });
    detachFromCurrentRoom(socket);
    const room = getRoom(nextRoomId);
    socket.meta = { roomId: nextRoomId, role: nextRole };

    if (nextRole === "sender") {
      if (room.sender && room.sender !== socket) {
        sendJson(room.sender, { type: "sender-replaced" });
        room.sender.close(4001, "Replaced by a new sender");
      }
      room.sender = socket;
      broadcastStreamState(room);
      log("sender_attached", { roomId: nextRoomId, viewers: room.viewers.size });
      sendJson(socket, { type: "joined", role: "sender", roomId: nextRoomId });
    } else {
      room.viewers.add(socket);
      log("viewer_attached", { roomId: nextRoomId, viewers: room.viewers.size, senderOnline: Boolean(room.sender) });
      sendJson(socket, { type: "joined", role: "viewer", roomId: nextRoomId });
      sendJson(socket, { type: "stream-state", senderOnline: Boolean(room.sender) });
    }
  });

  socket.on("close", () => {
    log("socket_closed", { roomId: socket.meta.roomId, role: socket.meta.role });
    detachFromCurrentRoom(socket);
  });
});

server.listen(port, () => {
  log("server_started", { url: `ws://localhost:${port}` });
});
