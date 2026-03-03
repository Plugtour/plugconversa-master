/* caminho: api/src/services/whatsapp/whatsapp.service.js */

/* ... CÓDIGO ACIMA PERMANECE IGUAL ... */

/**
 * ✅ INCOMING (aceita @s.whatsapp.net e @lid)
 */
sock.ev.on("messages.upsert", async (payload) => {
  const { messages, type } = payload || {};
  const msg = messages?.[0];

  if (!msg?.message) return;
  if (msg.key?.fromMe) return;

  const remoteJid = msg.key?.remoteJid || "";
  if (remoteJid === "status@broadcast") return;
  if (!isPrivateConversationJid(remoteJid)) return;

  const phone = extractContactKeyFromJid(remoteJid);
  if (!phone) return;

  const text = extractTextFromMessage(msg.message);
  if (!text) return;

  const pushName = msg?.pushName ? String(msg.pushName).trim() : null;
  const providerMessageId = msg?.key?.id ? String(msg.key.id) : null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const isLid = remoteJid.endsWith("@lid");
    const legacyLidPhone = isLid ? remoteJid.replace("@lid", "") : null;

    let contactResult;

    if (isLid) {
      contactResult = await client.query(
        `SELECT id, phone
         FROM contacts
         WHERE tenant_id = $1
           AND whatsapp_jid = $2
         LIMIT 1`,
        [t, remoteJid]
      );

      if (contactResult.rowCount === 0) {
        contactResult = await client.query(
          `SELECT id, phone
           FROM contacts
           WHERE tenant_id = $1
             AND phone = $2
           LIMIT 1`,
          [t, phone]
        );
      }

      if (contactResult.rowCount === 0 && legacyLidPhone) {
        contactResult = await client.query(
          `SELECT id, phone
           FROM contacts
           WHERE tenant_id = $1
             AND phone = $2
           LIMIT 1`,
          [t, legacyLidPhone]
        );
      }

    } else {

      // 🔥 AQUI FOI MELHORADO
      contactResult = await client.query(
        `SELECT id, phone
         FROM contacts
         WHERE tenant_id = $1
           AND (phone = $2 OR whatsapp_jid = $3)
         LIMIT 1`,
        [t, phone, remoteJid]
      );
    }

    let contactId;

    if (contactResult.rowCount === 0) {
      const insert = await client.query(
        `INSERT INTO contacts (tenant_id, name, phone, whatsapp_jid)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [t, pushName || phone, phone, remoteJid]
      );
      contactId = insert.rows[0].id;
    } else {
      contactId = contactResult.rows[0].id;
      const existingPhone = contactResult.rows[0].phone || "";

      await client.query(
        `UPDATE contacts
         SET whatsapp_jid = $3,
             updated_at = NOW()
         WHERE tenant_id = $1
           AND id = $2`,
        [t, contactId, remoteJid]
      );

      if (isLid && existingPhone && existingPhone !== phone) {
        const canMigrate =
          existingPhone === legacyLidPhone ||
          (!existingPhone.startsWith("lid:") && !existingPhone.startsWith("jid:"));

        if (canMigrate) {
          await client.query(
            `UPDATE contacts
             SET phone = $3,
                 updated_at = NOW()
             WHERE tenant_id = $1
               AND id = $2`,
            [t, contactId, phone]
          );
        }
      }

      if (pushName) {
        await client.query(
          `UPDATE contacts
           SET name = COALESCE(NULLIF(name, ''), $3),
               updated_at = NOW()
           WHERE tenant_id = $1
             AND id = $2`,
          [t, contactId, pushName]
        );
      }
    }

    const convUpsert = await client.query(
      `INSERT INTO conversations (tenant_id, contact_id, last_message_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id, contact_id)
       DO UPDATE SET last_message_at = NOW(),
                     updated_at = NOW()
       RETURNING id`,
      [t, contactId]
    );

    const conversationId = convUpsert.rows[0].id;

    await client.query(
      `INSERT INTO messages (
        tenant_id,
        conversation_id,
        direction,
        sender_type,
        provider_message_id,
        content
      )
      VALUES ($1, $2, 'in', 'contact', $3, $4)`,
      [t, conversationId, providerMessageId, String(text)]
    );

    await client.query("COMMIT");

  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (e) {}
  } finally {
    client.release();
  }
});

/* caminho: api/src/services/whatsapp/whatsapp.service.js */