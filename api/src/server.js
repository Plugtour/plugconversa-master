/* caminho: api/src/server.js */
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { ping, pool } = require("./db");
const inboxRoutes = require("./routes/inbox.routes");
const whatsappRoutes = require("./routes/whatsapp.routes");

// ✅ IMPORTANTE: importar startSession
const { startSession } = require("./services/whatsapp/whatsapp.service");

const app = express();

// ===== Config =====
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ===== Rotas base =====
app.get("/api/health", async (req, res) => {
  try {
    const dbOk = await ping();

    return res.status(200).json({
      ok: true,
      service: "plugconversa-api",
      time: new Date().toISOString(),
      db: {
        ok: dbOk,
      },
    });
  } catch (err) {
    console.error("[HEALTH_DB_ERROR]", err);

    return res.status(200).json({
      ok: true,
      service: "plugconversa-api",
      time: new Date().toISOString(),
      db: {
        ok: false,
        error: "DB_PING_FAILED",
      },
    });
  }
});

app.get("/api/db/ping", async (req, res) => {
  try {
    const ok = await ping();
    return res.status(200).json({ ok: true, db: { ok } });
  } catch (err) {
    console.error("[DB_PING_ERROR]", err);
    return res.status(500).json({
      ok: false,
      error: "DB_PING_FAILED",
      message: "Falha ao conectar no banco",
    });
  }
});

// ===== Inbox =====
app.use("/api/inbox", inboxRoutes);

// ===== WhatsApp =====
app.use("/api/whatsapp", whatsappRoutes);

// ===== 404 =====
app.use((req, res) => {
  return res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    message: "Rota não encontrada",
  });
});

// ===== Erro padrão =====
app.use((err, req, res, next) => {
  console.error("[API_ERROR]", err);
  return res.status(500).json({
    ok: false,
    error: "INTERNAL_SERVER_ERROR",
    message: "Erro interno",
  });
});

// ===== AUTO RESTORE WHATSAPP =====
async function restoreWhatsAppSessions() {
  try {
    console.log("[WA][BOOT] Verificando sessões conectadas no banco...");

    const result = await pool.query(
      `SELECT tenant_id FROM whatsapp_sessions WHERE status = 'connected'`
    );

    if (result.rowCount === 0) {
      console.log("[WA][BOOT] Nenhuma sessão para restaurar.");
      return;
    }

    for (const row of result.rows) {
      const tenantId = row.tenant_id;
      console.log(`[WA][BOOT] Restaurando sessão tenant ${tenantId}...`);

      try {
        await startSession(tenantId);
      } catch (err) {
        console.error(
          `[WA][BOOT] Falha ao restaurar tenant ${tenantId}:`,
          err?.message || err
        );
      }
    }
  } catch (err) {
    console.error("[WA][BOOT_ERROR]", err?.message || err);
  }
}

// ===== Start =====
app.listen(PORT, async () => {
  console.log(`[API] Rodando em http://localhost:${PORT}`);
  await restoreWhatsAppSessions();
});
/* caminho: api/src/server.js */