/* caminho: api/src/server.js */
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { ping } = require("./db");
const inboxRoutes = require("./routes/inbox.routes");
const whatsappRoutes = require("./routes/whatsapp.routes");

const app = express();

// ===== Config =====
const PORT = Number(process.env.PORT || 3000);

// Se quiser travar CORS depois, vamos ajustar via .env (por enquanto libera)
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

// Endpoint dedicado pra validar DB
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

// ===== WhatsApp (webhook simulado) =====
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

// ===== Start =====
app.listen(PORT, () => {
  console.log(`[API] Rodando em http://localhost:${PORT}`);
});
/* caminho: api/src/server.js */