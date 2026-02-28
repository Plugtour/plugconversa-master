/* caminho: api/src/middlewares/requireTenant.js */
module.exports = function requireTenant(req, res, next) {
  // 1) tenta por header (padrão do projeto)
  const headerTenant = req.headers["x-client-id"];

  // 2) permite via query somente para rotas de QR (browser)
  const isQrRoute =
    req.path === "/session/qr" || req.path === "/session/qr.png";

  const queryTenant = isQrRoute ? req.query?.tenant_id : null;

  const tenantIdRaw = headerTenant || queryTenant;

  const tenantId = Number(tenantIdRaw);

  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return res.status(400).json({
      ok: false,
      error: "TENANT_REQUIRED",
      message: "Header x-client-id é obrigatório",
    });
  }

  req.tenant_id = tenantId;
  return next();
};
/* caminho: api/src/middlewares/requireTenant.js */