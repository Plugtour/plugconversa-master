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

function isSupportedIncomingChatJid(jid) {
  if (!jid) return false;

  // ignora broadcasts / status / newsletter / grupos
  if (jid === "status@broadcast") return false;
  if (jid.endsWith("@broadcast")) return false;
  if (jid.endsWith("@g.us")) return false;
  if (jid.endsWith("@newsletter")) return false;

  // aceita usuários "normais" e LID
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

function extractContactKeyFromJid(jid) {
  // remove sufixo e mantém apenas dígitos (se houver)
  const raw = String(jid)
    .replace("@s.whatsapp.net", "")
    .replace("@lid", "")
    .trim();

  const digits = raw.replace(/\D/g, "");
  return digits || raw;
}

function extractTextFromMessage(message) {
  if (!message) return null;

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    null
  );
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
 * Envia texto real via Baileys
 * phone: somente números (ex: 5511999999999)
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
  await s.sock.sendMessage(jid, { text: String(text) });

  return true;
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
    // ajuda a reduzir ruído / problemas de preview
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
      // log leve, sem spam
      // log(t, "creds.update => credenciais salvas");
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

    // log diagnóstico (sem esconder erro)
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
    } catch (e) {
      // não deixa quebrar o handler
    }

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

        // limpa sessão atual
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

        // reconexão com backoff simples
        const nextAttempts = (entry.reconnectAttempts || 0) + 1;
        const delayMs = Math.min(2000 * nextAttempts, 15000);

        log(t, `reconnect => tentativa #${nextAttempts} em ${delayMs}ms`);

        const timer = setTimeout(() => {
          startSession(t)
            .then((newEntry) => {
              if (newEntry) newEntry.reconnectAttempts = nextAttempts;
            })
            .catch((err) => {
              logErr(t, "reconnect => falha ao reiniciar sessão:", err?.message || err);
            });
        }, delayMs);

        // não temos mais "entry" no map (foi delete), mas mantemos timer local
        // se quiser observar isso no futuro, dá pra persistir em memória por outro map
        return;
      }
    } catch (err) {
      logErr(t, "connection.update handler =>", err?.message || err);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message) return;

    // ignorar mensagens enviadas por nós
    if (msg.key?.fromMe) return;

    const remoteJid = msg.key?.remoteJid || "";
    if (!isSupportedIncomingChatJid(remoteJid)) return;

    const contactKey = extractContactKeyFromJid(remoteJid);
    const text = extractTextFromMessage(msg.message);

    if (!text) return;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const contactResult = await client.query(
        `
        SELECT id
        FROM contacts
        WHERE tenant_id = $1
          AND phone = $2
        LIMIT 1
        `,
        [t, contactKey]
      );

      let contactId;

      if (contactResult.rowCount === 0) {
        const insert = await client.query(
          `
          INSERT INTO contacts (tenant_id, name, phone)
          VALUES ($1, $2, $3)
          RETURNING id
          `,
          [t, contactKey, contactKey]
        );
        contactId = insert.rows[0].id;
      } else {
        contactId = contactResult.rows[0].id;
      }

      const convResult = await client.query(
        `
        SELECT id
        FROM conversations
        WHERE tenant_id = $1
          AND contact_id = $2
          AND status = 'open'
        ORDER BY last_message_at DESC NULLS LAST, id DESC
        LIMIT 1
        `,
        [t, contactId]
      );

      let conversationId;

      if (convResult.rowCount === 0) {
        const insertConv = await client.query(
          `
          INSERT INTO conversations (
            tenant_id,
            contact_id,
            status,
            last_message_at
          )
          VALUES ($1, $2, 'open', NOW())
          RETURNING id
          `,
          [t, contactId]
        );
        conversationId = insertConv.rows[0].id;
      } else {
        conversationId = convResult.rows[0].id;
      }

      // ✅ incoming deve ser direction='in'
      await client.query(
        `
        INSERT INTO messages (
          tenant_id,
          conversation_id,
          direction,
          sender_type,
          content
        )
        VALUES ($1, $2, 'in', 'contact', $3)
        `,
        [t, conversationId, String(text)]
      );

      await client.query(
        `
        UPDATE conversations
        SET last_message_at = NOW(),
            updated_at = NOW()
        WHERE tenant_id = $1
          AND id = $2
        `,
        [t, conversationId]
      );

      await client.query("COMMIT");
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
  requestPairingCode,
};

/* caminho: api/src/services/whatsapp/whatsapp.service.js */