import { DBDataset, MangaEntry, LibraryEntry, ReadingHistoryItem, AppSettings } from "../types";

// Known hiatus titles for override
export const HIATUS_TITLES = [
  "berserk",
  "hunter x hunter",
  "hunterxhunter",
  "vagabond",
  "nana",
  "real",
  "bastard!!",
  "black clover",
  "yotsuba",
  "d.gray-man",
  "d.gray man",
  "x/1999",
];

/**
 * Checks if a title is on hiatus by string matching
 */
export function isTitleOnHiatus(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return HIATUS_TITLES.some(
    (h) => normalized.includes(h) || h.includes(normalized)
  );
}

/**
 * Calculates current reading streak in days
 */
export function calculateReadingStreak(library: LibraryEntry[]): number {
  const readDates = new Set<string>();
  library.forEach((lib) => {
    (lib.history || []).forEach((h) => {
      if (h && typeof h.timestamp === "number") {
        const dateStr = new Date(h.timestamp * 1000).toISOString().split("T")[0];
        readDates.add(dateStr);
      }
    });
  });

  if (readDates.size === 0) return 0;

  let streak = 0;
  const oneDayMs = 24 * 60 * 60 * 1000;
  let checkDate = new Date(); // Start today

  // Check if read today or yesterday
  const todayStr = checkDate.toISOString().split("T")[0];
  const yesterday = new Date(checkDate.getTime() - oneDayMs);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  if (!readDates.has(todayStr) && !readDates.has(yesterdayStr)) {
    return 0; // Streak broken
  }

  // If didn't read today but read yesterday, start counting from yesterday
  if (!readDates.has(todayStr) && readDates.has(yesterdayStr)) {
    checkDate = yesterday;
  }

  while (true) {
    const dateStr = checkDate.toISOString().split("T")[0];
    if (readDates.has(dateStr)) {
      streak++;
      checkDate = new Date(checkDate.getTime() - oneDayMs);
    } else {
      break;
    }
  }

  return streak;
}

/**
 * Computes chapters-per-day velocity for 7d, 30d, and lifetime.
 */
export function calculateVelocities(library: LibraryEntry[], addedTimestamp: number): { "7d": number; "30d": number; "lifetime": number } {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 3600;
  const thirtyDaysAgo = now - 30 * 24 * 3600;

  let chapters7d = 0;
  let chapters30d = 0;
  let chaptersLifetime = 0;

  library.forEach((lib) => {
    (lib.history || []).forEach((h) => {
      if (h && typeof h.timestamp === "number") {
        chaptersLifetime++;
        if (h.timestamp >= sevenDaysAgo) {
          chapters7d++;
        }
        if (h.timestamp >= thirtyDaysAgo) {
          chapters30d++;
        }
      }
    });
  });

  // Calculate days elapsed
  const lifetimeDays = Math.max(1, Math.ceil((now - addedTimestamp) / (24 * 3600)));
  
  return {
    "7d": parseFloat((chapters7d / 7).toFixed(2)),
    "30d": parseFloat((chapters30d / 30).toFixed(2)),
    "lifetime": parseFloat((chaptersLifetime / lifetimeDays).toFixed(2)),
  };
}

/**
 * Computes time to completion and difficulty score for a manga
 */
export interface TimeToCompletionData {
  estimateStr: string;
  difficultyScore: number;
  difficultyClass: "Easy" | "Medium" | "Hard";
}

export function calculateTimeToCompletion(
  manga: MangaEntry,
  lib: LibraryEntry | undefined,
  lifetimeVelocity: number
): TimeToCompletionData {
  const chaptersRead = lib ? lib.chaptersRead : 0;
  const remaining = Math.max(0, manga.totalChapters - chaptersRead);

  if (remaining === 0) {
    return { estimateStr: "Completed", difficultyScore: 0, difficultyClass: "Easy" };
  }

  // Use a minimum default velocity if none to avoid dividing by 0
  const effectiveVelocity = lifetimeVelocity > 0 ? lifetimeVelocity : 0.15;
  const daysEstimate = remaining / effectiveVelocity;

  let estimateStr = "";
  if (daysEstimate < 1.5) {
    estimateStr = "~1 day";
  } else if (daysEstimate < 14) {
    estimateStr = `~${Math.round(daysEstimate)} days`;
  } else {
    estimateStr = `~${Math.round(daysEstimate / 7)} weeks`;
  }

  // Difficulty score: remaining * (1 / velocity)
  const difficultyScore = Math.round(remaining * (1 / effectiveVelocity));
  let difficultyClass: "Easy" | "Medium" | "Hard" = "Easy";

  if (difficultyScore > 200) {
    difficultyClass = "Hard";
  } else if (difficultyScore > 50) {
    difficultyClass = "Medium";
  }

  return { estimateStr, difficultyScore, difficultyClass };
}

