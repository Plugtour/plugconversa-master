/* caminho: api/src/routes/inbox.routes.js */
const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const requireTenant = require("../middlewares/requireTenant");

// Todas as rotas do inbox exigem tenant
router.use(requireTenant);

/**
 * GET /api/inbox/conversations
 * Lista conversas do tenant
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
        ct.phone AS contact_phone
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

    const q = `
      SELECT
        id,
        sender_type,
        sender_id,
        content,
        created_at
      FROM messages
      WHERE tenant_id = $1
        AND conversation_id = $2
      ORDER BY created_at ASC
    `;

    const r = await pool.query(q, [tenantId, conversationId]);

    return res.status(200).json({
      ok: true,
      data: r.rows,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/inbox/conversations/:id/messages
 */
router.post("/conversations/:id/messages", async (req, res, next) => {
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

    const insertQuery = `
      INSERT INTO messages (
        tenant_id,
        conversation_id,
        sender_type,
        sender_id,
        content
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const r = await pool.query(insertQuery, [
      tenantId,
      conversationId,
      sender_type,
      sender_id,
      String(content).trim(),
    ]);

    // Atualiza last_message_at da conversation (só dentro do tenant)
    await pool.query(
      `
      UPDATE conversations
      SET last_message_at = NOW(),
          updated_at = NOW()
      WHERE tenant_id = $1
        AND id = $2
      `,
      [tenantId, conversationId]
    );

    return res.status(201).json({
      ok: true,
      data: r.rows[0],
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/inbox/contacts/:contact_id/messages
 * Envia mensagem para um contact.
 * - Se não existir conversation "open" para esse contact no tenant: cria
 * - Insere mensagem
 * - Atualiza last_message_at
 * - Retorna conversation + message
 */
router.post("/contacts/:contact_id/messages", async (req, res, next) => {
  const client = await pool.connect();

  try {
    const tenantId = req.tenant_id;
    const contactId = Number(req.params.contact_id);
    const { content, sender_type = "user", sender_id = null, assigned_user_id = null } = req.body;

    if (!Number.isInteger(contactId) || contactId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_CONTACT_ID",
      });
    }

    if (!content || !String(content).trim()) {
      return res.status(400).json({
        ok: false,
        error: "CONTENT_REQUIRED",
      });
    }

    await client.query("BEGIN");

    // 1) Garante que o contact existe no tenant
    const contactCheck = await client.query(
      `
      SELECT id, name, phone
      FROM contacts
      WHERE tenant_id = $1
        AND id = $2
      `,
      [tenantId, contactId]
    );

    if (contactCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        error: "CONTACT_NOT_FOUND",
      });
    }

    // 2) Busca conversation aberta desse contact
    const convFind = await client.query(
      `
      SELECT id, status, assigned_user_id, last_message_at, created_at, updated_at
      FROM conversations
      WHERE tenant_id = $1
        AND contact_id = $2
        AND status = 'open'
      ORDER BY last_message_at DESC NULLS LAST, id DESC
      LIMIT 1
      `,
      [tenantId, contactId]
    );

    let conversation = convFind.rows[0];

    // 3) Se não existir, cria
    if (!conversation) {
      const convCreate = await client.query(
        `
        INSERT INTO conversations (
          tenant_id,
          contact_id,
          assigned_user_id,
          status,
          last_message_at
        )
        VALUES ($1, $2, $3, 'open', NOW())
        RETURNING *
        `,
        [tenantId, contactId, assigned_user_id]
      );

      conversation = convCreate.rows[0];
    }

    // 4) Insere mensagem
    const msgInsert = await client.query(
      `
      INSERT INTO messages (
        tenant_id,
        conversation_id,
        sender_type,
        sender_id,
        content
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        tenantId,
        conversation.id,
        sender_type,
        sender_id,
        String(content).trim(),
      ]
    );

    const message = msgInsert.rows[0];

    // 5) Atualiza last_message_at da conversation
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

    return res.status(201).json({
      ok: true,
      data: {
        conversation_id: conversation.id,
        conversation,
        message,
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

module.exports = router;
/* caminho: api/src/routes/inbox.routes.js */