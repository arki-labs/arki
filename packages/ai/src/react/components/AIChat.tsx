/**
 * Generic AI Chat Component
 */

'use client';

import React, { useEffect, useRef } from 'react';
import type { ChatMessage } from '../hooks/useAIChat';

export type AIChatProps = {
  messages: ChatMessage[];
  input: string;
  isLoading: boolean;
  onInputChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  placeholder?: string;
  className?: string;
  messageClassName?: (message: ChatMessage) => string;
  renderMessage?: (message: ChatMessage) => React.ReactNode;
  renderInput?: (props: {
    input: string;
    onChange: (value: string) => void;
    onSubmit: (e: React.FormEvent) => void;
    isLoading: boolean;
  }) => React.ReactNode;
  autoScroll?: boolean;
}

/**
 * Generic AI Chat Component
 */
export function AIChat({
  messages,
  input,
  isLoading,
  onInputChange,
  onSubmit,
  placeholder = 'Type your message...',
  className = '',
  messageClassName,
  renderMessage,
  renderInput,
  autoScroll = true,
}: AIChatProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, autoScroll]);

  const defaultMessageClassName = (message: ChatMessage) => {
    const baseClasses = 'p-4 rounded-lg mb-2';
    if (message.role === 'user') {
      return `${baseClasses} bg-blue-100 dark:bg-blue-900 ml-auto max-w-[80%]`;
    }
    if (message.role === 'assistant') {
      return `${baseClasses} bg-gray-100 dark:bg-gray-800 mr-auto max-w-[80%]`;
    }
    return baseClasses;
  };

  const defaultRenderMessage = (message: ChatMessage) => (
    <div
      key={message.id}
      className={messageClassName ? messageClassName(message) : defaultMessageClassName(message)}
    >
      <div className="font-semibold text-sm mb-1">
        {message.role === 'user' ? 'You' : 'Assistant'}
      </div>
      <div className="whitespace-pre-wrap">{message.content}</div>
      {message.timestamp && (
        <div className="text-xs text-gray-500 mt-2">
          {new Date(message.timestamp).toLocaleTimeString()}
        </div>
      )}
    </div>
  );

  const defaultRenderInput = () => (
    <form onSubmit={onSubmit} className="flex gap-2 p-4 border-t">
      <input
        type="text"
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        placeholder={placeholder}
        disabled={isLoading}
        className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button
        type="submit"
        disabled={isLoading || !input.trim()}
        className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? 'Sending...' : 'Send'}
      </button>
    </form>
  );

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 mt-8">
            Start a conversation by typing a message below
          </div>
        ) : (
          messages.map((message) =>
            renderMessage ? renderMessage(message) : defaultRenderMessage(message)
          )
        )}
        {isLoading && (
          <div className="p-4 rounded-lg bg-gray-100 dark:bg-gray-800 mr-auto max-w-[80%]">
            <div className="flex gap-1">
              <span className="animate-bounce">•</span>
              <span className="animate-bounce delay-100">•</span>
              <span className="animate-bounce delay-200">•</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {renderInput
        ? renderInput({ input, onChange: onInputChange, onSubmit, isLoading })
        : defaultRenderInput()}
    </div>
  );
}