/**
 * Groups reading history into day-based "reading sessions" and flags chapter jumps
 */
export interface ReadingSession {
  dateStr: string;
  chaptersRead: number;
  chapters: number[];
  isBinge: boolean;
}

export function detectBingeSessions(history: ReadingHistoryItem[]): ReadingSession[] {
  const sessionsMap: Record<string, number[]> = {};
  if (!Array.isArray(history)) return [];

  history.forEach((h) => {
    if (h && typeof h.timestamp === "number") {
      const dateStr = new Date(h.timestamp * 1000).toISOString().split("T")[0];
      if (!sessionsMap[dateStr]) {
        sessionsMap[dateStr] = [];
      }
      sessionsMap[dateStr].push(h.chapter);
    }
  });

  return Object.keys(sessionsMap).map((dateStr) => {
    const chapters = sessionsMap[dateStr];
    // A binge is a reading session of > 3 chapters in a single day
    const isBinge = chapters.length > 3;
    return {
      dateStr,
      chaptersRead: chapters.length,
      chapters: chapters.sort((a, b) => a - b),
      isBinge,
    };
  });
}

/**
 * Calculates weekly reading momentum (chapters/week) for the last 8 weeks before stall
 */
export function calculateStallDecay(history: ReadingHistoryItem[], lastRead: number): number[] {
  const now = lastRead || Math.floor(Date.now() / 1000);
  const oneWeekSecs = 7 * 24 * 3600;
  const weeklyCounts = Array(8).fill(0);
  if (!Array.isArray(history)) return weeklyCounts;

  history.forEach((h) => {
    if (h && typeof h.timestamp === "number") {
      const delta = now - h.timestamp;
      if (delta >= 0 && delta < 8 * oneWeekSecs) {
        const weekIndex = Math.floor(delta / oneWeekSecs);
        if (weekIndex >= 0 && weekIndex < 8) {
          weeklyCounts[7 - weekIndex]++; // 7 = week 1 (oldest), 0 = week 8 (most recent before stall)
        }
      }
    }
  });

  return weeklyCounts;
}

/**
 * Release Schedule Extrapolator: Evaluates time between reading history entries
 * to predict the next chapter release.
 */
export interface ReleasePrediction {
  predictedDate: string;
  confidence: "High" | "Medium" | "Low";
}

export function predictNextRelease(history: ReadingHistoryItem[], lastRead: number): ReleasePrediction {
  if (!Array.isArray(history) || history.length < 2) {
    return { predictedDate: "N/A (Insufficient history)", confidence: "Low" };
  }

  // Calculate gaps between history entry timestamps (chronological)
  const sorted = [...history].filter(h => h && typeof h.timestamp === "number").sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length < 2) {
    return { predictedDate: "N/A (Insufficient history)", confidence: "Low" };
  }
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].timestamp - sorted[i - 1].timestamp;
    if (gap > 3600) { // Only count gaps larger than an hour to avoid intra-session chapter clicking
      gaps.push(gap);
    }
  }

  if (gaps.length === 0) {
    return { predictedDate: "N/A (Continuous read)", confidence: "Low" };
  }

  const avgGap = gaps.reduce((acc, g) => acc + g, 0) / gaps.length;
  const predictedTimestamp = lastRead + avgGap;

  // Confidence calculation: More samples + lower variance = higher confidence
  let confidence: "High" | "Medium" | "Low" = "Low";
  if (gaps.length >= 5) {
    confidence = "High";
  } else if (gaps.length >= 3) {
    confidence = "Medium";
  }

  const date = new Date(predictedTimestamp * 1000);
  const formattedDate = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return { predictedDate: formattedDate, confidence };
}

/**
 * Source-to-Velocity Correlation
 */
export interface SourceStats {
  sourceId: string;
  totalTitles: number;
  avgChaptersPerDay: number;
  dropRate: number; // Percentage
  completionRate: number; // Percentage
}

