// src/services/sse/sse.service.js

const clients = new Map();

function sseAddClient(tenantId, res) {
  if (!clients.has(tenantId)) {
    clients.set(tenantId, new Set());
  }

  const set = clients.get(tenantId);
  set.add(res);
}

function sseRemoveClient(tenantId, res) {
  const set = clients.get(tenantId);
  if (!set) return;

  set.delete(res);

  if (set.size === 0) {
    clients.delete(tenantId);
  }
}

function sseBroadcast(tenantId, eventName, payload) {
  const set = clients.get(tenantId);

  if (!set || set.size === 0) {
    return;
  }

  const data = JSON.stringify(payload);

  for (const res of set) {
    try {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${data}\n\n`);
    } catch (err) {
      // ignora erro de conexão fechada
    }
  }
}

module.exports = {
  sseAddClient,
  sseRemoveClient,
  sseBroadcast,
};