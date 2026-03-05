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
  // Boom error pattern: error.output.statusCode
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

/**
 * ✅ Timeout helper (pra API não ficar travada esperando o Baileys)
 */
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

/**
 * Unwrap: algumas mensagens vêm embrulhadas (ephemeral/viewOnce)
 */
function unwrapMessageContainer(message) {
  if (!message) return null;

  // ephemeral
  if (message.ephemeralMessage?.message) {
    return unwrapMessageContainer(message.ephemeralMessage.message);
  }

  // viewOnce (pode ter variações)
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

/**
 * Extrai texto/caption do conteúdo recebido
 */
function extractTextFromMessage(message) {
  const m = unwrapMessageContainer(message);
  if (!m) return null;

  // texto simples
  if (m.conversation) return String(m.conversation);

  // texto estendido
  if (m.extendedTextMessage?.text) return String(m.extendedTextMessage.text);

  // mídia com legenda
  if (m.imageMessage?.caption) return String(m.imageMessage.caption);
  if (m.videoMessage?.caption) return String(m.videoMessage.caption);
  if (m.documentMessage?.caption) return String(m.documentMessage.caption);

  // alguns clientes enviam "buttonsResponseMessage" etc.
  if (m.buttonsResponseMessage?.selectedDisplayText)
    return String(m.buttonsResponseMessage.selectedDisplayText);

  if (m.listResponseMessage?.title) return String(m.listResponseMessage.title);
  if (m.templateButtonReplyMessage?.selectedDisplayText)
    return String(m.templateButtonReplyMessage.selectedDisplayText);

  return null;
}

/**
 * ✅ Identifica se o JID é conversa privada suportada
 * - aceita @s.whatsapp.net (padrão)
 * - aceita @lid (multi-device / LID)
 */
function isPrivateConversationJid(jid) {
  const j = String(jid || "");
  return j.endsWith("@s.whatsapp.net") || j.endsWith("@lid");
}

/**
 * ✅ Extrai um identificador definitivo do contato a partir do JID
 * Regras:
 * - terminar com @lid            -> "lid:<jid>"
 * - terminar com @s.whatsapp.net -> somente dígitos
 * - qualquer outro formato       -> "jid:<jid>"
 */
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

/**
 * Retorna sessão em memória (se existir)
 */
function getSession(tenantId) {
  const t = normalizeTenantId(tenantId);
  if (!t) return null;
  return sessions.get(t) || null;
}

/**
 * ✅ NOVO: envia para um JID já pronto
 * - suporta @lid e @s.whatsapp.net
 * - retorna providerMessageId (quando disponível)
 */
async function sendTextToJid(tenantId, jid, text) {
  const s = getSession(tenantId);

  if (!s?.sock) {
    throw new Error("WHATSAPP_SESSION_NOT_STARTED");
  }

  // garante que a sessão realmente conectou
  if (!s.sock.user?.id) {
    throw new Error("WHATSAPP_NOT_CONNECTED");
  }

  let to = String(jid || "").trim();

  // se vier só número, assume s.whatsapp.net
  if (to && !to.includes("@")) {
    to = `${to.replace(/\D/g, "")}@s.whatsapp.net`;
  }

  // valida mínimo
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

/**
 * Envia texto real via Baileys
 * phone: somente números (ex: 5511999999999)
 * ✅ agora retorna providerMessageId também
 */
async function sendText(tenantId, phone, text) {
  const s = getSession(tenantId);

  if (!s?.sock) {
    throw new Error("WHATSAPP_SESSION_NOT_STARTED");
  }

  // garante que a sessão realmente conectou
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

/**
 * ✅ Gera Pairing Code (conexão via número)
 * phone: "55DDDNUMERO" (somente números ou com máscara)
 *
 * Requisito no celular:
 * WhatsApp > Aparelhos conectados > Conectar com número de telefone
 */
async function requestPairingCode(tenantId, phone) {
  const t = normalizeTenantId(tenantId);
  if (!t) throw new Error("INVALID_TENANT_ID");

  const s = getSession(t);
  if (!s?.sock) throw new Error("WHATSAPP_SESSION_NOT_STARTED");

  // Se já conectou, não faz sentido pedir pairing code
  if (s.sock.user?.id) {
    throw new Error("WHATSAPP_ALREADY_CONNECTED");
  }

  const cleanPhone = String(phone || "").replace(/\D/g, "");
  if (!cleanPhone) {
    throw new Error("PHONE_REQUIRED");
  }

  if (typeof s.sock.requestPairingCode !== "function") {
    throw new Error("PAIRING_NOT_SUPPORTED_BY_BAILEYS");
  }

  log(t, "requestPairingCode => solicitando código para", cleanPhone);

  const code = await s.sock.requestPairingCode(cleanPhone);

  await pool.query(
    `
    UPDATE whatsapp_sessions
    SET status = 'connecting',
        updated_at = NOW()
    WHERE tenant_id = $1
    `,
    [t]
  );

  log(t, "requestPairingCode => código gerado com sucesso");

  return code;
}

/**
 * Start sessão Baileys
 * options:
 * - pairingNumber: string (ex: "55DDDNUMERO") -> tenta gerar código por número (sem QR) e loga no terminal
 */
async function startSession(tenantId, options = {}) {
  const t = normalizeTenantId(tenantId);
  if (!t) throw new Error("INVALID_TENANT_ID");

  // evita duplicar socket
  const existing = sessions.get(t);
  if (existing?.sock) {
    return existing;
  }

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
    printQRInTerminal: String(process.env.WA_PRINT_QR || "0") === "1",
    browser: ["PlugConversa", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (e) {
      logErr(t, "creds.update => falha ao salvar credenciais:", e?.message || e);
    }
  });

  // garante linha no banco
  await pool.query(
    `
    INSERT INTO whatsapp_sessions (tenant_id, provider, status)
    VALUES ($1, 'baileys', 'connecting')
    ON CONFLICT (tenant_id)
    DO UPDATE SET provider='baileys', status='connecting', updated_at=NOW()
    `,
    [t]
  );

  // guarda em memória antes de escutar eventos
  const entry = {
    sock,
    state,
    reconnectTimer: null,
    reconnectAttempts: 0,
    lastDisconnectCode: null,
    lastDisconnectMessage: null,
  };

  sessions.set(t, entry);

  log(t, "startSession => socket criado", { version });

  // pairing code automático (opcional)
  if (options?.pairingNumber) {
    const cleanPhone = String(options.pairingNumber).replace(/\D/g, "");
    if (cleanPhone) {
      setTimeout(async () => {
        try {
          if (typeof sock.requestPairingCode !== "function") {
            log(t, "pairing auto => requestPairingCode não disponível nesta versão");
            return;
          }
          const code = await sock.requestPairingCode(cleanPhone);
          log(t, "PAIRING_CODE_AUTO =>", code);
        } catch (err) {
          logErr(t, "PAIRING_CODE_AUTO_ERROR =>", err?.message || err);
        }
      }, 900);
    }
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect, isNewLogin } = update || {};

    try {
      if (typeof isNewLogin !== "undefined") {
        log(t, "connection.update => isNewLogin:", isNewLogin);
      }
      if (connection) {
        log(t, "connection.update => connection:", connection);
      }

      const code = getDisconnectStatusCode(lastDisconnect);
      const msg = getDisconnectMessage(lastDisconnect);

      if (lastDisconnect?.error) {
        entry.lastDisconnectCode = code;
        entry.lastDisconnectMessage = msg;
        log(t, "lastDisconnect => statusCode:", code, "message:", msg);
      }
    } catch (e) {}

    try {
      // QR novo
      if (qr) {
        log(t, "connection.update => QR recebido/atualizado");
        const qrBase64 = await QRCode.toDataURL(qr);

        await pool.query(
          `
          UPDATE whatsapp_sessions
          SET qr_code = $1,
              status = 'connecting',
              updated_at = NOW()
          WHERE tenant_id = $2
          `,
          [qrBase64, t]
        );
      }

      // conectou
      if (connection === "open") {
        entry.reconnectAttempts = 0;

        await pool.query(
          `
          UPDATE whatsapp_sessions
          SET status = 'connected',
              qr_code = NULL,
              connected_at = NOW(),
              disconnected_at = NULL,
              updated_at = NOW()
          WHERE tenant_id = $1
          `,
          [t]
        );

        log(t, "connected => status atualizado no banco");
        return;
      }

      // caiu
      if (connection === "close") {
        const statusCode = getDisconnectStatusCode(lastDisconnect);

        // loggedOut: não reconecta automaticamente
        const isLoggedOut =
          statusCode === DisconnectReason.loggedOut || statusCode === 401;

        await pool.query(
          `
          UPDATE whatsapp_sessions
          SET status = 'disconnected',
              disconnected_at = NOW(),
              updated_at = NOW()
          WHERE tenant_id = $1
          `,
          [t]
        );

        log(t, "disconnected => status atualizado no banco", {
          statusCode,
          isLoggedOut,
        });

        try {
          if (entry.reconnectTimer) {
            clearTimeout(entry.reconnectTimer);
            entry.reconnectTimer = null;
          }
        } catch (e) {}

        sessions.delete(t);

        if (isLoggedOut) {
          log(t, "loggedOut => não vai reconectar automaticamente (necessário novo pareamento)");
          return;
        }

        const nextAttempts = (entry.reconnectAttempts || 0) + 1;
        const delayMs = Math.min(2000 * nextAttempts, 15000);

        log(t, `reconnect => tentativa #${nextAttempts} em ${delayMs}ms`);

        setTimeout(() => {
          startSession(t)
            .then((newEntry) => {
              if (newEntry) newEntry.reconnectAttempts = nextAttempts;
            })
            .catch((err) => {
              logErr(t, "reconnect => falha ao reiniciar sessão:", err?.message || err);
            });
        }, delayMs);

        return;
      }
    } catch (err) {
      logErr(t, "connection.update handler =>", err?.message || err);
    }
  });

  /**
   * ✅ INCOMING (aceita @s.whatsapp.net e @lid)
   * - salva em contacts/conversations/messages
   * - IMPORTANTe: direction='in' (senão fica 'out' pelo default do banco)
   */
  sock.ev.on("messages.upsert", async (payload) => {
    const { messages, type } = payload || {};
    const msg = messages?.[0];

    // log bruto para saber se chega
    try {
      const remoteJid = msg?.key?.remoteJid;
      const fromMe = msg?.key?.fromMe;
      const pushName = msg?.pushName;
      const messageKeys = msg?.message ? Object.keys(msg.message) : [];
      log(t, "messages.upsert => RECEBIDO", {
        type,
        remoteJid,
        fromMe,
        pushName,
        messageKeys,
      });
    } catch (e) {}

    if (!msg?.message) {
      log(t, "messages.upsert => ignorado: sem msg.message");
      return;
    }

    // ignora mensagens enviadas por nós
    if (msg.key?.fromMe) {
      log(t, "messages.upsert => ignorado: fromMe=true");
      return;
    }

    const remoteJid = msg.key?.remoteJid || "";

    // ignore status broadcast
    if (remoteJid === "status@broadcast") {
      log(t, "messages.upsert => ignorado: status@broadcast");
      return;
    }

    // ✅ aceita @s.whatsapp.net e @lid
    if (!isPrivateConversationJid(remoteJid)) {
      log(t, "messages.upsert => ignorado: não é conversa privada suportada", {
        remoteJid,
      });
      return;
    }

    const phone = extractContactKeyFromJid(remoteJid);

    if (!phone) {
      log(t, "messages.upsert => ignorado: não consegui extrair contactKey do jid", {
        remoteJid,
      });
      return;
    }

    const text = extractTextFromMessage(msg.message);

    if (!text) {
      const keys = Object.keys(unwrapMessageContainer(msg.message) || {});
      log(t, "messages.upsert => sem texto (provável mídia/ação)", { keys });
      return;
    }

    const pushName = msg?.pushName ? String(msg.pushName).trim() : null;
    const providerMessageId = msg?.key?.id ? String(msg.key.id) : null;

    log(t, "messages.upsert => texto extraído", {
      phone,
      text: String(text).slice(0, 80),
      jid: remoteJid,
      pushName,
      providerMessageId,
    });

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 1) contact (usa pushName quando existir)
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

        // atualiza jid sempre que vier mensagem nova
        await client.query(
          `
          UPDATE contacts
          SET whatsapp_jid = $3,
              updated_at = NOW()
          WHERE tenant_id = $1
            AND id = $2
          `,
          [t, contactId, remoteJid]
        );

        // atualiza nome se veio pushName e ainda não temos nome “bom”
        if (pushName) {
          await client.query(
            `
            UPDATE contacts
            SET name = COALESCE(NULLIF(name, ''), $3),
                updated_at = NOW()
            WHERE tenant_id = $1
              AND id = $2
            `,
            [t, contactId, pushName]
          );
        }
      }

      // 2) conversation (sem status / respeita UNIQUE tenant_id+contact_id)
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

      // 3) message (direction='in') + capturar pra SSE
      const inserted = await client.query(
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

      const insertedMessage = inserted.rows[0];

      await client.query("COMMIT");
      log(t, "messages.upsert => SALVO NO BANCO", { phone, jid: remoteJid });

      // ✅ SSE broadcast (mensagem recebida)
      try {
        const map = global.__plugconversa_sse_clients;
        const set = map?.get(t);
        if (set && set.size > 0) {
          const payload = JSON.stringify({
            tenant_id: t,
            conversation_id: conversationId,
            message: insertedMessage,
          });

          for (const res of set) {
            try {
              res.write(`event: message\n`);
              res.write(`data: ${payload}\n\n`);
            } catch (e) {}
          }
        }
      } catch (e) {}
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {}
      logErr(t, "[WHATSAPP_INCOMING_SAVE_ERROR]", err?.message || err);
    } finally {
      client.release();
    }
  });

  log(t, "messages.upsert listener REGISTRADO (diagnóstico)");

  return entry;
}

module.exports = {
  startSession,
  getSession,
  sendText,
  sendTextToJid,
  requestPairingCode,
};

/* caminho: api/src/services/whatsapp/whatsapp.service.js */