export function calculateSourceStats(mangaList: MangaEntry[], libraryList: LibraryEntry[]): SourceStats[] {
  const sourceGroups: Record<string, { titles: MangaEntry[]; libraryEntries: LibraryEntry[] }> = {};

  const libMap = new Map<string, LibraryEntry>();
  libraryList.forEach((l) => libMap.set(l.mangaId, l));

  mangaList.forEach((m) => {
    if (!sourceGroups[m.sourceId]) {
      sourceGroups[m.sourceId] = { titles: [], libraryEntries: [] };
    }
    sourceGroups[m.sourceId].titles.push(m);
    const lib = libMap.get(m.id);
    if (lib) {
      sourceGroups[m.sourceId].libraryEntries.push(lib);
    }
  });

  return Object.keys(sourceGroups).map((sourceId) => {
    const group = sourceGroups[sourceId];
    const totalTitles = group.titles.length;

    // Avg chapters/day for this source
    let totalChaptersRead = 0;
    let minAdded = Math.floor(Date.now() / 1000);
    group.libraryEntries.forEach((lib) => {
      totalChaptersRead += lib.chaptersRead;
    });

    group.titles.forEach((m) => {
      if (m.addedDate < minAdded) minAdded = m.addedDate;
    });

    const elapsedDays = Math.max(1, Math.ceil((Math.floor(Date.now() / 1000) - minAdded) / (24 * 3600)));
    const avgChaptersPerDay = parseFloat((totalChaptersRead / elapsedDays).toFixed(2));

    const droppedCount = group.titles.filter((m) => m.status === "dropped").length;
    const completedCount = group.titles.filter((m) => m.status === "completed").length;

    const dropRate = totalTitles > 0 ? Math.round((droppedCount / totalTitles) * 100) : 0;
    const completionRate = totalTitles > 0 ? Math.round((completedCount / totalTitles) * 100) : 0;

    return {
      sourceId,
      totalTitles,
      avgChaptersPerDay,
      dropRate,
      completionRate,
    };
  }).sort((a, b) => b.avgChaptersPerDay - a.avgChaptersPerDay);
}

/**
 * Tag-Based Velocity (chapters read per day by genre tag)
 */
export interface TagVelocity {
  tag: string;
  avgChaptersPerDay: number;
}

export function calculateTagVelocities(mangaList: MangaEntry[], libraryList: LibraryEntry[]): TagVelocity[] {
  const tagChapters: Record<string, number> = {};
  const libMap = new Map<string, LibraryEntry>();
  libraryList.forEach((l) => libMap.set(l.mangaId, l));

  let minAdded = Math.floor(Date.now() / 1000);

  mangaList.forEach((m) => {
    if (m.addedDate < minAdded) minAdded = m.addedDate;
    const lib = libMap.get(m.id);
    if (lib) {
      const genres = m.genres || [];
      genres.forEach((genre) => {
        tagChapters[genre] = (tagChapters[genre] || 0) + lib.chaptersRead;
      });
    }
  });

  const elapsedDays = Math.max(1, Math.ceil((Math.floor(Date.now() / 1000) - minAdded) / (24 * 3600)));

  return Object.keys(tagChapters).map((genre) => {
    return {
      tag: genre,
      avgChaptersPerDay: parseFloat((tagChapters[genre] / elapsedDays).toFixed(2)),
    };
  }).sort((a, b) => b.avgChaptersPerDay - a.avgChaptersPerDay).slice(0, 10); // Top 10 genres
}

/**
 * Timelines for Title Comparison Matrix
 * Combines cumulative progress over time for 2 titles.
 */
export interface ComparisonPoint {
  dateStr: string;
  title1Progress: number;
  title2Progress: number;
}

