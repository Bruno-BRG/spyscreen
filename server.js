'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// ---- Config ICE (STUN / TURN) via ENV ----
function getIceServers() {
  const servers = [];
  const stun = process.env.STUN_URL || 'stun:stun.l.google.com:19302';
  if (stun) servers.push({ urls: stun });

  const turnUrl = process.env.TURN_URL || '';
  const turnUser = process.env.TURN_USERNAME || process.env.TURN_USER || '';
  const turnPass = process.env.TURN_PASSWORD || process.env.TURN_PASS || '';
  if (turnUrl && turnUser && turnPass) {
    servers.push({ urls: turnUrl, username: turnUser, credential: turnPass });
  }
  return servers;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, ts: Date.now() });
});

app.get('/api/config', (_req, res) => {
  res.json({ iceServers: getIceServers() });
});

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Fallback: /s/:code -> sala.html?codigo=code (link curto de convite)
app.get('/s/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  res.redirect(302, `/sala.html?codigo=${encodeURIComponent(code)}`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

// rooms: Map<code, Map<clientId, { ws, name, joinedAt }>>
const rooms = new Map();
// ws -> { id, name, code }
const clients = new Map();

function sanitizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}
function sanitizeName(raw) {
  return String(raw || '').trim().slice(0, 30) || 'Convidado';
}
function sanitizeText(raw) {
  return String(raw || '').slice(0, 500);
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function peersOf(code, exceptId) {
  const room = rooms.get(code);
  if (!room) return [];
  const out = [];
  for (const [id, c] of room.entries()) {
    if (id !== exceptId) out.push({ id, name: c.name });
  }
  return out;
}

function broadcast(code, obj, exceptId) {
  const room = rooms.get(code);
  if (!room) return;
  const msg = JSON.stringify(obj);
  for (const [id, c] of room.entries()) {
    if (id === exceptId) continue;
    if (c.ws.readyState === 1) {
      try { c.ws.send(msg); } catch { /* ignore */ }
    }
  }
}

function leaveRoom(ws) {
  const info = clients.get(ws);
  if (!info || !info.code) return;
  const { code, id, name } = info;
  const room = rooms.get(code);
  if (room) {
    room.delete(id);
    broadcast(code, { type: 'peer-left', id, name }, id);
    broadcast(code, { type: 'room-info', count: room.size }, null);
    if (room.size === 0) rooms.delete(code);
  }
  clients.delete(ws);
}

// anti-spam simples de chat: max 5 msg / 5s por socket
const chatTimestamps = new Map();
function chatAllowed(ws) {
  const now = Date.now();
  const arr = (chatTimestamps.get(ws) || []).filter((t) => now - t < 5000);
  if (arr.length >= 5) return false;
  arr.push(now);
  chatTimestamps.set(ws, arr);
  return true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    const type = msg.type;

    if (type === 'join') {
      const code = sanitizeCode(msg.code);
      const name = sanitizeName(msg.name);
      const id = String(msg.id || '').slice(0, 64);
      if (!code || code.length < 4) return send(ws, { type: 'error', message: 'Código de sala inválido.' });
      if (!id) return send(ws, { type: 'error', message: 'ID inválido. Recarregue a página.' });

      // sai da sala anterior se trocou
      if (clients.has(ws)) leaveRoom(ws);

      let room = rooms.get(code);
      if (!room) {
        room = new Map();
        rooms.set(code, room);
      }
      // mesmo id reconectando: derruba sessão antiga
      const old = room.get(id);
      if (old && old.ws !== ws && old.ws.readyState === 1) {
        try { old.ws.close(4000, 'replaced'); } catch { /* ignore */ }
      }
      room.set(id, { ws, name, joinedAt: Date.now() });
      clients.set(ws, { id, name, code });

      const peers = peersOf(code, id);
      send(ws, { type: 'joined', id, code, peers, count: room.size, iceServers: getIceServers() });
      broadcast(code, { type: 'peer-joined', id, name }, id);
      broadcast(code, { type: 'room-info', count: room.size }, null);
      return;
    }

    const info = clients.get(ws);
    if (!info || !info.code) return; // precisa dar join antes
    const { code, id: from, name: fromName } = info;

    if (type === 'offer' || type === 'answer' || type === 'ice') {
      const to = String(msg.to || '').slice(0, 64);
      const room = rooms.get(code);
      const target = room && room.get(to);
      if (!target) return;
      if (type === 'ice') {
        send(target.ws, { type: 'ice', from, candidate: msg.candidate || null });
      } else {
        if (!msg.sdp || typeof msg.sdp !== 'object') return;
        send(target.ws, { type, from, fromName, sdp: msg.sdp });
      }
      return;
    }

    if (type === 'chat') {
      if (!chatAllowed(ws)) return send(ws, { type: 'error', message: 'Calma! Você está enviando mensagens rápido demais.' });
      const text = sanitizeText(msg.text).trim();
      if (!text) return;
      const payload = { type: 'chat', from, name: fromName, text, ts: Date.now() };
      broadcast(code, payload, null);
      return;
    }

    if (type === 'share-state') {
      broadcast(code, { type: 'share-state', from, sharing: !!msg.sharing }, from);
      return;
    }

    if (type === 'ping') {
      return send(ws, { type: 'pong', ts: Date.now() });
    }
  });

  ws.on('close', () => {
    chatTimestamps.delete(ws);
    leaveRoom(ws);
  });
  ws.on('error', () => { /* ignore */ });
});

// heartbeat: derruba socket morto
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* ignore */ }
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[screenshare] rodando na porta ${PORT}`);
});
