'use client';

import { useState, useRef, useEffect } from 'react';
import { sendGeminiMessage, ChatMessage, ChatContext } from '@/lib/gemini';
import { markdownToHtml } from '@/lib/markdown';

interface ChatPanelProps {
  context?: ChatContext;
}

export function ChatPanel({ context }: ChatPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      role: 'user',
      text: input,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await sendGeminiMessage([...messages, userMessage], context);
      
      const assistantMessage: ChatMessage = {
        role: 'model',
        text: response,
        timestamp: Date.now(),
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: ChatMessage = {
        role: 'model',
        text: `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const clearChat = () => {
    setMessages([]);
  };

  return (
    <>
      {/* Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? 'Close chat' : 'Open chat'}
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          background: 'var(--accent-2)',
          color: 'white',
          border: 'none',
          fontSize: '24px',
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          zIndex: 999,
          transition: 'all 0.2s',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isOpen ? '✕' : '💬'}
      </button>

      {/* Chat Panel */}
      <div
        style={{
          position: 'fixed',
          bottom: '96px',
          right: '24px',
          width: '380px',
          height: '600px',
          background: 'white',
          borderRadius: '12px',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15)',
          display: 'flex',
          flexDirection: 'column',
          transform: isOpen ? 'translateX(0)' : 'translateX(420px)',
          transition: 'transform 0.3s ease',
          zIndex: 998,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            background: 'var(--accent-2)',
            color: 'white',
            padding: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '15px' }}>
            <span style={{ fontSize: '20px' }}>🤖</span>
            <span>tapestr.ai Assistant</span>
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              onClick={clearChat}
              title="Clear chat"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'white',
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: '4px',
                fontSize: '16px',
                transition: 'background 0.2s',
              }}
            >
              🗑️
            </button>
            <button
              onClick={() => setIsOpen(false)}
              title="Close"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'white',
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: '4px',
                fontSize: '16px',
                transition: 'background 0.2s',
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Messages */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          {messages.length === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                textAlign: 'center',
                color: 'var(--ink-3)',
                gap: '12px',
              }}
            >
              <div style={{ fontSize: '48px' }}>👋</div>
              <div style={{ fontSize: '14px', lineHeight: 1.5, maxWidth: '280px' }}>
                Hi! I'm your tapestr.ai MDM assistant. Ask me about entities, data quality, lineage, or anything else!
              </div>
            </div>
          )}
          {messages.map((msg, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                gap: '8px',
                animation: 'slideIn 0.2s ease',
                flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
              }}
            >
              <div style={{ fontSize: '24px', flexShrink: 0 }}>
                {msg.role === 'user' ? '👤' : '🤖'}
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  maxWidth: '280px',
                  alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                <div
                  style={{
                    background: msg.role === 'user' ? 'var(--accent-2)' : 'var(--bg-alt)',
                    color: msg.role === 'user' ? 'white' : 'inherit',
                    padding: '10px 14px',
                    borderRadius: '12px',
                    fontSize: '14px',
                    lineHeight: 1.5,
                    wordWrap: 'break-word',
                  }}
                >
                  {msg.role === 'user' ? (
                    msg.text
                  ) : (
                    <div 
                      className="markdown-content"
                      dangerouslySetInnerHTML={{ __html: markdownToHtml(msg.text) }}
                    />
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}
          {isLoading && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <div style={{ fontSize: '24px', flexShrink: 0 }}>🤖</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '280px' }}>
                <div
                  style={{
                    background: 'var(--bg-alt)',
                    padding: '12px 14px',
                    borderRadius: '12px',
                    display: 'flex',
                    gap: '4px',
                  }}
                >
                  <span style={{ width: '8px', height: '8px', background: 'var(--ink-3)', borderRadius: '50%', animation: 'typing 1.4s infinite' }}></span>
                  <span style={{ width: '8px', height: '8px', background: 'var(--ink-3)', borderRadius: '50%', animation: 'typing 1.4s infinite 0.2s' }}></span>
                  <span style={{ width: '8px', height: '8px', background: 'var(--ink-3)', borderRadius: '50%', animation: 'typing 1.4s infinite 0.4s' }}></span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div
          style={{
            padding: '12px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            gap: '8px',
            background: 'var(--bg)',
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="Ask me anything..."
            rows={2}
            disabled={isLoading}
            style={{
              flex: 1,
              background: 'white',
              border: '1px solid var(--line)',
              borderRadius: '8px',
              padding: '10px 12px',
              fontSize: '14px',
              fontFamily: 'inherit',
              resize: 'none',
              transition: 'border-color 0.2s',
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            style={{
              width: '44px',
              height: '44px',
              background: 'var(--accent-2)',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '18px',
              cursor: 'pointer',
              transition: 'all 0.2s',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !input.trim() || isLoading ? 0.5 : 1,
            }}
          >
            {isLoading ? '⏳' : '➤'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes typing {
          0%, 60%, 100% {
            transform: translateY(0);
            opacity: 0.7;
          }
          30% {
            transform: translateY(-8px);
            opacity: 1;
          }
        }
      `}</style>
    </>
  );
}
