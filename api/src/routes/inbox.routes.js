/* caminho: api/src/routes/inbox.routes.js */
const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const requireTenant = require("../middlewares/requireTenant");

// ✅ Baileys service
const whatsappService = require("../services/whatsapp/whatsapp.service");
const { getSession, sendText, sendTextToJid } = whatsappService;

// ✅ NOVO SSE SERVICE CENTRAL
const {
  sseAddClient,
  sseRemoveClient,
  sseBroadcast,
} = require("../services/sse/sse.service");

// Todas as rotas do inbox exigem tenant
router.use(requireTenant);

/**
 * GET /api/inbox/events
 * SSE stream para o frontend receber eventos em tempo real
 */
router.get("/events", async (req, res) => {
  const tenantId = req.tenant_id;

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Se estiver atrás de proxy (nginx), ajuda a evitar buffering
  res.setHeader("X-Accel-Buffering", "no");

  // "abre" o stream
  res.write(`event: ready\n`);
  res.write(`data: ${JSON.stringify({ ok: true })}\n\n`);

  sseAddClient(tenantId, res);

  // keep-alive a cada 25s
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: ping\n`);
      res.write(`data: ${JSON.stringify({ t: Date.now() })}\n\n`);
    } catch (e) {}
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseRemoveClient(tenantId, res);
  });
});

/**
 * GET /api/inbox/conversations
 * Lista conversas do tenant
 * - ordenação: last_message_at DESC
 * - inclui contact.name, contact.phone, contact.whatsapp_jid
 * - inclui contador unread (placeholder por enquanto)
 */
router.get("/conversations", async (req, res, next) => {
  try {
    const tenantId = req.tenant_id;

    const q = `
      SELECT
        c.id,
        c.status,
        c.assigned_user_id,
        c.last_message_at,
        c.created_at,
        c.updated_at,
        ct.id   AS contact_id,
        ct.name AS contact_name,
        ct.phone AS contact_phone,
        ct.whatsapp_jid AS contact_whatsapp_jid,
        0::int AS unread_count
      FROM conversations c
      INNER JOIN contacts ct
        ON ct.id = c.contact_id
       AND ct.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
      LIMIT 200
    `;

    const r = await pool.query(q, [tenantId]);

    return res.status(200).json({
      ok: true,
      data: r.rows,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/inbox/conversations/:id/messages
 * - paginado (limit/offset)
 * - ordenado por created_at ASC
 * - inclui direction
 */
router.get("/conversations/:id/messages", async (req, res, next) => {
  try {
    const tenantId = req.tenant_id;
    const conversationId = Number(req.params.id);

    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CONVERSATION_ID",
      });
    }

    const limitRaw = Number(req.query.limit ?? 50);
    const offsetRaw = Number(req.query.offset ?? 0);

    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

    const q = `
      SELECT
        id,
        sender_type,
        sender_id,
        direction,
        content,
        created_at
      FROM messages
      WHERE tenant_id = $1
        AND conversation_id = $2
      ORDER BY created_at ASC, id ASC
      LIMIT $3
      OFFSET $4
    `;

    const r = await pool.query(q, [tenantId, conversationId, limit, offset]);

    return res.status(200).json({
      ok: true,
      data: r.rows,
      paging: { limit, offset, count: r.rows.length },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/inbox/conversations/:id/messages
 * ✅ envia WhatsApp real + salva no banco
 * ✅ prioriza whatsapp_jid (ex: ...@lid)
 * ✅ não cria novos contatos
 */
router.post("/conversations/:id/messages", async (req, res, next) => {
  const client = await pool.connect();

  try {
    const tenantId = req.tenant_id;
    const conversationId = Number(req.params.id);
    const { content, sender_type = "user", sender_id = null } = req.body;

    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CONVERSATION_ID",
      });
    }

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
        message: "Aguarde status=connected antes de enviar.",
      });
    }

    await client.query("BEGIN");

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

    const { phone, whatsapp_jid } = convResult.rows[0];

    let providerMessageId = null;

    try {
      if (whatsapp_jid && typeof sendTextToJid === "function") {
        const sent = await sendTextToJid(
          tenantId,
          String(whatsapp_jid),
          String(content).trim()
        );
        providerMessageId = sent?.providerMessageId || null;
      } else {
        const sent = await sendText(tenantId, phone, String(content).trim());
        providerMessageId = sent?.providerMessageId || null;
      }
    } catch (e) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "WHATSAPP_SEND_FAILED",
        message: e?.message || "Falha ao enviar pelo WhatsApp",
      });
    }

    const insertQuery = `
      INSERT INTO messages (
        tenant_id,
        conversation_id,
        direction,
        sender_type,
        sender_id,
        provider_message_id,
        content
      )
      VALUES ($1, $2, 'out', $3, $4, $5, $6)
      RETURNING *
    `;

    const r = await client.query(insertQuery, [
      tenantId,
      conversationId,
      sender_type,
      sender_id,
      providerMessageId,
      String(content).trim(),
    ]);

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

    const payload = {
      tenant_id: tenantId,
      conversation_id: conversationId,
      message_id: r.rows[0]?.id,
      message: r.rows[0],
    };

    sseBroadcast(tenantId, "message:new", payload);
    sseBroadcast(tenantId, "message", payload);

    return res.status(201).json({
      ok: true,
      data: r.rows[0],
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
/* caminho: api/src/routes/inbox.routes.js */