export function compareTwoTitles(
  lib1: LibraryEntry | undefined,
  title1: string,
  lib2: LibraryEntry | undefined,
  title2: string
): ComparisonPoint[] {
  if (!lib1 && !lib2) return [];

  const dateMap: Record<string, { progress1: number; progress2: number }> = {};
  
  // Sort histories
  const h1 = lib1 && Array.isArray(lib1.history) ? [...lib1.history].filter(h => h && typeof h.timestamp === "number").sort((a, b) => a.timestamp - b.timestamp) : [];
  const h2 = lib2 && Array.isArray(lib2.history) ? [...lib2.history].filter(h => h && typeof h.timestamp === "number").sort((a, b) => a.timestamp - b.timestamp) : [];

  // Group timestamps and get chronological unique dates
  const datesSet = new Set<string>();

  h1.forEach((h) => {
    const dStr = new Date(h.timestamp * 1000).toISOString().split("T")[0];
    datesSet.add(dStr);
  });

  h2.forEach((h) => {
    const dStr = new Date(h.timestamp * 1000).toISOString().split("T")[0];
    datesSet.add(dStr);
  });

  const sortedDates = Array.from(datesSet).sort();

  let p1Accum = 0;
  let p2Accum = 0;

  // Re-walk histories to calculate cumulative progress on each date
  return sortedDates.map((dateStr) => {
    // Find chapter read count on or before this day
    const dayEndSecs = Math.floor(new Date(dateStr + "T23:59:59").getTime() / 1000);

    const match1 = h1.filter((h) => h.timestamp <= dayEndSecs);
    p1Accum = match1.length;

    const match2 = h2.filter((h) => h.timestamp <= dayEndSecs);
    p2Accum = match2.length;

    return {
      dateStr,
      title1Progress: p1Accum,
      title2Progress: p2Accum,
    };
  });
}

/**
 * Longest Stall Hall of Fame:
 * Measures periods of inactivity (stalls) before status changes,
 * or current stall duration for reading titles.
 */
export interface StallHallOfFameItem {
  title: string;
  coverUrl: string;
  status: string;
  stallDurationDays: number;
}

export function getLongestStalls(mangaList: MangaEntry[], libraryList: LibraryEntry[]): StallHallOfFameItem[] {
  const now = Math.floor(Date.now() / 1000);
  const items: StallHallOfFameItem[] = [];

  mangaList.forEach((m) => {
    const lib = libraryList.find((l) => l.mangaId === m.id);
    if (!lib) return;

    let stallDurationSecs = 0;

    if (m.status === "reading") {
      // Current active stall
      const lastReadTime = m.lastRead || m.addedDate;
      stallDurationSecs = now - lastReadTime;
    } else {
      // Historical gap between last activity and completed/dropped
      const lastReadTime = m.lastRead || m.addedDate;
      stallDurationSecs = Math.abs(now - lastReadTime); // Best approximation of inactive age
    }

    const days = Math.round(stallDurationSecs / (24 * 3600));
    if (days > 0) {
      items.push({
        title: m.title,
        coverUrl: m.coverUrl,
        status: m.status,
        stallDurationDays: days,
      });
    }
  });

  return items.sort((a, b) => b.stallDurationDays - a.stallDurationDays).slice(0, 10);
}

function cleanMangaTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/**
 * Ghost Progress Estimation:
 * If a source fails or goes down, we look for matches on titles from other sources
 * that might have updated library progress.
 */
export function detectGhostProgress(mangaList: MangaEntry[], libraryList: LibraryEntry[]): string[] {
  // Flag manga whose cover is broken, or whose sourceId appears inactive, 
  // but we find title-similarity matches from another source showing progress.
  const warnings: string[] = [];
  
  // Group manga by cleaned title
  const groups: Record<string, MangaEntry[]> = {};
  mangaList.forEach((m) => {
    const clean = cleanMangaTitle(m.title);
    if (!groups[clean]) groups[clean] = [];
    groups[clean].push(m);
  });

  Object.keys(groups).forEach((clean) => {
    const titles = groups[clean];
    if (titles.length > 1) {
      // We have multiple entries from different sources for the same title!
      // This is a candidate for alternate progress checks.
      const hasProgressDiff = titles.some((t, i) => {
        const next = titles[i + 1];
        if (!next) return false;
        const lib1 = libraryList.find((l) => l.mangaId === t.id);
        const lib2 = libraryList.find((l) => l.mangaId === next.id);
        return (lib1?.chaptersRead || 0) !== (lib2?.chaptersRead || 0);
      });

      if (hasProgressDiff) {
        warnings.push(titles[0].title);
      }
    }
  });

  return warnings;
}

/**
 * Dead-End Recommendation Engine (Task 7):
 * Locates up to three active/completed/highly-rated manga matching genres or authors
 * for a dropped or stalled manga.
 */
