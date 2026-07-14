import React, { useState } from "react";
import { DBDataset, MangaEntry, LibraryEntry, ReadingHistoryItem } from "../types";
import {
  calculateReadingStreak,
  calculateSourceStats,
  calculateTagVelocities,
  compareTwoTitles,
  getLongestStalls,
} from "../utils/analytics";

interface ChartsProps {
  dataset: DBDataset;
}

/**
 * 1. GitHub-style Contribution Heatmap
 */
export function ReadingHeatmap({ dataset }: ChartsProps) {
  const library = dataset.library || [];
  const heatmapData: Record<string, number> = {};

  // Aggregate reading counts by YYYY-MM-DD
  library.forEach((lib) => {
    (lib.history || []).forEach((h) => {
      if (h && typeof h.timestamp === "number") {
        const dateStr = new Date(h.timestamp * 1000).toISOString().split("T")[0];
        heatmapData[dateStr] = (heatmapData[dateStr] || 0) + 1;
      }
    });
  });

  // Calculate grid of the last 365 days, aligning with day-of-week rows (0-6)
  const days = 365;
  const cells: Array<{ dateStr: string; count: number; dayOfWeek: number; weekIndex: number }> = [];
  
  const now = new Date();
  const startDate = new Date(now.getTime() - days * 24 * 3600 * 1000);
  
  // Align start date to the beginning of its week (Sunday)
  const startDayOfWeek = startDate.getDay();
  const adjustedStart = new Date(startDate.getTime() - startDayOfWeek * 24 * 3600 * 1000);

  let current = new Date(adjustedStart);
  let weekIndex = 0;

  while (current <= now || cells.length < 371) {
    const dateStr = current.toISOString().split("T")[0];
    const count = heatmapData[dateStr] || 0;
    const dayOfWeek = current.getDay();

    cells.push({
      dateStr,
      count,
      dayOfWeek,
      weekIndex,
    });

    if (dayOfWeek === 6) {
      weekIndex++;
    }
    current = new Date(current.getTime() + 24 * 3600 * 1000);
  }

  // Group cells by day of week (rows 0-6)
  const rows: Array<Array<typeof cells[0]>> = Array.from({ length: 7 }, () => []);
  cells.forEach((cell) => {
    rows[cell.dayOfWeek].push(cell);
  });

  // Color scale
  const getCellColor = (count: number) => {
    if (count === 0) return "bg-[#161618] border border-[#27272A]/30";
    if (count <= 2) return "bg-[#27272A] border border-[#D98A6C]/20";
    if (count <= 5) return "bg-[#D98A6C] border border-[#D98A6C]/40 text-[#121212]";
    return "bg-[#EAD9C6] border border-white/40 text-[#121212]";
  };

  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="bg-[#161618] p-5 rounded-xl border border-[#27272A] overflow-hidden" id="heatmap-panel">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-[#EAD9C6] text-sm tracking-wide uppercase">
          Reading Habits Heatmap
        </h3>
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span>Less</span>
          <div className="w-3 h-3 rounded bg-[#161618] border border-[#27272A]" />
          <div className="w-3 h-3 rounded bg-[#27272A]" />
          <div className="w-3 h-3 rounded bg-[#D98A6C]" />
          <div className="w-3 h-3 rounded bg-[#EAD9C6]" />
          <span>More</span>
        </div>
      </div>

      <div className="overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-zinc-700">
        <div className="flex gap-2 min-w-[720px] select-none">
          {/* Day Labels */}
          <div className="flex flex-col justify-between text-[10px] text-zinc-500 pr-1 py-1 h-[105px] w-8">
            {dayLabels.map((label, idx) => (
              <span key={idx}>{idx % 2 === 1 ? label : ""}</span>
            ))}
          </div>

          {/* Grid Rows */}
          <div className="grid grid-rows-7 grid-flow-col gap-[3px] h-[105px]">
            {cells.map((cell, idx) => (
              <div
                key={idx}
                className={`w-3.5 h-3.5 rounded-sm relative group cursor-pointer transition-colors duration-150 ${getCellColor(cell.count)}`}
                title={`${cell.dateStr}: ${cell.count} chapters`}
              >
                {/* Tooltip on hover */}
                <div className="hidden group-hover:block absolute bottom-5 left-1/2 -translate-x-1/2 bg-black text-[#EAD9C6] text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap z-30 border border-[#27272A]">
                  <span className="font-semibold">{cell.count}</span> chapters read on {cell.dateStr}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 2. Time of Day Graph (Bar Chart, hours 0-23)
 */
export function TimeOfDayChart({ dataset }: ChartsProps) {
  const library = dataset.library || [];
  const hours = Array(24).fill(0);

  library.forEach((lib) => {
    (lib.history || []).forEach((h) => {
      if (h && typeof h.timestamp === "number") {
        const hr = new Date(h.timestamp * 1000).getHours();
        hours[hr]++;
      }
    });
  });

  const maxVal = Math.max(...hours, 1);

  return (
    <div className="bg-[#161618] p-5 rounded-xl border border-[#27272A]" id="time-of-day-chart">
      <h3 className="font-semibold text-[#EAD9C6] text-sm tracking-wide uppercase mb-4">
        Chapters Read by Time of Day
      </h3>
      <div className="h-40 flex items-end gap-1.5 pb-2 border-b border-[#27272A]">
        {hours.map((count, hr) => {
          const pct = (count / maxVal) * 100;
          return (
            <div key={hr} className="flex-1 flex flex-col items-center group relative h-full justify-end">
              <div
                style={{ height: `${pct}%` }}
                className="w-full bg-[#D98A6C] rounded-t-sm hover:bg-[#EAD9C6] transition-all duration-200"
              />
              {/* Tooltip */}
              <div className="hidden group-hover:block absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-black text-[#EAD9C6] text-[10px] px-1.5 py-0.5 rounded shadow z-20 whitespace-nowrap border border-[#27272A]">
                {hr}:00: {count} chapters
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-zinc-500 mt-2">
        <span>12 AM</span>
        <span>6 AM</span>
        <span>12 PM</span>
        <span>6 PM</span>
        <span>11 PM</span>
      </div>
    </div>
  );
}

/**
 * 3. Source Rank Table & Tag Velocities
 */
export function AnalyticsOverview({ dataset }: ChartsProps) {
  const sources = calculateSourceStats(dataset.manga || [], dataset.library || []);
  const tagVelocities = calculateTagVelocities(dataset.manga || [], dataset.library || []);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6" id="analytics-overview">
      {/* Source RANK */}
      <div className="bg-[#161618] p-5 rounded-xl border border-[#27272A]">
        <h3 className="font-semibold text-[#EAD9C6] text-sm tracking-wide uppercase mb-4">
          Source performance correlation
        </h3>
        {sources.length === 0 ? (
          <p className="text-zinc-500 text-sm italic">No source analytics found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#27272A] text-zinc-500 pb-2">
                  <th className="pb-2 font-normal">Source</th>
                  <th className="pb-2 font-normal text-right">Titles</th>
                  <th className="pb-2 font-normal text-right">Ch/Day</th>
                  <th className="pb-2 font-normal text-right">Drop %</th>
                  <th className="pb-2 font-normal text-right">Comp %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#27272A]/50">
                {sources.map((s) => (
                  <tr key={s.sourceId} className="hover:bg-[#27272A]/10">
                    <td className="py-2.5 font-medium text-[#EAD9C6] max-w-[120px] truncate">{s.sourceId}</td>
                    <td className="py-2.5 text-right text-zinc-400">{s.totalTitles}</td>
                    <td className="py-2.5 text-right text-[#D98A6C] font-semibold">{s.avgChaptersPerDay}</td>
                    <td className="py-2.5 text-right text-red-400">{s.dropRate}%</td>
                    <td className="py-2.5 text-right text-green-400">{s.completionRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Genre Tag Velocity */}
      <div className="bg-[#161618] p-5 rounded-xl border border-[#27272A]">
        <h3 className="font-semibold text-[#EAD9C6] text-sm tracking-wide uppercase mb-4">
          Tag-based reading speed (Ch/Day)
        </h3>
        {tagVelocities.length === 0 ? (
          <p className="text-zinc-500 text-sm italic">No genre tag stats compiled.</p>
        ) : (
          <div className="space-y-3">
            {tagVelocities.map((t, idx) => (
              <div key={idx} className="flex flex-col">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-zinc-300 font-medium">{t.tag}</span>
                  <span className="text-[#D98A6C] font-semibold">{t.avgChaptersPerDay} ch/day</span>
                </div>
                <div className="w-full h-1.5 bg-[#121212] rounded-full overflow-hidden">
                  <div
                    style={{
                      width: `${Math.min(100, (t.avgChaptersPerDay / Math.max(...tagVelocities.map((x) => x.avgChaptersPerDay), 1)) * 100)}%`,
                    }}
                    className="h-full bg-[#D98A6C]"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 4. Dual-Title Progress Compare Matrix
 */
export function TitleCompareMatrix({ dataset }: ChartsProps) {
  const mangaList = dataset.manga || [];
  const libraryList = dataset.library || [];

  const [id1, setId1] = useState("");
  const [id2, setId2] = useState("");

  const title1 = mangaList.find((m) => m.id === id1);
  const title2 = mangaList.find((m) => m.id === id2);

  const lib1 = libraryList.find((l) => l.mangaId === id1);
  const lib2 = libraryList.find((l) => l.mangaId === id2);

  const comparePoints =
    id1 && id2
      ? compareTwoTitles(lib1, title1?.title || "", lib2, title2?.title || "")
      : [];

  const maxProgress = comparePoints.length
    ? Math.max(...comparePoints.map((p) => Math.max(p.title1Progress, p.title2Progress)), 1)
    : 1;

  return (
    <div className="bg-[#161618] p-5 rounded-xl border border-[#27272A]" id="compare-matrix">
      <h3 className="font-semibold text-[#EAD9C6] text-sm tracking-wide uppercase mb-4">
        Dual Title Velocity Compare
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
        <div>
          <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Select First Manga</label>
          <select
            value={id1}
            onChange={(e) => setId1(e.target.value)}
            className="w-full bg-[#121212] text-sm text-[#EAD9C6] px-3 py-2 rounded border border-[#27272A] focus:outline-none focus:border-[#D98A6C]"
          >
            <option value="">-- Choose Manga 1 --</option>
            {mangaList.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Select Second Manga</label>
          <select
            value={id2}
            onChange={(e) => setId2(e.target.value)}
            className="w-full bg-[#121212] text-sm text-[#EAD9C6] px-3 py-2 rounded border border-[#27272A] focus:outline-none focus:border-[#D98A6C]"
          >
            <option value="">-- Choose Manga 2 --</option>
            {mangaList.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {id1 && id2 ? (
        comparePoints.length === 0 ? (
          <p className="text-zinc-500 text-xs italic text-center py-6">
            No overlapping historical read timeline. Ensure both selected titles have history events.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 bg-[#D98A6C] rounded-full" />
                <span className="text-zinc-300 truncate max-w-[150px] font-medium">{title1?.title}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 bg-[#EAD9C6] rounded-full" />
                <span className="text-zinc-300 truncate max-w-[150px] font-medium">{title2?.title}</span>
              </div>
            </div>

            {/* Render a custom pure SVG overlay chart */}
            <div className="h-48 border-b border-l border-[#27272A] relative mt-2 w-full">
              <svg className="w-full h-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                {/* Grid Lines */}
                <line x1="0" y1="25" x2="100" y2="25" stroke="#27272A" strokeWidth="0.5" strokeDasharray="2,2" />
                <line x1="0" y1="50" x2="100" y2="50" stroke="#27272A" strokeWidth="0.5" strokeDasharray="2,2" />
                <line x1="0" y1="75" x2="100" y2="75" stroke="#27272A" strokeWidth="0.5" strokeDasharray="2,2" />

                {/* Path 1: Title 1 */}
                <path
                  d={comparePoints
                    .map((p, idx) => {
                      const x = (idx / (comparePoints.length - 1)) * 100;
                      const y = 100 - (p.title1Progress / maxProgress) * 100;
                      return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
                    })
                    .join(" ")}
                  fill="none"
                  stroke="#D98A6C"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />

                {/* Path 2: Title 2 */}
                <path
                  d={comparePoints
                    .map((p, idx) => {
                      const x = (idx / (comparePoints.length - 1)) * 100;
                      const y = 100 - (p.title2Progress / maxProgress) * 100;
                      return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
                    })
                    .join(" ")}
                  fill="none"
                  stroke="#EAD9C6"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div className="flex justify-between text-[9px] text-zinc-500 px-1">
              <span>{comparePoints[0].dateStr}</span>
              <span>Timeline</span>
              <span>{comparePoints[comparePoints.length - 1].dateStr}</span>
            </div>
          </div>
        )
      ) : (
        <p className="text-zinc-500 text-xs italic text-center py-6">
          Please pick two manga entries above to overlay their reading history graphs.
        </p>
      )}
    </div>
  );
}

/**
 * 5. Backup Payload Size tracker
 */
export function BackupPayloadChart({ dataset }: ChartsProps) {
  const history = dataset.metadata?.history || [];
  if (history.length === 0) {
    return null;
  }

  const maxVal = Math.max(...history.map((h) => h.sizeKB), 1);

  return (
    <div className="bg-[#161618] p-5 rounded-xl border border-[#27272A]" id="backup-payload-chart">
      <h3 className="font-semibold text-[#EAD9C6] text-sm tracking-wide uppercase mb-4">
        Database File Size Growth
      </h3>
      <div className="h-32 border-b border-l border-[#27272A] relative">
        <svg className="w-full h-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path
            d={history
              .map((h, idx) => {
                const x = (idx / Math.max(1, history.length - 1)) * 100;
                const y = 100 - (h.sizeKB / maxVal) * 100;
                return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
              })
              .join(" ")}
            fill="none"
            stroke="#D98A6C"
            strokeWidth="2"
          />
        </svg>
      </div>
      <div className="flex justify-between text-[9px] text-zinc-500 mt-2">
        <span>Oldest sync</span>
        <span>Latest ({history[history.length - 1].sizeKB} KB)</span>
      </div>
    </div>
  );
}
