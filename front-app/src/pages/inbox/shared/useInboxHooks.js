/* caminho: front-app/src/pages/inbox/shared/useInboxHooks.js */
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../../services/api";

export function useInboxConversations() {
  const [conversations, setConversations] = useState([]);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [errorConversations, setErrorConversations] = useState(null);

  const loadConversations = useCallback(async () => {
    setLoadingConversations(true);
    setErrorConversations(null);
    try {
      const data = await apiRequest("/inbox/conversations?limit=50");
      setConversations(data.data || []);
    } catch (err) {
      setErrorConversations(err.message);
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  return {
    conversations,
    loadingConversations,
    errorConversations,
    reloadConversations: loadConversations,
  };
}

export function useInboxMessages(conversationId) {
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [errorMessages, setErrorMessages] = useState(null);

  const loadMessages = useCallback(async () => {
    if (!conversationId) return;
    setLoadingMessages(true);
    setErrorMessages(null);
    try {
      const data = await apiRequest(
        `/inbox/conversations/${conversationId}/messages?limit=50`
      );
      setMessages(data.data || []);
    } catch (err) {
      setErrorMessages(err.message);
    } finally {
      setLoadingMessages(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (conversationId) loadMessages();
  }, [conversationId, loadMessages]);

  const sendMessage = useCallback(
    async (content) => {
      if (!conversationId) throw new Error("CONVERSATION_NOT_SELECTED");
      const payload = { content };

      const data = await apiRequest(`/inbox/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      // recarrega mensagens após envio
      await loadMessages();
      return data;
    },
    [conversationId, loadMessages]
  );

  return {
    messages,
    loadingMessages,
    errorMessages,
    reloadMessages: loadMessages,
    sendMessage,
  };
}
/* caminho: front-app/src/pages/inbox/shared/useInboxHooks.js */