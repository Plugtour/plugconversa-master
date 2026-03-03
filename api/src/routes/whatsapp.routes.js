/* caminho: api/src/routes/whatsapp.routes.js */
const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const requireTenant = require("../middlewares/requireTenant");

// ✅ Baileys service (real)
const whatsappService = require("../services/whatsapp/whatsapp.service");
const { startSession, getSession, sendText, sendTextToJid, resolveJidByPhone } =
  whatsappService;

// opcional (só existe se você adicionar no service)
const requestPairingCode = whatsappService.requestPairingCode;

/**
 * ✅ Helper: pega tenant_id de forma segura
 * - padrão: middleware requireTenant (header x-client-id)
 * - exceção DEV: rotas de QR podem aceitar ?tenant_id=1
 */
function getTenantIdFromRequest(req) {
  // quando passou pelo middleware
  if (req.tenant_id) return req.tenant_id;

  // DEV fallback via query
  const q = req.query?.tenant_id;
  const n = Number(q);
  if (Number.isInteger(n) && n > 0) return n;

  return null;
}

/**
 * ✅ Helper: evita travar a API no envio (Baileys às vezes fica aguardando ACK)
 */
const WA_SEND_TIMEOUT_MS = Number(process.env.WA_SEND_TIMEOUT_MS || 8000);

class WATimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "WATimeoutError";
    this.code = "WA_SEND_TIMEOUT";
  }
}

