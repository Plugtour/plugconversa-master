/* caminho: api/src/services/sse/sse.service.js */

const clients = new Map();

function normalizeTenantKey(tenantId) {
  const n = Number(tenantId);
  if (Number.isInteger(n) && n > 0) {
    return String(n);
  }
  return String(tenantId || "");
}

function sseAddClient(tenantId, res) {
  const key = normalizeTenantKey(tenantId);

  if (!clients.has(key)) {
    clients.set(key, new Set());
  }

  const set = clients.get(key);
  set.add(res);
}

function sseRemoveClient(tenantId, res) {
  const key = normalizeTenantKey(tenantId);

  const set = clients.get(key);
  if (!set) return;

  set.delete(res);

  if (set.size === 0) {
    clients.delete(key);
  }
}

function sseBroadcast(tenantId, eventName, payload) {
  const key = normalizeTenantKey(tenantId);

  const set = clients.get(key);

  if (!set || set.size === 0) {
    return;
  }

  const data = JSON.stringify(payload ?? {});

  for (const res of set) {
    try {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${data}\n\n`);
    } catch (err) {
      try {
        set.delete(res);
      } catch (_) {}
    }
  }
}

module.exports = {
  sseAddClient,
  sseRemoveClient,
  sseBroadcast,
};

/* caminho: api/src/services/sse/sse.service.js */