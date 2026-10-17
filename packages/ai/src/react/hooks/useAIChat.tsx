'use client';

/**
 * Thin wrapper around `useChat` from `@ai-sdk/react@3` that preserves the
 * historical `{ messages, input, isLoading, sendMessage, ... }` surface used by
 * downstream apps.
 *
 * The SDK handles the UI Message Stream Protocol, retries, abort, and message
 * accumulation. We translate its `UIMessage[]` (parts-based) into the flat
 * `ChatMessage[]` shape and provide a local `input` state that the SDK no
 * longer ships in v3.
 *
 * Server pairing: the API route must return a UI message stream response
 * (`createUIMessageStreamResponse` over `toUIMessageStream`), NOT a text stream response.
 */

import { useCallback, useMemo, useState } from 'react';
import type { UIMessage } from 'ai';
import { DefaultChatTransport } from 'ai';
import { useChat } from '@ai-sdk/react';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
};

export type UseAIChatOptions = {
  apiEndpoint?: string;
  initialMessages?: ChatMessage[];
  onMessage?: (message: ChatMessage) => void;
  onError?: (error: Error) => void;
  /**
   * Retained for API compatibility. The SDK's `useChat` always streams; this
   * option is ignored.
   */
  streamResponse?: boolean;
  context?: Record<string, unknown>;
};

export type UseAIChatReturn = {
  messages: ChatMessage[];
  input: string;
  isLoading: boolean;
  error: Error | null;
  sendMessage: (message?: string) => Promise<void>;
  setInput: (input: string) => void;
  clearMessages: () => void;
  addMessage: (message: ChatMessage) => void;
  removeMessage: (id: string) => void;
  updateMessage: (id: string, content: string) => void;
};

function uiMessageToChatMessage(message: UIMessage): ChatMessage {
  const content = message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('');

  return {
    id: message.id,
    role: message.role,
    content,
  };
}

function chatMessageToUIMessage(message: ChatMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: [{ type: 'text', text: message.content }],
  };
}

export function useAIChat(options: UseAIChatOptions = {}): UseAIChatReturn {
  const {
    apiEndpoint = '/api/ai/chat',
    initialMessages = [],
    onMessage,
    onError,
    context,
  } = options;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: apiEndpoint,
        body: context ? { context } : undefined,
      }),
    [apiEndpoint, context],
  );

  const chat = useChat({
    transport,
    messages: initialMessages.map(chatMessageToUIMessage),
    onError: error => {
      onError?.(error);
    },
    onFinish: ({ message }) => {
      onMessage?.(uiMessageToChatMessage(message));
    },
  });

  const [input, setInput] = useState('');

  const messages = useMemo<ChatMessage[]>(
    () => chat.messages.map(uiMessageToChatMessage),
    [chat.messages],
  );

  const isLoading = chat.status === 'submitted' || chat.status === 'streaming';
  const error = chat.error ?? null;

  const sendMessage = useCallback(
    async (messageText?: string) => {
      const text = (messageText ?? input).trim();
      if (!text) return;

      // Fire onMessage for the user's turn so suggestion-dismissal hooks fire
      // synchronously, matching the prior contract.
      onMessage?.({
        id: `local-${Date.now()}`,
        role: 'user',
        content: text,
      });

      if (!messageText) setInput('');

      await chat.sendMessage({ text });
    },
    [chat, input, onMessage],
  );

  const clearMessages = useCallback(() => {
    chat.setMessages([]);
  }, [chat]);

  const addMessage = useCallback(
    (message: ChatMessage) => {
      chat.setMessages(prev => [...prev, chatMessageToUIMessage(message)]);
    },
    [chat],
  );

  const removeMessage = useCallback(
    (id: string) => {
      chat.setMessages(prev => prev.filter(m => m.id !== id));
    },
    [chat],
  );

  const updateMessage = useCallback(
    (id: string, content: string) => {
      chat.setMessages(prev =>
        prev.map(m =>
          m.id === id ? { ...m, parts: [{ type: 'text', text: content }] } : m,
        ),
      );
    },
    [chat],
  );

  return {
    messages,
    input,
    isLoading,
    error,
    sendMessage,
    setInput,
    clearMessages,
    addMessage,
    removeMessage,
    updateMessage,
  };
}
