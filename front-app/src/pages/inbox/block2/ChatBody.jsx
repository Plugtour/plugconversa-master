/* caminho: front-app/src/pages/inbox/block2/ChatBody.jsx */
import { useEffect, useRef } from "react";
import { useInboxMessages } from "../shared/useInboxHooks";
import { subscribeInboxMessages } from "../../../services/sse";

function ChatBody({ conversationId, refreshKey }) {
  const {
    messages,
    loadingMessages,
    errorMessages,
    reloadMessages,
    appendMessage,
  } = useInboxMessages(conversationId);

  const bottomRef = useRef(null);

  useEffect(() => {
    if (!conversationId) return;
    reloadMessages?.();
  }, [conversationId, refreshKey, reloadMessages]);

  useEffect(() => {
    const unsubscribe = subscribeInboxMessages((payload) => {
      const { conversation_id, message } = payload || {};
      if (!conversation_id || !message) return;

      if (String(conversation_id) === String(conversationId)) {
        appendMessage(message);
      }
    });

    return () => unsubscribe();
  }, [conversationId, appendMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (!conversationId) return <div>Selecione uma conversa.</div>;
  if (loadingMessages) return <div>Carregando mensagens...</div>;
  if (errorMessages) return <div>Erro: {errorMessages}</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {messages.length === 0 && <div>Nenhuma mensagem ainda.</div>}

      {messages.map((m) => {
        const isOut = m.sender_type === "user";

        return (
          <div
            key={m.id}
            style={{
              alignSelf: isOut ? "flex-end" : "flex-start",
              maxWidth: "80%",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid var(--pc-border)",
              background: "var(--pc-surface)",
            }}
          >
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
              {m.content || ""}
            </div>

            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--pc-text-secondary)",
                textAlign: "right",
              }}
            >
              {m.created_at ? new Date(m.created_at).toLocaleString() : ""}
            </div>
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}

export default ChatBody;
/* caminho: front-app/src/pages/inbox/block2/ChatBody.jsx */