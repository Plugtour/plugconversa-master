/* caminho: api/src/routes/whatsapp.routes.js */
const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const requireTenant = require("../middlewares/requireTenant");

// ✅ Baileys service (real)
const whatsappService = require("../services/whatsapp/whatsapp.service");
const { startSession, getSession, sendText, sendTextToJid } = whatsappService;

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
 *
 * Observação:
 * - mesmo que chegue @lid em mensagens, aqui buscamos o jid padrão @s.whatsapp.net
 * - o listener de incoming continua podendo sobrescrever whatsapp_jid com @lid quando necessário
 */
router.post("/resolve-jid", async (req, res, next) => {
  let client;

  try {
    const tenantId = req.tenant_id;
    const { phone, update_contact = false } = req.body || {};

    const p = String(phone || "").trim();
    if (!p) {
      return res.status(400).json({
        ok: false,
        error: "PHONE_REQUIRED",
        message: 'Envie {"phone":"55DDDNUMERO"}',
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

    const digits = p.replace(/\D/g, "");
    const queryJid = `${digits}@s.whatsapp.net`;

    const list = await withTimeout(
      session.sock.onWhatsApp(queryJid),
      WA_SEND_TIMEOUT_MS,
      "onWhatsApp"
    );

    const first = Array.isArray(list) ? list[0] : null;
    const exists = !!first?.exists;
    const resolvedJid = first?.jid ? String(first.jid) : queryJid;

    if (!exists) {
      return res.status(404).json({
        ok: false,
        error: "NOT_ON_WHATSAPP",
        message: "Número não encontrado no WhatsApp (onWhatsApp).",
        data: { phone: digits, jid: resolvedJid, exists: false },
      });
    }

    let updated = false;

    if (update_contact) {
      client = await pool.connect();
      await client.query("BEGIN");

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

      const contactId = c.rows[0]?.id || null;

      if (!contactId) {
        const ins = await client.query(
          `
          INSERT INTO contacts (tenant_id, name, phone, whatsapp_jid)
          VALUES ($1, NULL, $2, $3)
          RETURNING id
          `,
          [tenantId, digits, resolvedJid]
        );
        updated = !!ins.rows[0]?.id;
      } else {
        const up = await client.query(
          `
          UPDATE contacts
          SET whatsapp_jid = $1,
              updated_at = NOW()
          WHERE tenant_id = $2
            AND id = $3
          `,
          [resolvedJid, tenantId, contactId]
        );
        updated = up.rowCount > 0;
      }

      await client.query("COMMIT");
    }

    return res.status(200).json({
      ok: true,
      data: {
        phone: digits,
        jid: resolvedJid,
        exists: true,
        updated_contact: !!updated,
      },
    });
  } catch (err) {
    try {
      if (client) await client.query("ROLLBACK");
    } catch (e) {}
    return next(err);
  } finally {
    try {
      if (client) client.release();
    } catch (e) {}
  }
});

/**
 * GET /api/whatsapp/session
 * Retorna status/qr do banco para o tenant
 */
router.get("/session", async (req, res, next) => {
  try {
    const tenantId = req.tenant_id;

    const r = await pool.query(
      `
      SELECT *
      FROM whatsapp_sessions
      WHERE tenant_id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    return res.status(200).json({
      ok: true,
      data: r.rows[0] || null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * ✅ POST /api/whatsapp/session/pair-code
 * Body: { "phone": "55DDDNUMERO" }
 */
router.post("/session/pair-code", async (req, res, next) => {
  try {
    const tenantId = req.tenant_id;
    const { phone } = req.body || {};

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "PHONE_REQUIRED",
        message: 'Envie {"phone":"55DDDNUMERO"}',
      });
    }

    if (typeof requestPairingCode !== "function") {
      return res.status(500).json({
        ok: false,
        error: "PAIR_CODE_NOT_IMPLEMENTED",
        message:
          "Seu whatsapp.service.js ainda não exporta requestPairingCode. Vou ajustar no próximo arquivo.",
      });
    }

    await startSession(tenantId);

    const code = await requestPairingCode(tenantId, phone);

    return res.status(200).json({
      ok: true,
      data: { code },
      message:
        "Use este código no celular: WhatsApp > Aparelhos conectados > Conectar com número de telefone.",
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/whatsapp/session/start
 */
router.post("/session/start", async (req, res, next) => {
  const client = await pool.connect();

  try {
    const tenantId = req.tenant_id;

    await client.query("BEGIN");

    const existing = await client.query(
      `
      SELECT id
      FROM whatsapp_sessions
      WHERE tenant_id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    let session;

    if (existing.rowCount === 0) {
      const insert = await client.query(
        `
        INSERT INTO whatsapp_sessions (
          tenant_id,
          provider,
          status,
          qr_code,
          connected_at,
          disconnected_at
        )
        VALUES ($1, 'baileys', 'connecting', NULL, NULL, NULL)
        RETURNING *
        `,
        [tenantId]
      );
      session = insert.rows[0];
    } else {
      const update = await client.query(
        `
        UPDATE whatsapp_sessions
        SET provider = 'baileys',
            status = 'connecting',
            qr_code = NULL,
            updated_at = NOW()
        WHERE tenant_id = $1
        RETURNING *
        `,
        [tenantId]
      );
      session = update.rows[0];
    }

    await client.query("COMMIT");

    startSession(tenantId).catch((err) => {
      console.error("[WHATSAPP_START_SESSION_ERROR]", err);
    });

    return res.status(200).json({
      ok: true,
      data: session,
      message:
        "Sessão iniciada. Abra /api/whatsapp/session/qr?tenant_id=1 (DEV) ou consulte /api/whatsapp/session (API).",
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

/**
 * POST /api/whatsapp/session/disconnect
 */
router.post("/session/disconnect", async (req, res, next) => {
  try {
    const tenantId = req.tenant_id;

    const r = await pool.query(
      `
      UPDATE whatsapp_sessions
      SET status = 'disconnected',
          disconnected_at = NOW(),
          updated_at = NOW()
      WHERE tenant_id = $1
      RETURNING *
      `,
      [tenantId]
    );

    return res.status(200).json({
      ok: true,
      data: r.rows[0] || null,
    });
  } catch (err) {
    return next(err);
  }
});

/* =========================================================
   WEBHOOK INCOMING (manual test)
========================================================= */

router.post("/webhook/incoming", async (req, res, next) => {
  const client = await pool.connect();

  try {
    const tenantId = req.tenant_id;
    const { phone, message, name = null } = req.body;

    if (!phone || !message) {
      return res.status(400).json({
        ok: false,
        error: "PHONE_AND_MESSAGE_REQUIRED",
      });
    }

    await client.query("BEGIN");

    const contactResult = await client.query(
      `
      SELECT id, name, phone
      FROM contacts
      WHERE tenant_id = $1
        AND phone = $2
      LIMIT 1
      `,
      [tenantId, phone]
    );

    let contact = contactResult.rows[0];

    if (!contact) {
      const contactInsert = await client.query(
        `
        INSERT INTO contacts (tenant_id, name, phone)
        VALUES ($1, $2, $3)
        RETURNING *
        `,
        [tenantId, name, phone]
      );
      contact = contactInsert.rows[0];
    }

    const convResult = await client.query(
      `
      SELECT *
      FROM conversations
      WHERE tenant_id = $1
        AND contact_id = $2
        AND status = 'open'
      ORDER BY last_message_at DESC NULLS LAST, id DESC
      LIMIT 1
      `,
      [tenantId, contact.id]
    );

    let conversation = convResult.rows[0];

    if (!conversation) {
      const convInsert = await client.query(
        `
        INSERT INTO conversations (tenant_id, contact_id, status, last_message_at)
        VALUES ($1, $2, 'open', NOW())
        RETURNING *
        `,
        [tenantId, contact.id]
      );
      conversation = convInsert.rows[0];
    }

    const msgInsert = await client.query(
      `
      INSERT INTO messages (tenant_id, conversation_id, sender_type, content)
      VALUES ($1, $2, 'contact', $3)
      RETURNING *
      `,
      [tenantId, conversation.id, message]
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
      data: {
        contact,
        conversation,
        message: msgInsert.rows[0],
      },
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

/* =========================================================
   SEND MESSAGE (REAL via Baileys + grava no banco)
   ✅ AGORA ACEITA:
   - por conversation_id  (fluxo normal)
   - OU por phone         (cria/acha contact + conversation e envia)
========================================================= */

router.post("/send", async (req, res, next) => {
  const client = await pool.connect();

  try {
    const tenantId = req.tenant_id;
    const { conversation_id, phone, content, sender_id = null } = req.body;

    if (!content || !String(content).trim()) {
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
        message: "Escaneie o QR e aguarde status=connected antes de enviar.",
      });
    }

    await client.query("BEGIN");

    // =====================================================
    // MODO 1: envio por conversation_id (como já era)
    // =====================================================
    if (conversation_id) {
      const conversationId = Number(conversation_id);

      if (!Number.isInteger(conversationId) || conversationId <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: "INVALID_CONVERSATION_ID",
        });
      }

      const convResult = await client.query(
        `
        SELECT c.id, ct.phone, ct.whatsapp_jid
        FROM conversations c
        JOIN contacts ct
          ON ct.id = c.contact_id
         AND ct.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1
          AND c.id = $2
        LIMIT 1
        `,
        [tenantId, conversationId]
      );

      if (convResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          ok: false,
          error: "CONVERSATION_NOT_FOUND",
        });
      }

      const { phone: ctPhone, whatsapp_jid } = convResult.rows[0];

      let providerMessageId = null;
      let warning = null;

      try {
        if (whatsapp_jid && typeof sendTextToJid === "function") {
          const sent = await withTimeout(
            sendTextToJid(tenantId, String(whatsapp_jid), String(content).trim()),
            WA_SEND_TIMEOUT_MS,
            "sendTextToJid"
          );
          providerMessageId = sent?.providerMessageId || null;
        } else {
          await withTimeout(
            sendText(tenantId, ctPhone, String(content).trim()),
            WA_SEND_TIMEOUT_MS,
            "sendText"
          );
        }
      } catch (e) {
        // ✅ Se for timeout, não travamos a API: seguimos e retornamos warning
        if (e?.code === "WA_SEND_TIMEOUT") {
          warning = e.message;
          console.warn("[WA_SEND_TIMEOUT][mode=conversation_id]", {
            tenantId,
            conversationId,
            whatsapp_jid: whatsapp_jid || null,
            phone: ctPhone,
            timeout_ms: WA_SEND_TIMEOUT_MS,
          });
        } else {
          await client.query("ROLLBACK");
          return res.status(400).json({
            ok: false,
            error: "WHATSAPP_SEND_FAILED",
            message: e?.message || "Falha ao enviar pelo WhatsApp",
          });
        }
      }

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
        [
          tenantId,
          conversationId,
          sender_id,
          providerMessageId,
          String(content).trim(),
        ]
      );

      await client.query(
        `
        UPDATE conversations
        SET last_message_at = NOW(),
            updated_at = NOW()
        WHERE tenant_id = $1
          AND id = $2
        `,
        [tenantId, conversationId]
      );

      await client.query("COMMIT");

      return res.status(200).json({
        ok: true,
        data: msgInsert.rows[0],
        ...(warning ? { warning } : {}),
      });
    }

    // =====================================================
    // MODO 2: envio por phone (novo)
    // - cria/acha contact (por phone)
    // - cria/acha conversation (única por contact)
    // - tenta enviar por whatsapp_jid se existir, senão por phone
    // =====================================================
    const p = String(phone || "").trim();
    if (!p) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "PHONE_REQUIRED",
        message: 'Envie {"phone":"55DDDNUMERO","content":"..."} ou use conversation_id',
      });
    }

    // 1) contact
    let contact = null;
    const contactResult = await client.query(
      `
      SELECT id, name, phone, whatsapp_jid
      FROM contacts
      WHERE tenant_id = $1
        AND phone = $2
      LIMIT 1
      `,
      [tenantId, p]
    );

    if (contactResult.rowCount > 0) {
      contact = contactResult.rows[0];
    } else {
      const contactInsert = await client.query(
        `
        INSERT INTO contacts (tenant_id, name, phone)
        VALUES ($1, NULL, $2)
        RETURNING id, name, phone, whatsapp_jid
        `,
        [tenantId, p]
      );
      contact = contactInsert.rows[0];
    }

    // 2) conversation (lembrando: tem UNIQUE (tenant_id, contact_id))
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

    // 3) enviar (com timeout pra rota não travar)
    let providerMessageId = null;
    let warning = null;

    try {
      if (contact.whatsapp_jid && typeof sendTextToJid === "function") {
        const sent = await withTimeout(
          sendTextToJid(tenantId, String(contact.whatsapp_jid), String(content).trim()),
          WA_SEND_TIMEOUT_MS,
          "sendTextToJid"
        );
        providerMessageId = sent?.providerMessageId || null;
      } else {
        await withTimeout(
          sendText(tenantId, p, String(content).trim()),
          WA_SEND_TIMEOUT_MS,
          "sendText"
        );
      }
    } catch (e) {
      if (e?.code === "WA_SEND_TIMEOUT") {
        warning = e.message;
        console.warn("[WA_SEND_TIMEOUT][mode=phone]", {
          tenantId,
          conversationId: conversation?.id,
          contactId: contact?.id,
          whatsapp_jid: contact?.whatsapp_jid || null,
          phone: p,
          timeout_ms: WA_SEND_TIMEOUT_MS,
        });
      } else {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: "WHATSAPP_SEND_FAILED",
          message: e?.message || "Falha ao enviar pelo WhatsApp",
        });
      }
    }

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
      [
        tenantId,
        conversation.id,
        sender_id,
        providerMessageId,
        String(content).trim(),
      ]
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
      ...(warning ? { warning } : {}),
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