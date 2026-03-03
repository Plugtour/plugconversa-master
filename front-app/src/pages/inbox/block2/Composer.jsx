/* caminho: front-app/src/pages/inbox/block2/Composer.jsx */
import { useState } from "react";
import { useInboxMessages } from "../shared/useInboxHooks";

function Composer({ conversationId, onSent }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const { sendMessage } = useInboxMessages(conversationId);

  async function handleSend() {
    const content = text.trim();
    if (!content || !conversationId) return;

    setSending(true);
    try {
      await sendMessage(content);
      setText("");
      onSent?.();
    } catch (err) {
      alert(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Digite uma mensagem..."
        style={{
          flex: 1,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid var(--pc-border)",
          outline: "none",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSend();
        }}
      />
      <button onClick={handleSend} disabled={sending || !conversationId}>
        {sending ? "Enviando..." : "Enviar"}
      </button>
    </div>
  );
}

export default Composer;
/* caminho: front-app/src/pages/inbox/block2/Composer.jsx */