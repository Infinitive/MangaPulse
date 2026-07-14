import React, { useState, useEffect } from "react";
import { DBDataset, MangaEntry, LibraryEntry, MangaStatus } from "../types";
import { renderMarkdown } from "../utils/markdown";
import {
  calculateTimeToCompletion,
  predictNextRelease,
  calculateStallDecay,
  isTitleOnHiatus,
} from "../utils/analytics";
import { Star, Clock, AlertTriangle, Calendar, RefreshCw, X, Save, Edit3, Trash2 } from "lucide-react";

interface ContextPanelProps {
  manga: MangaEntry;
  libraryEntry: LibraryEntry | undefined;
  lifetimeVelocity: number;
  onClose: () => void;
  onSaveManga: (updated: MangaEntry) => void;
  onUpdateProgress: (mangaId: string, chaptersRead: number) => void;
  onDeleteManga: (mangaId: string) => void;
}

export function ContextPanel({
  manga,
  libraryEntry,
  lifetimeVelocity,
  onClose,
  onSaveManga,
  onUpdateProgress,
  onDeleteManga,
}: ContextPanelProps) {
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesText, setNotesText] = useState(manga.notes || "");
  const [userRating, setUserRating] = useState(manga.rating || 0);
  const [progressInput, setProgressInput] = useState(libraryEntry?.chaptersRead || 0);

  useEffect(() => {
    setNotesText(manga.notes || "");
    setUserRating(manga.rating || 0);
    setProgressInput(libraryEntry?.chaptersRead || 0);
  }, [manga, libraryEntry]);

  // Calculations
  const timeData = calculateTimeToCompletion(manga, libraryEntry, lifetimeVelocity);
  const prediction = libraryEntry ? predictNextRelease(libraryEntry.history || [], libraryEntry.lastRead) : null;
  const isOnHiatus = isTitleOnHiatus(manga.title);

  // Weekly momentum decay
  const historyList = libraryEntry?.history || [];
  const decayCounts = calculateStallDecay(historyList, libraryEntry?.lastRead || 0);
  const maxDecay = Math.max(...decayCounts, 1);

  // Stall flag calculation
  const lastActivity = libraryEntry?.lastRead || manga.addedDate;
  const daysSinceActivity = Math.round((Math.floor(Date.now() / 1000) - lastActivity) / (24 * 3600));

  const handleSaveNotesAndRating = () => {
    onSaveManga({
      ...manga,
      notes: notesText,
      rating: userRating,
    });
    setIsEditingNotes(false);
  };

  const handleQuickStatusChange = (newStatus: MangaStatus) => {
    onSaveManga({
      ...manga,
      status: newStatus,
      lastRead: Math.floor(Date.now() / 1000),
    });
  };

  const incrementProgress = () => {
    const nextVal = progressInput + 1;
    setProgressInput(nextVal);
    onUpdateProgress(manga.id, nextVal);
  };

  const decrementProgress = () => {
    if (progressInput > 0) {
      const nextVal = progressInput - 1;
      setProgressInput(nextVal);
      onUpdateProgress(manga.id, nextVal);
    }
  };

  return (
    <div
      className="fixed inset-y-0 right-0 w-full md:w-[600px] bg-[#121212] border-l border-[#27272A] shadow-2xl z-40 flex flex-col"
      id="manga-context-panel"
    >
      {/* Panel Header */}
      <div className="p-4 border-b border-[#27272A] bg-[#161618] flex justify-between items-center">
        <div className="flex items-center gap-3">
          <span className="text-xs px-2 py-1 rounded bg-[#27272A] text-[#D98A6C] font-semibold border border-[#D98A6C]/20 uppercase">
            {manga.status}
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">ID: {manga.id}</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-[#27272A] rounded-md text-zinc-400 hover:text-[#EAD9C6] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Panel Contents Scrollable */}
      <div className="flex-1 p-5 overflow-y-auto space-y-6 scrollbar-thin scrollbar-thumb-zinc-800 text-xs">
        {/* Core Layout: Cover & Basic fields */}
        <div className="flex gap-4">
          <div className="w-28 h-40 bg-[#161618] rounded-lg overflow-hidden border border-[#27272A] shrink-0 relative shadow-md">
            {manga.coverUrl ? (
              <img
                src={manga.coverUrl}
                alt={manga.title}
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-zinc-600 text-2xl font-bold">
                📖
              </div>
            )}
          </div>
          <div className="space-y-2 flex-1 min-w-0">
            <h1 className="text-base font-extrabold text-[#EAD9C6] tracking-tight truncate leading-tight">
              {manga.title}
            </h1>
            <p className="text-zinc-400 font-medium">{manga.author || "Unknown Author"}</p>
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Source: {manga.sourceId}</p>

            {/* Star Rating selector */}
            <div className="flex items-center gap-1 py-1">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => setUserRating(star)}
                  className="p-0.5 hover:scale-110 transition-transform cursor-pointer"
                >
                  <Star
                    className={`w-4 h-4 ${
                      star <= userRating ? "text-[#D98A6C] fill-[#D98A6C]" : "text-zinc-600"
                    }`}
                  />
                </button>
              ))}
            </div>

            {/* Quick Status Pill selector */}
            <div className="flex flex-wrap gap-1.5 pt-2">
              {(["reading", "planned", "completed", "dropped", "archived"] as MangaStatus[]).map((st) => (
                <button
                  key={st}
                  onClick={() => handleQuickStatusChange(st)}
                  className={`px-2 py-1 rounded text-[10px] font-semibold border transition-all cursor-pointer ${
                    manga.status === st
                      ? "bg-[#D98A6C] text-[#121212] border-[#D98A6C]"
                      : "bg-[#161618] text-zinc-400 border-[#27272A] hover:border-zinc-600"
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Dead End Warning Banner (>90 Days Stalled) */}
        {manga.status === "reading" && daysSinceActivity > 90 && (
          <div className="p-3.5 bg-red-950/20 border border-red-500/30 rounded-xl text-red-200 flex gap-2.5 items-start animate-pulse">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold">Dead End Recommendation</p>
              <p className="text-[10px] text-red-300">
                This series has seen no activity for {daysSinceActivity} days. Consider shelving or archiving it.
              </p>
              <button
                onClick={() => handleQuickStatusChange("dropped")}
                className="mt-2 px-3 py-1 bg-red-900/60 hover:bg-red-800 text-white rounded text-[10px] font-semibold border border-red-700 transition-colors cursor-pointer"
              >
                Mark as Dropped
              </button>
            </div>
          </div>
        )}

        {/* Hiatus Override Banner */}
        {manga.status === "reading" && daysSinceActivity > 14 && isOnHiatus && (
          <div className="p-3 bg-zinc-900 border border-amber-500/30 rounded-xl text-amber-200 flex gap-2.5 items-center">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <p className="text-[10px]">
              <strong>Hiatus Override Active:</strong> &quot;{manga.title}&quot; is on the publication hiatus index. Stall warnings are bypassed.
            </p>
          </div>
        )}

        {/* Progress Tracker Widget */}
        <div className="bg-[#161618] p-4 rounded-xl border border-[#27272A]">
          <h3 className="font-semibold text-zinc-400 mb-3 uppercase tracking-wider text-[10px]">Library Reading Progress</h3>
          <div className="flex justify-between items-center">
            <div className="space-y-1">
              <span className="text-xl font-extrabold text-[#EAD9C6] font-mono">
                {progressInput}
              </span>
              <span className="text-zinc-500 text-[10px] font-mono"> / {manga.totalChapters || "∞"} chapters</span>
              {manga.totalChapters > 0 && (
                <div className="w-36 h-1.5 bg-[#121212] rounded-full overflow-hidden mt-1">
                  <div
                    style={{ width: `${Math.min(100, (progressInput / manga.totalChapters) * 100)}%` }}
                    className="h-full bg-[#D98A6C]"
                  />
                </div>
              )}
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={decrementProgress}
                className="w-8 h-8 rounded bg-[#121212] hover:bg-[#27272A] border border-[#27272A] text-[#EAD9C6] flex items-center justify-center font-bold font-mono transition-colors cursor-pointer"
              >
                -
              </button>
              <button
                onClick={incrementProgress}
                className="w-12 h-8 rounded bg-[#D98A6C] hover:bg-[#e4a085] text-[#121212] flex items-center justify-center font-bold font-mono transition-colors cursor-pointer"
              >
                +1
              </button>
            </div>
          </div>
        </div>

        {/* Dynamic Analytics Block */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Time to Completion & Difficulty */}
          <div className="bg-[#161618] p-4 rounded-xl border border-[#27272A] space-y-2">
            <h4 className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-[#D98A6C]" /> Velocity Metrics
            </h4>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span className="text-zinc-400">TimeToComplete:</span>
                <span className="text-[#EAD9C6] font-semibold">{timeData.estimateStr}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-400">Difficulty Class:</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                    timeData.difficultyClass === "Hard"
                      ? "bg-red-900/30 text-red-300 border border-red-700/20"
                      : timeData.difficultyClass === "Medium"
                        ? "bg-amber-900/30 text-amber-300 border border-amber-700/20"
                        : "bg-green-900/30 text-green-300 border border-green-700/20"
                  }`}
                >
                  {timeData.difficultyClass}
                </span>
              </div>
              <div className="text-[9px] text-zinc-500 font-mono text-right">Score: {timeData.difficultyScore}</div>
            </div>
          </div>

          {/* Release Schedule predictor */}
          <div className="bg-[#161618] p-4 rounded-xl border border-[#27272A] space-y-2">
            <h4 className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-[#D98A6C]" /> Release Schedule
            </h4>
            {prediction ? (
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-zinc-400">Predicted Next:</span>
                  <span className="text-[#EAD9C6] font-bold">{prediction.predictedDate}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Confidence level:</span>
                  <span
                    className={`font-semibold ${
                      prediction.confidence === "High"
                        ? "text-green-400"
                        : prediction.confidence === "Medium"
                          ? "text-amber-400"
                          : "text-red-400"
                    }`}
                  >
                    {prediction.confidence}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-zinc-500 italic text-[10px]">No historical data points to schedule next chapter drops.</p>
            )}
          </div>
        </div>

        {/* Weekly Momentum Decay SVG line chart */}
        {historyList.length > 0 && (
          <div className="bg-[#161618] p-4 rounded-xl border border-[#27272A] space-y-3">
            <h4 className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Weekly Momentum Decay (last 8 weeks)</h4>
            <div className="h-20 flex items-end gap-1.5 pb-2 border-b border-[#27272A]/50">
              {decayCounts.map((val, idx) => {
                const pct = (val / maxDecay) * 80; // keep some headspace
                return (
                  <div key={idx} className="flex-1 flex flex-col justify-end items-center h-full group relative">
                    <div
                      style={{ height: `${pct}%` }}
                      className="w-full bg-[#D98A6C]/85 rounded-t-sm group-hover:bg-[#EAD9C6] transition-colors"
                    />
                    <div className="hidden group-hover:block absolute bottom-full mb-1 bg-black text-[#EAD9C6] text-[9px] px-1.5 py-0.5 rounded border border-[#27272A] whitespace-nowrap z-10">
                      W{8 - idx}: {val} chapters
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[9px] text-zinc-500 mt-1">
              <span>8 weeks ago</span>
              <span>Reading Momentum</span>
              <span>Last read week</span>
            </div>
          </div>
        )}

        {/* Description / plot info */}
        {manga.plot && (
          <div className="space-y-1.5">
            <h3 className="font-bold text-[#EAD9C6] uppercase tracking-wide text-[10px]">Synopsis</h3>
            <p className="text-zinc-400 leading-relaxed max-h-24 overflow-y-auto text-[11px] pr-1">
              {manga.plot}
            </p>
          </div>
        )}

        {/* Serialization details */}
        {manga.serialization && (
          <div className="space-y-1.5 bg-[#161618] p-3 rounded-lg border border-[#27272A]/50">
            <h4 className="text-[9px] text-zinc-500 uppercase font-bold">Serialization Meta</h4>
            <p className="text-zinc-300">{manga.serialization}</p>
          </div>
        )}

        {/* Markdown reading notes editor & preview panel */}
        <div className="bg-[#161618] p-4 rounded-xl border border-[#27272A] space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-bold text-[#EAD9C6] uppercase tracking-wide text-[10px] flex items-center gap-1">
              <Edit3 className="w-3.5 h-3.5 text-[#D98A6C]" /> Reading Notes (Markdown)
            </h3>
            {isEditingNotes ? (
              <button
                onClick={handleSaveNotesAndRating}
                className="flex items-center gap-1 px-2.5 py-1 bg-[#D98A6C] hover:bg-[#e4a085] text-[#121212] rounded font-semibold text-[10px] transition-colors cursor-pointer"
              >
                <Save className="w-3 h-3" /> Save Changes
              </button>
            ) : (
              <button
                onClick={() => setIsEditingNotes(true)}
                className="px-2.5 py-1 bg-[#27272A] hover:bg-zinc-800 text-zinc-300 hover:text-[#EAD9C6] rounded border border-[#27272A] text-[10px] font-semibold transition-all cursor-pointer"
              >
                Edit Notes
              </button>
            )}
          </div>

          {isEditingNotes ? (
            <div className="space-y-2">
              <textarea
                value={notesText}
                onChange={(e) => setNotesText(e.target.value)}
                placeholder="Compose thoughts in markdown... Support: **bold**, *italics*, lists (-), links [label](url)"
                rows={6}
                className="w-full bg-[#121212] text-zinc-200 p-3 rounded border border-[#27272A] font-mono text-xs focus:outline-none focus:border-[#D98A6C] resize-y"
              />
              <p className="text-[9px] text-zinc-500 font-mono">
                Markdown syntax: # Header, ## Subheader, - list item, **bold text**, *italicized text*, [anchor](url).
              </p>
            </div>
          ) : (
            <div className="p-3 bg-[#121212] rounded-lg border border-[#27272A]/50 max-h-48 overflow-y-auto pr-1">
              {renderMarkdown(notesText)}
            </div>
          )}
        </div>

        {/* Delete button option */}
        <div className="pt-4 border-t border-[#27272A]/50 flex justify-end">
          <button
            onClick={() => {
              if (confirm(`Are you absolutely sure you want to remove '${manga.title}' from your library? Progress records will be deleted.`)) {
                onDeleteManga(manga.id);
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-red-950/20 text-red-400 hover:text-red-300 border border-red-900/30 hover:border-red-500/30 rounded text-[10px] font-semibold transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" /> Remove Title from Library
          </button>
        </div>
      </div>
    </div>
  );
}
