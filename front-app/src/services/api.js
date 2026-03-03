/* caminho: front-app/src/services/api.js */

const API_BASE =
  import.meta.env.VITE_API_BASE?.trim() || "http://185.197.250.224/api";

export async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "x-client-id": "1",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "");
    throw new Error(error || `Erro na API (${response.status})`);
  }

  return response.json();
}

/* caminho: front-app/src/services/api.js */