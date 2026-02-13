'use client';

/**
 * React hook for AI chat functionality
 */

import { useState, useCallback, useRef, useEffect } from 'react';
// Removed unused import - Message type from 'ai' package not used in this file

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
  metadata?: Record<string, unknown>;
}

export type UseAIChatOptions = {
  apiEndpoint?: string;
  initialMessages?: ChatMessage[];
  onMessage?: (message: ChatMessage) => void;
  onError?: (error: Error) => void;
  streamResponse?: boolean;
  context?: Record<string, unknown>;
}

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
}

/**
 * Custom hook for AI chat interactions
 */
export function useAIChat(options: UseAIChatOptions = {}): UseAIChatReturn {
  const {
    apiEndpoint = '/api/ai/chat',
    initialMessages = [],
    onMessage,
    onError,
    streamResponse = true,
    context = {},
  } = options;

  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Generate unique message ID
   */
  const generateId = useCallback(() => {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }, []);

  /**
   * Send a message to the AI
   */
  const sendMessage = useCallback(async (messageText?: string) => {
    const text = messageText || input;
    if (!text.trim()) return;

    setIsLoading(true);
    setError(null);

    // Add user message
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    if (onMessage) onMessage(userMessage);

    // Clear input if using default
    if (!messageText) {
      setInput('');
    }

    try {
      // Cancel any previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();

      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(msg => ({
            role: msg.role,
            content: msg.content,
          })),
          context,
          stream: streamResponse,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (streamResponse && response.body) {
        // Handle streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const assistantMessageId = generateId();
        let assistantContent = '';

        // Add empty assistant message
        const assistantMessage: ChatMessage = {
          id: assistantMessageId,
          role: 'assistant',
          content: '',
          timestamp: new Date(),
        };

        setMessages(prev => [...prev, assistantMessage]);

        try {
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Decode the chunk and add to buffer
            buffer += decoder.decode(value, { stream: true });

            // Process complete lines (AI SDK Data Stream Protocol uses \n as delimiter)
            const lines = buffer.split('\n');

            // Keep the last potentially incomplete line in the buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line) continue;

              // AI SDK Data Stream Protocol format: TYPE:VALUE
              // 0 = text chunk, 3 = error, d = finish message
              const colonIndex = line.indexOf(':');
              if (colonIndex === -1) continue;

              const type = line.slice(0, colonIndex);
              const value = line.slice(colonIndex + 1);

              try {
                switch (type) {
                  case '0': {
                    // Text chunk - value is JSON-stringified string
                    const text = JSON.parse(value) as string;
                    assistantContent += text;

                    // Update message content
                    setMessages(prev =>
                      prev.map(msg =>
                        msg.id === assistantMessageId
                          ? { ...msg, content: assistantContent }
                          : msg
                      )
                    );
                    break;
                  }
                  case '3': {
                    // Error - value is JSON-stringified error message
                    const errorMessage = JSON.parse(value) as string;
                    throw new Error(errorMessage);
                  }
                  case 'd': {
                    // Finish message - stream is complete
                    // Could extract finishReason from value if needed
                    break;
                  }
                  // Other types (2 = data, e = message annotations, etc.) can be added as needed
                }
              } catch (parseError) {
                if (parseError instanceof SyntaxError) {
                  // JSON parse error - could be incomplete chunk, skip
                  continue;
                }
                throw parseError;
              }
            }
          }

          // Process any remaining data in the buffer
          if (buffer) {
            const colonIndex = buffer.indexOf(':');
            if (colonIndex !== -1) {
              const type = buffer.slice(0, colonIndex);
              const value = buffer.slice(colonIndex + 1);

              if (type === '0') {
                try {
                  const text = JSON.parse(value) as string;
                  assistantContent += text;
                  setMessages(prev =>
                    prev.map(msg =>
                      msg.id === assistantMessageId
                        ? { ...msg, content: assistantContent }
                        : msg
                    )
                  );
                } catch {
                  // Ignore parse errors for final buffer
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        if (onMessage) {
          onMessage({ ...assistantMessage, content: assistantContent });
        }
      } else {
        // Handle non-streaming response
        const data = await response.json();
        const assistantMessage: ChatMessage = {
          id: generateId(),
          role: 'assistant',
          content: data.content || data.message || '',
          timestamp: new Date(),
        };

        setMessages(prev => [...prev, assistantMessage]);
        if (onMessage) onMessage(assistantMessage);
      }
    } catch (error_) {
      if (error_ instanceof Error && error_.name !== 'AbortError') {
        setError(error_);
        if (onError) onError(error_);
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  }, [
    input,
    messages,
    apiEndpoint,
    context,
    streamResponse,
    generateId,
    onMessage,
    onError,
  ]);

  /**
   * Clear all messages
   */
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  /**
   * Add a message manually
   */
  const addMessage = useCallback((message: ChatMessage) => {
    setMessages(prev => [...prev, message]);
  }, []);

  /**
   * Remove a message by ID
   */
  const removeMessage = useCallback((id: string) => {
    setMessages(prev => prev.filter(msg => msg.id !== id));
  }, []);

  /**
   * Update a message content
   */
  const updateMessage = useCallback((id: string, content: string) => {
    setMessages(prev =>
      prev.map(msg =>
        msg.id === id ? { ...msg, content } : msg
      )
    );
  }, []);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

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