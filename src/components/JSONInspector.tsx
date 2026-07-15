import React, { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Terminal } from "lucide-react";

interface JSONInspectorProps {
  librarymanga: any;
  sourcemanga: any;
  mangainfo: any;
}

export function JSONInspector({ librarymanga, sourcemanga, mangainfo }: JSONInspectorProps) {
  const [activeTab, setActiveTab] = useState<"library" | "source" | "info">("library");

  const getTargetData = () => {
    switch (activeTab) {
      case "library":
        return librarymanga;
      case "source":
        return sourcemanga;
      case "info":
        return mangainfo;
    }
  };

  const data = getTargetData();

  // Recursive Tree Node Renderer
  const TreeNode = ({ label, value, depth = 0 }: { label: string | number; value: any; depth?: number; key?: any }) => {
    const [isOpen, setIsOpen] = useState(depth < 1); // Expand the root level automatically
    const isObject = value !== null && typeof value === "object";
    const type = typeof value;

    const toggleOpen = () => {
      if (isObject) setIsOpen(!isOpen);
    };

    const copyNodeValue = (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    };

    if (!isObject) {
      let displayValue = String(value);
      let valColor = "text-amber-300"; // string

      if (value === null) {
        displayValue = "null";
        valColor = "text-zinc-500 font-bold";
      } else if (type === "number") {
        valColor = "text-cyan-400";
      } else if (type === "boolean") {
        valColor = "text-emerald-400 font-semibold";
        displayValue = value ? "true" : "false";
      }

      return (
        <div className="flex items-center gap-1.5 py-0.5 select-text hover:bg-zinc-800/40 rounded px-1 group" style={{ paddingLeft: `${depth * 16 + 4}px` }}>
          <span className="text-zinc-400 font-mono text-xs">{label}:</span>
          <span className={`font-mono text-xs ${valColor} break-all`}>{displayValue}</span>
        </div>
      );
    }

    const isArray = Array.isArray(value);
    const keys = isArray ? value : Object.keys(value);
    const childCount = isArray ? value.length : keys.length;

    return (
      <div className="select-none">
        <div
          onClick={toggleOpen}
          className="flex items-center gap-1.5 py-1 px-1 hover:bg-zinc-800/60 rounded cursor-pointer group"
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
        >
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300" />
          )}
          <span className="text-[#D98A6C] font-mono text-xs font-semibold">{label}:</span>
          <span className="text-zinc-500 text-[10px] font-mono uppercase">
            {isArray ? `Array(${childCount})` : `Object{${childCount}}`}
          </span>
          <button
            onClick={copyNodeValue}
            title="Copy branch JSON"
            className="hidden group-hover:inline-flex items-center ml-2 p-0.5 rounded text-zinc-500 hover:text-[#EAD9C6] hover:bg-zinc-700/50 transition-all"
          >
            <Copy className="w-3 h-3" />
          </button>
        </div>

        {isOpen && (
          <div className="border-l border-zinc-800/40 ml-2.5 my-0.5">
            {isArray
              ? value.map((item: any, idx: number) => (
                  <TreeNode key={idx} label={idx} value={item} depth={depth + 1} />
                ))
              : Object.entries(value).map(([k, v]) => (
                  <TreeNode key={k} label={k} value={v} depth={depth + 1} />
                ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-[#111112] border border-[#27272A] rounded-xl overflow-hidden flex flex-col h-[500px]" id="json-inspector">
      {/* Tabs Header */}
      <div className="bg-[#161618] border-b border-[#27272A] px-4 py-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-[#D98A6C]" />
          <h3 className="text-xs font-bold font-mono text-[#EAD9C6] uppercase tracking-wider">
            Collapsible JSON Inspector
          </h3>
        </div>
        
        <div className="flex gap-1.5 bg-[#121212] p-1 rounded-lg border border-[#27272A]">
          {(["library", "source", "info"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
                activeTab === tab
                  ? "bg-[#D98A6C] text-[#121212]"
                  : "text-zinc-400 hover:text-[#EAD9C6]"
              }`}
            >
              {tab === "library" ? "librarymanga" : tab === "source" ? "sourcemanga" : "mangainfo"}
            </button>
          ))}
        </div>
      </div>

      {/* Body Area */}
      <div className="p-4 flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800/60 font-mono text-xs text-zinc-300">
        {!data ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-2">
            <span className="text-2xl">🔍</span>
            <p className="text-zinc-400 font-semibold text-xs">No active Paperback .pas4 backup parsed.</p>
            <p className="text-zinc-600 text-[11px] max-w-sm">
              Please unzip a .pas4 backup file in the active library panel to inspect real relational entities in real time.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <TreeNode label="ROOT" value={data} />
          </div>
        )}
      </div>
    </div>
  );
}
