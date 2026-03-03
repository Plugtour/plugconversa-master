/* caminho: front-app/src/pages/inbox/block1/ConversationList.jsx */
import { useInboxConversations } from "../shared/useInboxHooks";

function ConversationList({ selectedConversationId, onSelect }) {
  const { conversations, loadingConversations, errorConversations } =
    useInboxConversations();

  if (loadingConversations) return <div>Carregando...</div>;
  if (errorConversations) return <div>Erro: {errorConversations}</div>;

  return (
    <div>
      <h3 style={{ marginBottom: 12 }}>Conversas</h3>

      {conversations.length === 0 && <div>Nenhuma conversa encontrada.</div>}

      {conversations.map((conv) => {
        const isActive = String(conv.id) === String(selectedConversationId);

        return (
          <div
            key={conv.id}
            onClick={() => onSelect?.(conv)}
            style={{
              padding: 10,
              borderBottom: "1px solid var(--pc-border)",
              cursor: "pointer",
              background: isActive ? "rgba(15, 23, 42, 0.06)" : "transparent",
              borderRadius: 10,
              marginBottom: 8,
            }}
          >
            <strong>{conv.contact_name || "Sem nome"}</strong>
            <div style={{ fontSize: 12, color: "var(--pc-text-secondary)" }}>
              {conv.last_message_preview || "Sem mensagem"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ConversationList;
/* caminho: front-app/src/pages/inbox/block1/ConversationList.jsx */