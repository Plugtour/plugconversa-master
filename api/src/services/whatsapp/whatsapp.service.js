/* caminho: api/src/services/whatsapp/whatsapp.service.js */

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const P = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

const { pool } = require("../../db");

/* SSE CENTRAL */
const { sseBroadcast } = require("../sse/sse.service");

// sessões em memória por tenant
const sessions = new Map();

function normalizeTenantId(tenantId) {
  const n = Number(tenantId);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function nowIso() {
  return new Date().toISOString();
}

function log(tenantId, ...args) {
  console.log(`[WA][t=${tenantId}][${nowIso()}]`, ...args);
}

function logErr(tenantId, ...args) {
  console.error(`[WA][t=${tenantId}][${nowIso()}][ERR]`, ...args);
}

function getDisconnectStatusCode(lastDisconnect) {
  const code =
    lastDisconnect?.error?.output?.statusCode ??
    lastDisconnect?.error?.data?.statusCode ??
    lastDisconnect?.error?.statusCode ??
    null;

  return Number.isInteger(code) ? code : null;
}

function getDisconnectMessage(lastDisconnect) {
  return (
    lastDisconnect?.error?.message ||
    lastDisconnect?.error?.output?.payload?.message ||
    lastDisconnect?.error?.output?.payload?.error ||
    ""
  );
}

function withTimeout(promise, ms, label = "operation") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label}_TIMEOUT_${ms}ms`);
      err.code = "WA_SEND_TIMEOUT";
      reject(err);
    }, ms);

    Promise.resolve(promise)
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

function unwrapMessageContainer(message) {
  if (!message) return null;

  if (message.ephemeralMessage?.message) {
    return unwrapMessageContainer(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return unwrapMessageContainer(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessageContainer(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessageContainer(message.viewOnceMessageV2Extension.message);
  }

  return message;
}

function extractTextFromMessage(message) {
  const m = unwrapMessageContainer(message);
  if (!m) return null;

  if (m.conversation) return String(m.conversation);

  if (m.extendedTextMessage?.text) return String(m.extendedTextMessage.text);

  if (m.imageMessage?.caption) return String(m.imageMessage.caption);
  if (m.videoMessage?.caption) return String(m.videoMessage.caption);
  if (m.documentMessage?.caption) return String(m.documentMessage.caption);

  if (m.buttonsResponseMessage?.selectedDisplayText)
    return String(m.buttonsResponseMessage.selectedDisplayText);

  if (m.listResponseMessage?.title) return String(m.listResponseMessage.title);
  if (m.templateButtonReplyMessage?.selectedDisplayText)
    return String(m.templateButtonReplyMessage.selectedDisplayText);

  return null;
}

function isPrivateConversationJid(jid) {
  const j = String(jid || "");
  return j.endsWith("@s.whatsapp.net") || j.endsWith("@lid");
}

function extractContactKeyFromJid(jid) {
  const j = String(jid || "").trim();
  if (!j) return "";

  if (j.endsWith("@lid")) {
    return `lid:${j}`;
  }

  if (j.endsWith("@s.whatsapp.net")) {
    const left = j.split("@")[0] || "";
    return left.replace(/\D/g, "");
  }

  return `jid:${j}`;
}

function getSession(tenantId) {
  const t = normalizeTenantId(tenantId);
  if (!t) return null;
  return sessions.get(t) || null;
}

async function sendTextToJid(tenantId, jid, text) {
  const s = getSession(tenantId);

  if (!s?.sock) {
    throw new Error("WHATSAPP_SESSION_NOT_STARTED");
  }

  if (!s.sock.user?.id) {
    throw new Error("WHATSAPP_NOT_CONNECTED");
  }

  let to = String(jid || "").trim();

  if (to && !to.includes("@")) {
    to = `${to.replace(/\D/g, "")}@s.whatsapp.net`;
  }

  if (!isPrivateConversationJid(to)) {
    throw new Error("INVALID_WHATSAPP_JID");
  }

  const timeoutMs = Number(process.env.WA_SEND_TIMEOUT_MS || 12000);

  log(tenantId, "sendTextToJid => enviando", {
    to,
    preview: String(text).slice(0, 60),
    timeoutMs,
  });

  const sent = await withTimeout(
    s.sock.sendMessage(to, { text: String(text) }),
    timeoutMs,
    "SEND_MESSAGE"
  );

  const providerMessageId = sent?.key?.id ? String(sent.key.id) : null;

  log(tenantId, "sendTextToJid => enviado OK", { to, providerMessageId });

  return { ok: true, providerMessageId, jid: to };
}

async function sendText(tenantId, phone, text) {
  const s = getSession(tenantId);

  if (!s?.sock) {
    throw new Error("WHATSAPP_SESSION_NOT_STARTED");
  }

  if (!s.sock.user?.id) {
    throw new Error("WHATSAPP_NOT_CONNECTED");
  }

  const jid = `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`;
  const timeoutMs = Number(process.env.WA_SEND_TIMEOUT_MS || 12000);

  log(tenantId, "sendText => enviando", {
    jid,
    preview: String(text).slice(0, 60),
    timeoutMs,
  });

  const sent = await withTimeout(
    s.sock.sendMessage(jid, { text: String(text) }),
    timeoutMs,
    "SEND_MESSAGE"
  );

  const providerMessageId = sent?.key?.id ? String(sent.key.id) : null;

  log(tenantId, "sendText => enviado OK", { jid, providerMessageId });

  return { ok: true, providerMessageId, jid };
}

/* ---------- INCOMING WHATSAPP ---------- */

async function startSession(tenantId, options = {}) {
  const t = normalizeTenantId(tenantId);
  if (!t) throw new Error("INVALID_TENANT_ID");

  const existing = sessions.get(t);
  if (existing?.sock) return existing;

  const authFolder = path.join(__dirname, "../../../whatsapp", `tenant_${t}`);

  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const logger = P({ level: process.env.WA_LOG_LEVEL || "info" });

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ["PlugConversa", "Chrome", "1.0.0"],
  });

  const entry = { sock };

  sessions.set(t, entry);

  sock.ev.on("messages.upsert", async (payload) => {
    const { messages } = payload || {};
    const msg = messages?.[0];

    if (!msg?.message) return;
    if (msg.key?.fromMe) return;

    const remoteJid = msg.key?.remoteJid || "";

    if (!isPrivateConversationJid(remoteJid)) return;

    const phone = extractContactKeyFromJid(remoteJid);

    const text = extractTextFromMessage(msg.message);

    if (!text) return;

    const pushName = msg?.pushName ? String(msg.pushName).trim() : null;
    const providerMessageId = msg?.key?.id ? String(msg.key.id) : null;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const contactResult = await client.query(
        `
        SELECT id
          FROM contacts
          WHERE tenant_id = $1
            AND (whatsapp_jid = $2 OR phone = $3)
          LIMIT 1`,
        [t, remoteJid, phone]
      );

      let contactId;

      if (contactResult.rowCount === 0) {
        const insert = await client.query(
          `
          INSERT INTO contacts (tenant_id, name, phone, whatsapp_jid)
          VALUES ($1, $2, $3, $4)
          RETURNING id
          `,
          [t, pushName || phone, phone, remoteJid]
        );
        contactId = insert.rows[0].id;
      } else {
        contactId = contactResult.rows[0].id;
      }

      const convUpsert = await client.query(
        `
        INSERT INTO conversations (tenant_id, contact_id, last_message_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (tenant_id, contact_id)
        DO UPDATE SET last_message_at = NOW(),
                      updated_at = NOW()
        RETURNING id
        `,
        [t, contactId]
      );

      const conversationId = convUpsert.rows[0].id;

      const msgInsert = await client.query(
        `
        INSERT INTO messages (
          tenant_id,
          conversation_id,
          direction,
          sender_type,
          provider_message_id,
          content
        )
        VALUES ($1, $2, 'in', 'contact', $3, $4)
        RETURNING id, tenant_id, conversation_id, direction, sender_type, sender_id, provider_message_id, content, created_at
        `,
        [t, conversationId, providerMessageId, String(text)]
      );

      const insertedMessage = msgInsert.rows[0];

      await client.query("COMMIT");

      log(t, "messages.upsert => SALVO NO BANCO", { phone, jid: remoteJid });

      /* ---------- SSE BROADCAST ---------- */

      try {
        sseBroadcast(t, "message", {
          tenant_id: t,
          conversation_id: conversationId,
          message: insertedMessage,
        });
      } catch (e) {
        logErr(t, "SSE_BROADCAST_ERROR", e?.message || e);
      }

    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {}

      logErr(t, "[WHATSAPP_INCOMING_SAVE_ERROR]", err?.message || err);
    } finally {
      client.release();
    }
  });

  return entry;
}

module.exports = {
  startSession,
  getSession,
  sendText,
  sendTextToJid,
};

/* caminho: api/src/services/whatsapp/whatsapp.service.js */