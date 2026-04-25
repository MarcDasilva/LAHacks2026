import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.FRAME_STREAM_PORT ?? 8787);
const host = process.env.FRAME_STREAM_HOST ?? "0.0.0.0";
const maxViewerBufferBytes = Number(process.env.FRAME_STREAM_MAX_VIEWER_BUFFER_BYTES ?? 512 * 1024);
const rooms = new Map();
let nextSocketId = 1;

function log(event, data = {}) {
  const time = new Date().toISOString();
  console.log(`[signal ${time}] ${event}`, data);
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      sender: null,
      viewers: new Set(),
      frameCount: 0,
      lastFrameAt: null,
      lastFrameBytes: 0,
      updatedAt: new Date().toISOString(),
    };
    rooms.set(roomId, room);
    log("room_created", { roomId });
  }
  return room;
}

function roomSnapshot(roomId, room) {
  return {
    roomId,
    senderOnline: Boolean(room.sender),
    senderId: room.sender?.id ?? null,
    viewerCount: room.viewers.size,
    frameCount: room.frameCount,
    lastFrameAt: room.lastFrameAt,
    lastFrameBytes: room.lastFrameBytes,
    updatedAt: room.updatedAt,
  };
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastStreamState(room) {
  const payload = {
    type: "stream-state",
    senderOnline: Boolean(room.sender),
    senderId: room.sender?.id ?? null,
  };
  for (const viewer of room.viewers) {
    sendJson(viewer, payload);
  }
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.sender && room.viewers.size === 0) {
    rooms.delete(roomId);
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
    log("sender_detached", { roomId, viewers: room.viewers.size });
    broadcastStreamState(room);
  }

  if (role === "viewer") {
    room.viewers.delete(socket);
    if (room.sender) {
      sendJson(room.sender, { type: "viewer-left", viewerId: socket.id });
    }
    log("viewer_detached", { roomId, viewers: room.viewers.size });
  }

  cleanupRoom(roomId);
}

function isInSameRoom(source, target) {
  return Boolean(source.meta.roomId && source.meta.roomId === target.meta.roomId);
}

function findSocketById(room, socketId) {
  if (room.sender && room.sender.id === socketId) return room.sender;
  for (const viewer of room.viewers) {
    if (viewer.id === socketId) return viewer;
  }
  return null;
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/rooms") {
    const payload = Array.from(rooms.entries()).map(([roomId, room]) => roomSnapshot(roomId, room));
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ rooms: payload }));
    return;
  }

  res.writeHead(200, { "content-type": "text/plain" });
  res.end("WebRTC signaling server is running.\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.id = `peer-${nextSocketId++}`;
  socket.meta = { roomId: null, role: null };
  log("socket_connected", { socketId: socket.id });

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      const { roomId, role } = socket.meta;
      if (!roomId || role !== "sender") return;
      const room = rooms.get(roomId);
      if (!room) return;

      room.frameCount += 1;
      room.lastFrameAt = new Date().toISOString();
      room.lastFrameBytes = raw.length;
      room.updatedAt = room.lastFrameAt;

      for (const viewer of room.viewers) {
        if (viewer.readyState === WebSocket.OPEN) {
          if (viewer.bufferedAmount > maxViewerBufferBytes) continue;
          viewer.send(raw, { binary: true });
        }
      }
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (payload.type === "join" && payload.roomId && payload.role) {
      const nextRoomId = String(payload.roomId);
      const nextRole = payload.role === "sender" ? "sender" : "viewer";

      log("join_received", { socketId: socket.id, role: nextRole, roomId: nextRoomId });
      detachFromCurrentRoom(socket);

      const room = getRoom(nextRoomId);
      socket.meta = { roomId: nextRoomId, role: nextRole };

      if (nextRole === "sender") {
        if (room.sender && room.sender !== socket) {
          sendJson(room.sender, { type: "sender-replaced" });
          room.sender.close(4001, "Replaced by a new sender");
        }
        room.sender = socket;
        room.updatedAt = new Date().toISOString();
        sendJson(socket, { type: "joined", role: "sender", roomId: nextRoomId, socketId: socket.id });
        for (const viewer of room.viewers) {
          sendJson(socket, { type: "viewer-joined", viewerId: viewer.id });
        }
        broadcastStreamState(room);
        log("sender_attached", { socketId: socket.id, roomId: nextRoomId, viewers: room.viewers.size });
        return;
      }

      room.viewers.add(socket);
      room.updatedAt = new Date().toISOString();
      sendJson(socket, { type: "joined", role: "viewer", roomId: nextRoomId, socketId: socket.id });
      sendJson(socket, { type: "stream-state", senderOnline: Boolean(room.sender), senderId: room.sender?.id ?? null });
      if (room.sender) {
        sendJson(room.sender, { type: "viewer-joined", viewerId: socket.id });
      }
      log("viewer_attached", { socketId: socket.id, roomId: nextRoomId, viewers: room.viewers.size });
      return;
    }

    if (payload.type === "signal" && payload.targetId && payload.data) {
      const { roomId } = socket.meta;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      const target = findSocketById(room, String(payload.targetId));
      if (!target) return;
      if (!isInSameRoom(socket, target)) return;

      sendJson(target, {
        type: "signal",
        fromId: socket.id,
        data: payload.data,
      });
      return;
    }
  });

  socket.on("close", () => {
    log("socket_closed", { socketId: socket.id, roomId: socket.meta.roomId, role: socket.meta.role });
    detachFromCurrentRoom(socket);
  });
});

server.listen(port, host, () => {
  log("server_started", { url: `ws://${host}:${port}` });
});
