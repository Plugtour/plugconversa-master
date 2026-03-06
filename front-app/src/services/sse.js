/* caminho: front-app/src/services/sse.js */

const API_BASE =
  import.meta.env.VITE_API_BASE?.trim() || "http://185.197.250.224/api";

let eventSource = null;
const listeners = new Set();

export function connectInboxSSE() {
  if (eventSource) return eventSource;

  const url = `${API_BASE}/inbox/events?tenant_id=1`;

  eventSource = new EventSource(url);

  eventSource.addEventListener("ready", (event) => {
    console.log("SSE ready", event.data);
  });

  eventSource.addEventListener("ping", () => {
    // keep alive
  });

  eventSource.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);

      listeners.forEach((cb) => {
        try {
          cb(payload);
        } catch (err) {
          console.error("SSE listener error", err);
        }
      });
    } catch (err) {
      console.error("Erro ao processar SSE", err);
    }
  });

  eventSource.onerror = (err) => {
    console.error("SSE error", err);
  };

  return eventSource;
}

export function subscribeInboxMessages(callback) {
  listeners.add(callback);

  return () => {
    listeners.delete(callback);
  };
}

/* caminho: front-app/src/services/sse.js */