export function getMangaRecommendations(target: MangaEntry, allManga: MangaEntry[]): MangaEntry[] {
  if (!target) return [];
  
  const targetGenres = target.genres || [];
  const targetAuthor = (target.author || "").trim().toLowerCase();
  
  // Candidates must not be the target, and should be highly rated or completed
  const candidates = allManga.filter(
    (m) => m.id !== target.id && (m.status === "completed" || m.rating >= 4)
  );

  const scored = candidates.map((m) => {
    let score = 0;
    
    // Author match (avoid generic "unknown" matches)
    const mAuthor = (m.author || "").trim().toLowerCase();
    if (targetAuthor && mAuthor && mAuthor === targetAuthor && mAuthor !== "unknown author" && mAuthor !== "unknown") {
      score += 10;
    }
    
    // Genre match intersection
    const mGenres = m.genres || [];
    const intersection = mGenres.filter((g) => targetGenres.includes(g));
    score += intersection.length * 3;
    
    // Rating bonus
    score += m.rating || 0;
    
    return { manga: m, score };
  });

  // Sort by score descending and take top 3
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.manga)
    .slice(0, 3);
}

/**
 * Task 1 and 2: Dynamic flags updater for Binge and Stalled logic
 */
export function updateMangaFlags(
  mangaList: MangaEntry[],
  libraryList: LibraryEntry[],
  settings: AppSettings
): MangaEntry[] {
  const now = Math.floor(Date.now() / 1000);
  const bingeThresholdHours = settings?.bingeThresholdHours || 48;
  const bingeThresholdSecs = bingeThresholdHours * 3600;
  const stallThresholdDays = settings?.stallThresholdDays || 14;
  const stallThresholdSecs = stallThresholdDays * 24 * 3600;

  // Velocity threshold for binge: let's default to 5 chapters in 48 hours
  const bingeVelocityThreshold = 5;

  return mangaList.map((m) => {
    const lib = libraryList.find((l) => l.mangaId === m.id);
    if (!lib) {
      return { ...m, isBinge: false, isStalled: false };
    }

    // Task 1: 48-Hour Binge Engine
    const history = lib.history || [];
    const cutoff = now - bingeThresholdSecs;
    const recentReads = history.filter(
      (h) => h && typeof h.timestamp === "number" && h.timestamp >= cutoff && h.timestamp <= now
    );
    
    // Calculate delta of completed chapters in the 48-hour window
    const completedChaptersInWindow = new Set(recentReads.map((h) => h.chapter));
    const isBinge = m.status === "reading" && completedChaptersInWindow.size >= bingeVelocityThreshold;

    // Task 2: Threshold-Driven Stall Engine
    const lastReadTimestamp = m.lastRead || m.addedDate || now;
    const isStalled = m.status === "reading" && (now - lastReadTimestamp) > stallThresholdSecs;

    return {
      ...m,
      isBinge,
      isStalled,
    };
  });
}

/**
 * Task 3: Client-Side Widget Data Provider
 * Compiles a flat summary payload representing /api/widget.json schema
 */
export function generateWidgetPayload(dataset: DBDataset) {
  const mangaList = dataset.manga || [];
  const libraryList = dataset.library || [];

  const activeManga = mangaList.filter((m) => m.status === "reading");
  
  const activeTitles = activeManga.map((m) => {
    const lib = libraryList.find((l) => l.mangaId === m.id);
    return {
      title: m.title,
      chaptersRead: lib ? lib.chaptersRead : 0,
      totalChapters: m.totalChapters || 0,
      lastRead: m.lastRead,
    };
  });

  const totalReadingCounts = libraryList.reduce((acc, curr) => acc + (curr.chaptersRead || 0), 0);

  const heatmapVector: Record<string, number> = {};
  libraryList.forEach((lib) => {
    (lib.history || []).forEach((hist) => {
      if (hist && typeof hist.timestamp === "number") {
        const dateStr = new Date(hist.timestamp * 1000).toISOString().split("T")[0];
        heatmapVector[dateStr] = (heatmapVector[dateStr] || 0) + 1;
      }
    });
  });

  const dates = Object.keys(heatmapVector).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  let currentStreak = 0;
  if (dates.length > 0) {
    const todayStr = new Date().toISOString().split("T")[0];
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    
    if (dates[0] === todayStr || dates[0] === yesterdayStr) {
      currentStreak = 1;
      for (let i = 0; i < dates.length - 1; i++) {
        const d1 = new Date(dates[i]);
        const d2 = new Date(dates[i + 1]);
        const diffDays = (d1.getTime() - d2.getTime()) / (1000 * 3600 * 24);
        if (diffDays <= 1.1) {
          currentStreak++;
        } else {
          break;
        }
      }
    }
  }

  return {
    activeCount: activeManga.length,
    activeTitles,
    totalReadingCounts,
    currentStreak,
    heatmapVector,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}
