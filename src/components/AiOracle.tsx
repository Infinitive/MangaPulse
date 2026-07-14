import React, { useState, useRef, useEffect } from "react";
import { DBDataset } from "../types";
import { Brain, Send, X, Sparkles, MessageSquare, ArrowRight } from "lucide-react";

interface AiOracleProps {
  dataset: DBDataset;
  isOpen: boolean;
  onClose: () => void;
}

interface Message {
  role: "user" | "oracle";
  text: string;
}

export function AiOracle({ dataset, isOpen, onClose }: AiOracleProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "oracle",
      text: "Greetings! I am your MangaPulse AI Oracle. I have synchronized with your local IndexedDB reading records and GitHub backups. I am loaded with deep thinking reasoning capabilities. Ask me about your reading momentum, request recommendations based on your ratings, or ask me to summarize your personal notes!",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  if (!isOpen) return null;

  const handleSend = async (customPrompt?: string) => {
    const promptToSend = customPrompt || input;
    if (!promptToSend.trim() || loading) return;

    const userMsg: Message = { role: "user", text: promptToSend };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptToSend,
          dataset,
        }),
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to reach AI Oracle");
      }

      setMessages((prev) => [
        ...prev,
        { role: "oracle", text: data.reply || "I apologize, but my gears slipped. Could you ask again?" },
      ]);
    } catch (error: any) {
      console.error("AI Oracle query failed", error);
      setMessages((prev) => [
        ...prev,
        {
          role: "oracle",
          text: `⚠️ Oracle Sync Error: ${error.message || "Please make sure your server is running and your GEMINI_API_KEY is defined in the Secrets panel."}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const quickPrompts = [
    { label: "Analyze my reading velocities", text: "Please look at my 7-day, 30-day, and lifetime velocities. Evaluate my momentum and suggest a healthy reading pace." },
    { label: "Recommend what to read next", text: "Based on my completed titles, highest ratings, and favorite genres, recommend what I should pick up next from my 'Planned' list or external popular series." },
    { label: "Audit stalled manga lists", text: "Audit all my stalled series. Which ones should I consider moving to 'Dropped', and which ones look like they are just on natural publication hiatus?" },
    { label: "Summarize my review notes", text: "Look over my reading notes, reviews, and ratings. Synthesize a brief journal summarizing my overall tastes and notes themes." },
  ];

  return (
    <div
      className="fixed inset-y-0 right-0 w-full sm:w-[480px] bg-[#121212] border-l border-[#27272A] shadow-2xl z-50 flex flex-col transition-all duration-300 transform translate-x-0"
      id="ai-oracle-sidebar"
    >
      {/* Drawer Header */}
      <div className="p-4 border-b border-[#27272A] bg-[#161618] flex justify-between items-center">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded bg-[#D98A6C]/15 border border-[#D98A6C]/30 text-[#D98A6C]">
            <Brain className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-[#EAD9C6] uppercase tracking-wide flex items-center gap-1.5">
              AI Oracle <Sparkles className="w-3.5 h-3.5 text-[#D98A6C]" />
            </h2>
            <p className="text-[10px] text-zinc-400">Powered by gemini-3.1-pro-preview (Thinking: HIGH)</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-[#27272A] rounded-md text-zinc-400 hover:text-[#EAD9C6] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Messages Scroll Panel */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4 scrollbar-thin scrollbar-thumb-zinc-800">
        {messages.map((m, idx) => (
          <div key={idx} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-xl p-3.5 text-xs leading-relaxed ${
                m.role === "user"
                  ? "bg-[#D98A6C] text-[#121212] rounded-br-none font-medium"
                  : "bg-[#161618] text-[#EAD9C6] border border-[#27272A] rounded-bl-none shadow"
              }`}
            >
              {m.role === "oracle" && (
                <div className="flex items-center gap-1 text-[9px] text-[#D98A6C] uppercase font-bold tracking-wider mb-1.5">
                  <Brain className="w-3 h-3" /> Oracle Response
                </div>
              )}
              {/* Basic inline markdown parser helper for chat bubble */}
              <div className="whitespace-pre-line space-y-1">
                {m.text.split("\n").map((line, lIdx) => {
                  if (line.startsWith("### ")) {
                    return <h4 key={lIdx} className="font-bold text-[#EAD9C6] mt-2 mb-1">{line.replace("### ", "")}</h4>;
                  }
                  if (line.startsWith("**") && line.endsWith("**")) {
                    return <p key={lIdx} className="font-bold text-[#EAD9C6]">{line.replace(/\*\*/g, "")}</p>;
                  }
                  return <p key={lIdx}>{line}</p>;
                })}
              </div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-xl rounded-bl-none p-3.5 bg-[#161618] border border-[#27272A] text-xs text-[#EAD9C6] space-y-2">
              <div className="flex items-center gap-1.5 text-[#D98A6C] font-semibold animate-pulse">
                <Brain className="w-3.5 h-3.5 animate-spin" /> Thinking process active...
              </div>
              <div className="space-y-1 animate-pulse">
                <div className="h-2 bg-[#27272A] rounded w-3/4"></div>
                <div className="h-2 bg-[#27272A] rounded w-5/6"></div>
                <div className="h-2 bg-[#27272A] rounded w-2/3"></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick suggestions panel */}
      {messages.length === 1 && (
        <div className="p-4 border-t border-[#27272A] bg-[#161618]/50 space-y-2">
          <p className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider mb-1">Analytical Inquiries</p>
          <div className="grid grid-cols-1 gap-2">
            {quickPrompts.map((p, idx) => (
              <button
                key={idx}
                onClick={() => handleSend(p.text)}
                className="text-left text-[11px] px-3 py-2 bg-[#161618] border border-[#27272A] rounded-lg text-zinc-300 hover:text-[#EAD9C6] hover:border-[#D98A6C] transition-all flex justify-between items-center group cursor-pointer"
              >
                <span>{p.label}</span>
                <ArrowRight className="w-3.5 h-3.5 text-zinc-500 group-hover:text-[#D98A6C] transition-colors" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input panel */}
      <div className="p-4 border-t border-[#27272A] bg-[#161618] flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Consult the Oracle..."
          className="flex-1 bg-[#121212] border border-[#27272A] rounded-lg px-3.5 py-2 text-xs text-[#EAD9C6] placeholder-zinc-500 focus:outline-none focus:border-[#D98A6C]"
        />
        <button
          onClick={() => handleSend()}
          disabled={!input.trim() || loading}
          className="p-2 bg-[#D98A6C] text-[#121212] hover:bg-[#e4a085] disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg transition-colors flex items-center justify-center cursor-pointer"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