function withTimeout(promise, ms, label = "operation") {
  let t;
  const timeoutPromise = new Promise((_, reject) => {
    t = setTimeout(() => {
      reject(new WATimeoutError(`Timeout (${ms}ms) em ${label}`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(t));
}

/* =========================================================
   QR ROUTES (SEM requireTenant) - permite abrir no navegador
========================================================= */

/**
 * ✅ GET /api/whatsapp/session/qr
 * Renderiza o QR em HTML (pra abrir no navegador)
 * DEV: aceita ?tenant_id=1
 */
router.get("/session/qr", async (req, res, next) => {
  try {
    const tenantId = getTenantIdFromRequest(req);

    if (!tenantId) {
      return res.status(400).send(`
        <html>
          <head><meta charset="utf-8" /></head>
          <body style="font-family:Arial;text-align:center;padding:40px">
            <h2>Tenant não informado</h2>
            <p>Use <b>?tenant_id=1</b> (DEV) ou chame via API com header <b>x-client-id</b>.</p>
          </body>
        </html>
      `);
    }

    const r = await pool.query(
      `
      SELECT status, qr_code
      FROM whatsapp_sessions
      WHERE tenant_id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    const row = r.rows[0];

    if (!row) {
      return res.status(200).send(`
        <html>
          <head><meta charset="utf-8" /></head>
          <body style="font-family:Arial;text-align:center;padding:40px">
            <h2>Nenhuma sessão encontrada</h2>
            <p>Inicie em <b>POST /api/whatsapp/session/start</b> (via header x-client-id).</p>
          </body>
        </html>
      `);
    }

    if (!row.qr_code) {
      return res.status(200).send(`
        <html>
          <head><meta charset="utf-8" /></head>
          <body style="font-family:Arial;text-align:center;padding:40px">
            <h2>QR ainda não disponível</h2>
            <p>Status atual: <b>${row.status || "?"}</b></p>
            <p>Atualize esta página em alguns segundos.</p>
          </body>
        </html>
      `);
    }

    return res.status(200).send(`
      <html>
        <head><meta charset="utf-8" /></head>
        <body style="background:#111;color:#fff;font-family:Arial;text-align:center;padding:40px">
          <h2>Escaneie o QR no WhatsApp</h2>
          <p>Status: <b>${row.status}</b></p>
          <div style="display:inline-block;background:#fff;padding:18px;border-radius:12px;margin-top:16px">
            <img src="${row.qr_code}" style="width:320px;height:320px" />
          </div>
          <p style="opacity:.8;margin-top:18px">Se expirar, rode <b>POST /api/whatsapp/session/start</b> novamente.</p>
          <p style="opacity:.8;margin-top:10px">Alternativa: use <b>POST /api/whatsapp/session/pair-code</b> (código por número).</p>
        </body>
      </html>
    `);
  } catch (err) {
    return next(err);
  }
});

/**
 * ✅ GET /api/whatsapp/session/qr.png
 * Retorna o QR como imagem PNG
 * DEV: aceita ?tenant_id=1
 */
router.get("/session/qr.png", async (req, res, next) => {
  try {
    const tenantId = getTenantIdFromRequest(req);

    if (!tenantId) {
      return res.status(400).json({
        ok: false,
        error: "TENANT_REQUIRED",
        message: "Use ?tenant_id=1 (DEV) ou chame via API com header x-client-id.",
      });
    }

    const r = await pool.query(
      `
      SELECT status, qr_code
      FROM whatsapp_sessions
      WHERE tenant_id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    const row = r.rows[0];

    if (!row) {
      return res.status(404).json({
        ok: false,
        error: "SESSION_NOT_FOUND",
        message: "Inicie em POST /api/whatsapp/session/start",
      });
    }

    if (!row.qr_code) {
      return res.status(404).json({
        ok: false,
        error: "QR_NOT_AVAILABLE",
        message: `QR ainda não disponível. Status: ${row.status || "?"}`,
      });
    }

    const match = String(row.qr_code).match(/^data:image\/png;base64,(.+)$/);
    if (!match) {
      return res.status(500).json({
        ok: false,
        error: "QR_INVALID_FORMAT",
        message: "qr_code não está no formato data:image/png;base64,...",
      });
    }

    const buffer = Buffer.from(match[1], "base64");
    res.setHeader("Content-Type", "image/png");
    return res.status(200).send(buffer);
  } catch (err) {
    return next(err);
  }
});

/* =========================================================
   A PARTIR DAQUI: exige tenant por header (multi-tenant real)
========================================================= */

router.use(requireTenant);

/**
 * ✅ POST /api/whatsapp/resolve-jid
 * Body: { "phone": "55DDDNUMERO", "update_contact": true }
 * - resolve o JID via Baileys (onWhatsApp)
 * - opcionalmente grava em contacts.whatsapp_jid para este phone
 */
router.post("/resolve-jid", async (req, res, next) => {
  const client = await pool.connect();

  try {
    const tenantId = req.tenant_id;
    const { phone, update_contact = false } = req.body || {};

    const p = String(phone || "").trim();
    if (!p) {
      client.release();
      return res.status(400).json({
        ok: false,
        error: "PHONE_REQUIRED",
        message: 'Envie {"phone":"55DDDNUMERO"}',
      });
    }

    const session = getSession(tenantId);
    if (!session?.sock) {
      client.release();
      return res.status(400).json({
        ok: false,
        error: "WHATSAPP_SESSION_NOT_STARTED",
      });
    }

    if (!session.sock.user?.id) {
      client.release();
      return res.status(400).json({
        ok: false,
        error: "WHATSAPP_NOT_CONNECTED",
        message: "A sessão ainda não está conectada.",
      });
    }

    const digits = p.replace(/\D/g, "");

    // usa o service (com timeout interno e validações)
    const r = await withTimeout(
      resolveJidByPhone(tenantId, digits),
      Number(process.env.WA_RESOLVE_TIMEOUT_MS || 9000),
      "resolveJidByPhone"
    );

    const exists = !!r?.exists;
    if (!exists) {
      client.release();
      return res.status(404).json({
        ok: false,
        error: "NOT_ON_WHATSAPP",
        message: "Número não encontrado no WhatsApp (onWhatsApp).",
        data: { phone: digits, exists: false },
      });
    }

    // melhor JID para salvar/enviar:
    // - se vier lid, salva como @lid (mais útil para envio quando o contato aparece assim)
    // - senão, usa o jid resolvido (@s.whatsapp.net)
    let bestJid = r?.resolved?.jid ? String(r.resolved.jid) : `${digits}@s.whatsapp.net`;
    if (r?.resolved?.lid) {
      const lidRaw = String(r.resolved.lid).trim();
      bestJid = lidRaw.endsWith("@lid") ? lidRaw : `${lidRaw.replace(/@lid$/i, "")}@lid`;
    }

    let updated = false;

    if (update_contact) {
      await client.query("BEGIN");

      // garante contact por phone
      const c = await client.query(
        `
        SELECT id
        FROM contacts
        WHERE tenant_id = $1
          AND phone = $2
        LIMIT 1
        `,
        [tenantId, digits]
      );

      let contactId = c.rows[0]?.id;

      if (!contactId) {
        const ins = await client.query(
          `
          INSERT INTO contacts (tenant_id, name, phone, whatsapp_jid)
          VALUES ($1, NULL, $2, $3)
          RETURNING id
          `,
          [tenantId, digits, bestJid]
        );
        contactId = ins.rows[0].id;
        updated = true;
      } else {
        const up = await client.query(
          `
          UPDATE contacts
          SET whatsapp_jid = $1,
              updated_at = NOW()
          WHERE tenant_id = $2
            AND id = $3
          `,
          [bestJid, tenantId, contactId]
        );
        updated = up.rowCount > 0;
      }

      await client.query("COMMIT");
    }

    client.release();
    return res.status(200).json({
      ok: true,
      data: {
        phone: digits,
        jid: bestJid,
        exists: true,
        updated_contact: !!updated,
      },
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (e) {}
    client.release();
    return next(err);
  }
});

/**
 * ✅ POST /api/whatsapp/send-to-jid
 * Body: { "jid": "xxx@lid|xxx@s.whatsapp.net", "content": "..." }
 * - envia direto para um JID (útil para @lid)
 * - grava no banco criando/achando contact+conversation pelo whatsapp_jid
 */
router.post("/send-to-jid", async (req, res, next) => {
  const client = await pool.connect();

  try {
    const tenantId = req.tenant_id;
    const { jid, content, sender_id = null } = req.body || {};

    const j = String(jid || "").trim();
    const text = String(content || "").trim();

    if (!j) {
      return res.status(400).json({
        ok: false,
        error: "JID_REQUIRED",
        message: 'Envie {"jid":"...@lid|...@s.whatsapp.net","content":"..."}',
      });
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "CONTENT_REQUIRED",
      });
    }

    const session = getSession(tenantId);
    if (!session?.sock) {
      return res.status(400).json({
        ok: false,
        error: "WHATSAPP_SESSION_NOT_STARTED",
      });
    }

    if (!session.sock.user?.id) {
      return res.status(400).json({
        ok: false,
        error: "WHATSAPP_NOT_CONNECTED",
        message: "A sessão ainda não está conectada.",
      });
    }

    await client.query("BEGIN");

    // 1) contact por whatsapp_jid
    let contact = null;
    const c = await client.query(
      `
      SELECT id, name, phone, whatsapp_jid
      FROM contacts
      WHERE tenant_id = $1
        AND whatsapp_jid = $2
      LIMIT 1
      `,
      [tenantId, j]
    );

    if (c.rowCount > 0) {
      contact = c.rows[0];
    } else {
      // se não tiver phone conhecido, salva NULL e usa o jid
      const ins = await client.query(
        `
        INSERT INTO contacts (tenant_id, name, phone, whatsapp_jid)
        VALUES ($1, NULL, NULL, $2)
        RETURNING id, name, phone, whatsapp_jid
        `,
        [tenantId, j]
      );
      contact = ins.rows[0];
    }

    // 2) conversation (única por contact)
    let conversation = null;
    const convExisting = await client.query(
      `
      SELECT id, tenant_id, contact_id
      FROM conversations
      WHERE tenant_id = $1
        AND contact_id = $2
      LIMIT 1
      `,
      [tenantId, contact.id]
    );

    if (convExisting.rowCount > 0) {
      conversation = convExisting.rows[0];
    } else {
      const convInsert = await client.query(
        `
        INSERT INTO conversations (tenant_id, contact_id, status, last_message_at)
        VALUES ($1, $2, 'open', NOW())
        RETURNING id, tenant_id, contact_id
        `,
        [tenantId, contact.id]
      );
      conversation = convInsert.rows[0];
    }

    // 3) envia por JID
    const sent = await withTimeout(
      sendTextToJid(tenantId, j, text),
      WA_SEND_TIMEOUT_MS,
      "sendTextToJid"
    );
    const providerMessageId = sent?.providerMessageId || null;

    // 4) grava mensagem OUT
    const msgInsert = await client.query(
      `
      INSERT INTO messages (
        tenant_id,
        conversation_id,
        direction,
        sender_type,
        sender_id,
        provider_message_id,
        content
      )
      VALUES ($1, $2, 'out', 'user', $3, $4, $5)
      RETURNING *
      `,
      [tenantId, conversation.id, sender_id, providerMessageId, text]
    );

    await client.query(
      `
      UPDATE conversations
      SET last_message_at = NOW(),
          updated_at = NOW()
      WHERE tenant_id = $1
        AND id = $2
      `,
      [tenantId, conversation.id]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      ok: true,
      data: msgInsert.rows[0],
      meta: { created_or_used_conversation_id: conversation.id },
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (e) {}
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
/* caminho: api/src/routes/whatsapp.routes.js */