'use strict';
/**
 * broadcast/ws.js — WebSocket 房间管理
 * 支持按 sessionId 和 subscriptionId 分组广播
 */

const WebSocket = require('ws');

let _wss = null;

// sessionId → Set<WebSocket>
const wsRooms = new Map();

function init(wss) { _wss = wss; }

function joinRoom(sessionId, ws) {
  if (!wsRooms.has(sessionId)) wsRooms.set(sessionId, new Set());
  wsRooms.get(sessionId).add(ws);
}

function leaveRoom(sessionId, ws) {
  wsRooms.get(sessionId)?.delete(ws);
  if (wsRooms.get(sessionId)?.size === 0) wsRooms.delete(sessionId);
}

/** 广播到某个 session 房间（订阅了该 sessionId 的客户端）*/
function broadcast(sessionId, data) {
  const room = wsRooms.get(sessionId);
  if (!room) return;
  const msg = JSON.stringify(data);
  room.forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(msg));
}

/** 广播到所有已连接客户端（用于刷新访客列表）*/
function broadcastAll(data) {
  if (!_wss) return;
  const msg = JSON.stringify(data);
  _wss.clients.forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(msg));
}

/** 广播到某个 subscription 下所有客户端（通过 ws.subscriptionId 标记）*/
function broadcastToSub(subscriptionId, data) {
  if (!_wss) return;
  const msg = JSON.stringify(data);
  _wss.clients.forEach(ws => {
    if (ws.subscriptionId === subscriptionId && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

module.exports = { init, joinRoom, leaveRoom, broadcast, broadcastAll, broadcastToSub };
