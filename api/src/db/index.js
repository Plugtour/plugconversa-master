/* caminho: api/src/db/index.js */
const { Pool } = require("pg");

// Usa as variáveis do .env (já carregadas no server.js via dotenv)
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONN_TIMEOUT_MS || 5000),
});

// Log de erro do pool (não derruba a API, mas ajuda a debugar)
pool.on("error", (err) => {
  console.error("[DB_POOL_ERROR]", err);
});

// Função simples para ping (usaremos no endpoint)
async function ping() {
  const r = await pool.query("SELECT 1 AS ok");
  return r.rows?.[0]?.ok === 1;
}

module.exports = {
  pool,
  ping,
};
/* caminho: api/src/db/index.js */