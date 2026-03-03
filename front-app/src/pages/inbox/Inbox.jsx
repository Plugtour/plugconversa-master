/* caminho: front-app/src/pages/inbox/Inbox.jsx */
import { useState } from "react";
import "./inbox.css";
import ConversationList from "./block1/ConversationList.jsx";
import ChatBody from "./block2/ChatBody.jsx";
import Composer from "./block2/Composer.jsx";

function Inbox() {
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  function handleSelectConversation(conv) {
    setSelectedConversation(conv);
    setRefreshKey((v) => v + 1); // força carregar mensagens ao trocar conversa
  }

  function handleSent() {
    setRefreshKey((v) => v + 1); // força recarregar após envio
  }

  return (
    <div className="pcPage">
      <div className="pcPageHeader">
        <h1 className="pcPageTitle">Inbox</h1>
        <p className="pcPageSubtitle">WhatsApp conectado ao sistema.</p>
      </div>

      <div className="pcPageBody">
        <div className="pcInboxGrid">
          <div className="pcBlock pcInboxBlock1">
            <div className="pcCard">
              <ConversationList
                selectedConversationId={selectedConversation?.id}
                onSelect={handleSelectConversation}
              />
            </div>
          </div>

          <div className="pcBlock pcInboxBlock2">
            <div
              className="pcCard"
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              {!selectedConversation ? (
                <div>Selecione uma conversa para ver as mensagens.</div>
              ) : (
                <>
                  <div>
                    <h3 style={{ marginBottom: 4 }}>
                      {selectedConversation.contact_name || "Sem nome"}
                    </h3>
                    <div
                      style={{
                        color: "var(--pc-text-secondary)",
                        fontSize: 12,
                      }}
                    >
                      Conversa ID: {selectedConversation.id}
                    </div>
                  </div>

                  <div
                    style={{
                      flex: 1,
                      overflowY: "auto",
                      paddingTop: 8,
                      borderTop: "1px solid var(--pc-border)",
                    }}
                  >
                    <ChatBody
                      conversationId={selectedConversation.id}
                      refreshKey={refreshKey}
                    />
                  </div>

                  <Composer
                    conversationId={selectedConversation.id}
                    onSent={handleSent}
                  />
                </>
              )}
            </div>
          </div>

          <div className="pcBlock pcInboxBlock3">
            <div className="pcCard">Bloco 3 (CRM)</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Inbox;
/* caminho: front-app/src/pages/inbox/Inbox.jsx */