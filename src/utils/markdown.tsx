import React from "react";

/**
 * Parses inline markdown tokens: **bold**, *italics*, [label](url).
 */
export function parseInlineMarkdown(text: string): React.ReactNode[] {
  if (!text) return [];

  // Tokenize the string using regexes
  let tokens: Array<{ type: "text" | "bold" | "italic" | "link"; content: string; url?: string }> = [
    { type: "text", content: text },
  ];

  // 1. Parse Bold (**text**)
  let tempTokens: typeof tokens = [];
  tokens.forEach((t) => {
    if (t.type !== "text") {
      tempTokens.push(t);
      return;
    }
    const parts = t.content.split(/\*\*([^*]+)\*\*/g);
    parts.forEach((part, index) => {
      if (index % 2 === 1) {
        tempTokens.push({ type: "bold", content: part });
      } else if (part) {
        tempTokens.push({ type: "text", content: part });
      }
    });
  });
  tokens = tempTokens;

  // 2. Parse Italics (*text*)
  tempTokens = [];
  tokens.forEach((t) => {
    if (t.type !== "text") {
      tempTokens.push(t);
      return;
    }
    const parts = t.content.split(/\*([^*]+)\*/g);
    parts.forEach((part, index) => {
      if (index % 2 === 1) {
        tempTokens.push({ type: "italic", content: part });
      } else if (part) {
        tempTokens.push({ type: "text", content: part });
      }
    });
  });
  tokens = tempTokens;

  // 3. Parse Links ([label](url))
  tempTokens = [];
  tokens.forEach((t) => {
    if (t.type !== "text") {
      tempTokens.push(t);
      return;
    }
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match;

    while ((match = linkRegex.exec(t.content)) !== null) {
      const matchIndex = match.index;
      if (matchIndex > lastIndex) {
        tempTokens.push({ type: "text", content: t.content.slice(lastIndex, matchIndex) });
      }
      tempTokens.push({ type: "link", content: match[1], url: match[2] });
      lastIndex = linkRegex.lastIndex;
    }
    if (lastIndex < t.content.length) {
      tempTokens.push({ type: "text", content: t.content.slice(lastIndex) });
    }
  });
  tokens = tempTokens;

  // Map tokens to React elements
  return tokens.map((t, i) => {
    switch (t.type) {
      case "bold":
        return <strong key={i} className="font-extrabold text-[#EAD9C6]">{t.content}</strong>;
      case "italic":
        return <em key={i} className="italic text-zinc-300">{t.content}</em>;
      case "link":
        return (
          <a
            key={i}
            href={t.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#D98A6C] underline hover:text-[#e4a085] cursor-pointer"
          >
            {t.content}
          </a>
        );
      default:
        return t.content;
    }
  });
}

/**
 * Renders block and inline markdown into a beautifully styled React tree.
 */
export function renderMarkdown(markdown: string): React.ReactNode {
  if (!markdown) return <p className="text-zinc-500 italic">No notes captured yet.</p>;

  const lines = markdown.split("\n");
  const elements: React.ReactNode[] = [];

  lines.forEach((line, i) => {
    const trimmed = line.trim();

    // 1. Headings
    if (trimmed.startsWith("### ")) {
      elements.push(
        <h4 key={i} className="text-sm font-semibold text-[#EAD9C6] mt-4 mb-2 uppercase tracking-wide">
          {parseInlineMarkdown(trimmed.slice(4))}
        </h4>
      );
    } else if (trimmed.startsWith("## ")) {
      elements.push(
        <h3 key={i} className="text-base font-bold text-[#EAD9C6] mt-5 mb-2 border-b border-[#27272A] pb-1">
          {parseInlineMarkdown(trimmed.slice(3))}
        </h3>
      );
    } else if (trimmed.startsWith("# ")) {
      elements.push(
        <h2 key={i} className="text-lg font-extrabold text-[#EAD9C6] mt-6 mb-3">
          {parseInlineMarkdown(trimmed.slice(2))}
        </h2>
      );
    }
    // 2. Lists
    else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      elements.push(
        <ul key={i} className="list-disc pl-5 my-1">
          <li className="text-sm text-zinc-300">
            {parseInlineMarkdown(trimmed.slice(2))}
          </li>
        </ul>
      );
    }
    // 3. Regular Paragraphs
    else {
      elements.push(
        <p key={i} className="text-sm text-zinc-300 leading-relaxed mb-2 min-h-[1.2rem]">
          {parseInlineMarkdown(line)}
        </p>
      );
    }
  });

  return <div className="space-y-1">{elements}</div>;
}
