import React, { useState, useEffect } from "react";
import { DBDataset, MangaEntry, LibraryEntry } from "../types";
import { AlertTriangle, ChevronRight, Check } from "lucide-react";

interface ConflictResolutionModalProps {
  local: DBDataset;
  remote: DBDataset;
  onResolve: (resolved: DBDataset) => void;
  onCancel: () => void;
}

interface ConflictItem {
  id: string;
  title: string;
  field: "chaptersRead" | "rating" | "notes";
  localVal: any;
  remoteVal: any;
  selected: "local" | "remote";
}

export function ConflictResolutionModal({ local, remote, onResolve, onCancel }: ConflictResolutionModalProps) {
  const [conflicts, setConflicts] = useState<ConflictItem[]>([]);

  useEffect(() => {
    // Compile differences between local and remote datasets
    const list: ConflictItem[] = [];

    local.manga.forEach((lm) => {
      const rm = remote.manga.find((m) => m.id === lm.id);
      if (!rm) return;

      // 1. Check Rating conflicts
      if (lm.rating !== rm.rating) {
        list.push({
          id: lm.id,
          title: lm.title,
          field: "rating",
          localVal: lm.rating,
          remoteVal: rm.rating,
          selected: "local",
        });
      }

      // 2. Check Notes conflicts
      if (lm.notes !== rm.notes) {
        list.push({
          id: lm.id,
          title: lm.title,
          field: "notes",
          localVal: lm.notes,
          remoteVal: rm.notes,
          selected: "local",
        });
      }

      // 3. Check Chapters read conflicts
      const lLib = local.library.find((l) => l.mangaId === lm.id);
      const rLib = remote.library.find((l) => l.mangaId === lm.id);

      if (lLib && rLib && lLib.chaptersRead !== rLib.chaptersRead) {
        list.push({
          id: lm.id,
          title: lm.title,
          field: "chaptersRead",
          localVal: lLib.chaptersRead,
          remoteVal: rLib.chaptersRead,
          selected: "local",
        });
      }
    });

    setConflicts(list);
  }, [local, remote]);

  const handleToggleSelection = (index: number, side: "local" | "remote") => {
    const updated = [...conflicts];
    updated[index].selected = side;
    setConflicts(updated);
  };

  const handleResolveAll = (side: "local" | "remote") => {
    setConflicts((prev) => prev.map((c) => ({ ...c, selected: side })));
  };

  const handleApplyResolution = () => {
    // Clone local dataset as base
    const resolved: DBDataset = JSON.parse(JSON.stringify(local));

    conflicts.forEach((c) => {
      const targetManga = resolved.manga.find((m) => m.id === c.id);
      const targetLib = resolved.library.find((l) => l.mangaId === c.id);

      const valToKeep = c.selected === "local" ? c.localVal : c.remoteVal;

      if (c.field === "rating" && targetManga) {
        targetManga.rating = valToKeep;
      }
      if (c.field === "notes" && targetManga) {
        targetManga.notes = valToKeep;
      }
      if (c.field === "chaptersRead" && targetLib) {
        targetLib.chaptersRead = valToKeep;
        
        // If keeping remote progress, sync history list from remote
        if (c.selected === "remote") {
          const rLib = remote.library.find((l) => l.mangaId === c.id);
          if (rLib) {
            targetLib.history = rLib.history || [];
            targetLib.lastRead = rLib.lastRead;
          }
        }
      }
    });

    // Mark sync metadata to match remote sync timestamps
    resolved.metadata.lastSync = remote.metadata.lastSync;
    onResolve(resolved);
  };

  if (conflicts.length === 0) {
    return (
      <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4">
        <div className="bg-[#161618] border border-[#27272A] p-6 rounded-2xl max-w-sm text-center space-y-4">
          <Check className="w-8 h-8 text-green-400 mx-auto" />
          <h2 className="font-bold text-[#EAD9C6] text-sm uppercase">Timestamps Match</h2>
          <p className="text-zinc-400 text-xs">No logical conflicts identified between local cache and GitHub master file.</p>
          <button onClick={onCancel} className="px-4 py-2 bg-[#27272A] hover:bg-zinc-800 text-zinc-300 rounded font-semibold text-xs cursor-pointer">
            Close Panel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4">
      <div className="bg-[#161618] border border-[#27272A] w-full max-w-2xl rounded-2xl flex flex-col max-h-[85vh] text-xs text-[#EAD9C6]">
        {/* Header */}
        <div className="p-4 border-b border-[#27272A] bg-amber-950/25 flex justify-between items-center rounded-t-2xl">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500 animate-pulse" />
            <div>
              <h2 className="font-extrabold uppercase text-amber-400">Database Sync Conflicts Identified</h2>
              <p className="text-[10px] text-zinc-400 font-normal">GitHub database version is newer than local IndexedDB cache.</p>
            </div>
          </div>
        </div>

        {/* Conflict controls */}
        <div className="px-5 py-3 bg-[#121212] border-b border-[#27272A]/50 flex justify-between items-center">
          <span className="font-semibold text-zinc-500 font-mono">Found {conflicts.length} field discrepancies</span>
          <div className="flex gap-1.5">
            <button
              onClick={() => handleResolveAll("local")}
              className="px-2.5 py-1 bg-[#27272A] hover:bg-zinc-800 border border-[#27272A] rounded font-semibold text-[10px] cursor-pointer"
            >
              Keep All Local
            </button>
            <button
              onClick={() => handleResolveAll("remote")}
              className="px-2.5 py-1 bg-amber-900/40 hover:bg-amber-900 border border-amber-500/30 text-amber-300 rounded font-semibold text-[10px] cursor-pointer"
            >
              Keep All Remote
            </button>
          </div>
        </div>

        {/* Discrepancy Table */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-zinc-800">
          {conflicts.map((c, i) => (
            <div key={i} className="bg-[#121212] rounded-xl border border-[#27272A] p-4 flex flex-col gap-3">
              <div className="flex justify-between items-center border-b border-[#27272A]/40 pb-1.5">
                <span className="font-bold text-zinc-200">{c.title}</span>
                <span className="text-[10px] text-[#D98A6C] uppercase tracking-wider font-semibold font-mono">
                  {c.field === "chaptersRead" ? "Chapters Progress" : c.field === "rating" ? "Star Rating" : "Markdown Notes"}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Local Card */}
                <button
                  onClick={() => handleToggleSelection(i, "local")}
                  className={`p-3 rounded-lg border text-left flex flex-col justify-between transition-all cursor-pointer ${
                    c.selected === "local"
                      ? "bg-[#D98A6C]/15 border-[#D98A6C] text-[#EAD9C6]"
                      : "bg-[#161618] border-[#27272A] text-zinc-500 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex justify-between w-full text-[10px] font-bold text-zinc-400 mb-1">
                    <span>IndexedDB Cache (Local)</span>
                    {c.selected === "local" && <span className="text-[#D98A6C]">ACTIVE</span>}
                  </div>
                  <div className="text-sm font-semibold max-h-16 overflow-y-auto font-mono whitespace-pre-wrap break-words w-full">
                    {c.field === "rating" ? `${c.localVal} Stars` : String(c.localVal)}
                  </div>
                </button>

                {/* Remote Card */}
                <button
                  onClick={() => handleToggleSelection(i, "remote")}
                  className={`p-3 rounded-lg border text-left flex flex-col justify-between transition-all cursor-pointer ${
                    c.selected === "remote"
                      ? "bg-amber-900/20 border-amber-500 text-[#EAD9C6]"
                      : "bg-[#161618] border-[#27272A] text-zinc-500 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex justify-between w-full text-[10px] font-bold text-zinc-400 mb-1">
                    <span>GitHub Master (Remote)</span>
                    {c.selected === "remote" && <span className="text-amber-400 font-bold">ACTIVE</span>}
                  </div>
                  <div className="text-sm font-semibold max-h-16 overflow-y-auto font-mono whitespace-pre-wrap break-words w-full">
                    {c.field === "rating" ? `${c.remoteVal} Stars` : String(c.remoteVal)}
                  </div>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Footer actions */}
        <div className="p-4 border-t border-[#27272A] bg-[#121212] flex justify-end gap-2 rounded-b-2xl">
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-[#27272A] hover:bg-zinc-800 text-zinc-300 hover:text-white rounded font-semibold transition-colors cursor-pointer"
          >
            Cancel Sync
          </button>
          <button
            onClick={handleApplyResolution}
            className="px-4 py-2 bg-[#D98A6C] hover:bg-[#e4a085] text-[#121212] rounded font-bold transition-colors cursor-pointer animate-pulse"
          >
            Apply & Push Merge
          </button>
        </div>

      </div>
    </div>
  );
}
