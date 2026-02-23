"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/lib/api";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: string | null;
  createdAt: string;
}

const SUGGESTION_CHIPS = [
  "Why is HELLO2-5 stuck?",
  "What's blocking progress?",
  "Sprint status update",
  "What should I prioritize?",
];

export default function LyraChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(api("/api/lyra/chat"));
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
        setLoaded(true);
      }
    } catch {
      // Silently fail on initial load
    }
  }, []);

  useEffect(() => {
    if (!loaded) loadMessages();
  }, [loaded, loadMessages]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || sending) return;

    setInput("");
    setSending(true);

    const tempUserMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: msg,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await fetch(api("/api/lyra/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });

      if (res.ok) {
        const data = await res.json();
        const assistantMsg: ChatMessage = {
          id: `resp-${Date.now()}`,
          role: "assistant",
          content: data.response,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } else {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: "assistant",
            content: `Error: ${err.error || "Something went wrong"}`,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: "Error: Failed to reach Lyra. Check your connection.",
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleNewConversation = () => {
    if (!confirm("Start a new conversation? Current history will be summarized.")) return;
    setMessages([]);
    setLoaded(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const visibleMessages = messages.filter((m) => m.role !== "system");

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-700 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-purple-600 text-xs font-bold text-white">
            L
          </div>
          <span className="text-sm font-semibold text-gray-200">
            Chat with Lyra
          </span>
        </div>
        <button
          onClick={handleNewConversation}
          className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-700 hover:text-gray-300 transition-colors"
          title="New conversation"
        >
          New chat
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 max-h-[calc(100vh-320px)]">
        {visibleMessages.length === 0 && !sending && (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 text-sm">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-600/20 text-purple-400 mb-3">
              L
            </div>
            <p className="mb-3">Ask Lyra anything</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {SUGGESTION_CHIPS.map((chip) => (
                <button
                  key={chip}
                  onClick={() => handleSend(chip)}
                  className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-full transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
        {visibleMessages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-900 text-gray-200"
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{msg.content}</p>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-gray-900 rounded-lg px-3 py-2 text-sm text-gray-400">
              <span className="inline-flex gap-1">
                <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-700 px-4 py-3 shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Lyra..."
            disabled={sending}
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-purple-500 focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || sending}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            Send
          </button>
        </div>
        <div className="mt-1 text-right text-xs text-gray-700">
          {messages.length} messages
        </div>
      </div>
    </div>
  );
}
