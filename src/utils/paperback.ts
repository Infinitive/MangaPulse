import * as fflate from "fflate";
import { DBDataset, MangaEntry, LibraryEntry, ReadingHistoryItem, MangaStatus } from "../types";
import { addErrorLog } from "./db";
import { calculateVelocities } from "./analytics";

/**
 * Calculates the Levenshtein distance between two strings.
 */
export function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,    // Deletion
          dp[i][j - 1] + 1,    // Insertion
          dp[i - 1][j - 1] + 1 // Substitution
        );
      }
    }
  }
  return dp[m][n];
}

/**
 * Computes a similarity ratio between 0.0 and 1.0.
 */
export function fuzzySimilarity(s1: string, s2: string): number {
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 && len2 === 0) return 1.0;
  if (len1 === 0 || len2 === 0) return 0.0;

  const distance = levenshteinDistance(s1, s2);
  const maxLength = Math.max(len1, len2);
  return 1.0 - distance / maxLength;
}

/**
 * Cleans the manga title by removing tracker tags, brackets, and extra spaces.
 * E.g., "[MangaDex] Solo Leveling (Official)" -> "solo leveling"
 */
export function cleanMangaTitle(title: string): string {
  if (!title) return "";
  let cleaned = title;

  // 1. Strip brackets e.g. [MangaDex] or [Scanlation]
  cleaned = cleaned.replace(/\[[^\]]*\]/g, "");

  // 2. Strip parentheses e.g. (Official) or (Webtoon)
  cleaned = cleaned.replace(/\([^)]*\)/g, "");

  // 3. Remove non-alphanumeric chars at start/end, replace multiple spaces
  cleaned = cleaned.replace(/[\s\-_]+/g, " ");
  cleaned = cleaned.trim().toLowerCase();

  return cleaned || title.trim().toLowerCase();
}

/**
 * Robust helper to clean and extract strings from tags/genres, which can be raw strings or objects.
 */
export function sanitizeGenres(rawGenres: any): string[] {
  if (!rawGenres) return [];
  const list = Array.isArray(rawGenres) ? rawGenres : [rawGenres];
  const result: string[] = [];
  list.forEach((g) => {
    if (!g) return;
    if (typeof g === "string") {
      const trimmed = g.trim();
      if (trimmed) result.push(trimmed);
    } else if (typeof g === "object") {
      const val = g.label || g.name || g.id || "";
      if (typeof val === "string") {
        const trimmed = val.trim();
        if (trimmed) result.push(trimmed);
      }
    }
  });
  return Array.from(new Set(result));
}

/**
 * Normalizes a timestamp, auto-converting Apple Cocoa Epoch (starts Jan 1, 2001) to Unix Epoch.
 */
export function normalizeEpoch(val: any): number {
  if (typeof val !== "number") return 0;
  if (val < -10000000) return 0; // Very negative timestamp, placeholder (e.g. -63114076800)
  if (val > 0 && val < 1100000000) {
    // Almost certainly Cocoa/Mac Epoch (starts Jan 1, 2001). Convert to UNIX epoch.
    return Math.floor(val + 978307200);
  }
  return Math.floor(val);
}

/**
 * Parses and merges raw Paperback backup bytes (.pas4 / .paperback / .json) into a db.json model.
 */
export async function parsePaperbackBackup(fileBuffer: ArrayBuffer): Promise<DBDataset> {
  const bytes = new Uint8Array(fileBuffer);
  let jsonText = "";

  try {
    // Approach A: Try to unzip using fflate (in case it is a ZIP)
    try {
      const decompressed = fflate.unzipSync(bytes);
      const fileKeys = Object.keys(decompressed);

      let sourceMangaKey = "";
      let mangaInfoKey = "";
      let libraryKey = "";
      let progressKey = "";

      fileKeys.forEach((filename) => {
        const sanitized = filename.toLowerCase().replace(/[^0-9a-z]/gi, "");
        if (sanitized.includes("sourcemanga")) sourceMangaKey = filename;
        else if (sanitized.includes("mangainfo")) mangaInfoKey = filename;
        else if (sanitized.includes("librarymanga")) libraryKey = filename;
        else if (sanitized.includes("chapterprogressmarker")) progressKey = filename;
      });

      if (sourceMangaKey && mangaInfoKey && libraryKey) {
        // Native .pas4 ZIP backup container!
        const textDecoder = new TextDecoder("utf-8");
        const sourceMangaJSON = JSON.parse(textDecoder.decode(decompressed[sourceMangaKey]));
        const mangaInfoJSON = JSON.parse(textDecoder.decode(decompressed[mangaInfoKey]));
        const libraryJSON = JSON.parse(textDecoder.decode(decompressed[libraryKey]));
        
        let progressJSON: any = {};
        if (progressKey && decompressed[progressKey]) {
          try {
            progressJSON = JSON.parse(textDecoder.decode(decompressed[progressKey]));
          } catch (e) {
            // ignore
          }
        }

        const parsedManga: MangaEntry[] = [];
        const parsedLibrary: LibraryEntry[] = [];

        const libraryItems = Array.isArray(libraryJSON) ? libraryJSON : Object.values(libraryJSON);

        libraryItems.forEach((libraryItem: any) => {
          if (!libraryItem) return;

          // Resolve source manga
          const sourceMangaId = libraryItem.primarySource?.id || libraryItem.sourceMangaId || libraryItem.mangaId;
          if (!sourceMangaId) return;

          let sourceManga: any = null;
          if (Array.isArray(sourceMangaJSON)) {
            sourceManga = sourceMangaJSON.find((sm: any) => sm?.id === sourceMangaId || sm?.primarySource?.id === sourceMangaId);
          } else if (sourceMangaJSON && typeof sourceMangaJSON === "object") {
            sourceManga = sourceMangaJSON[sourceMangaId];
          }

          if (!sourceManga) return;

          // Resolve manga info
          const mangaInfoId = sourceManga.mangaInfo?.id || sourceManga.mangaInfoId;
          if (!mangaInfoId) return;

          let mangaInfo: any = null;
          if (Array.isArray(mangaInfoJSON)) {
            mangaInfo = mangaInfoJSON.find((mi: any) => mi?.id === mangaInfoId);
          } else if (mangaInfoJSON && typeof mangaInfoJSON === "object") {
            mangaInfo = mangaInfoJSON[mangaInfoId];
          }

          if (!mangaInfo) return;

          // Grab the required metadata fields
          const title = (mangaInfo.titles && mangaInfo.titles[0]) || sourceManga.mangaId || "Unknown Title";
          const author = mangaInfo.author || "Unknown Author";

          // Other metadata
          const id = sourceManga.mangaId || sourceManga.id || mangaInfo.id || "";
          if (!id) return;

          const sourceId = sourceManga.sourceId || sourceManga.source?.id || "Paperback";
          const coverUrl = (mangaInfo.covers && mangaInfo.covers[0]) || mangaInfo.cover || mangaInfo.coverImage || mangaInfo.image || "";
          const genres = sanitizeGenres(mangaInfo.genres || mangaInfo.tags || []);

          let status: MangaStatus = "reading";
          if (Array.isArray(libraryItem.categories) && libraryItem.categories.length > 0) {
            const cat = String(libraryItem.categories[0]).toLowerCase();
            if (cat.includes("read") || cat.includes("current")) status = "reading";
            else if (cat.includes("plan") || cat.includes("later") || cat.includes("wish")) status = "planned";
            else if (cat.includes("drop")) status = "dropped";
            else if (cat.includes("comp")) status = "completed";
            else if (cat.includes("arch") || cat.includes("hold")) status = "archived";
          } else if (libraryItem.status !== undefined) {
            const s = String(libraryItem.status).toLowerCase();
            if (s.includes("read") || s.includes("current")) status = "reading";
            else if (s.includes("plan") || s.includes("later") || s.includes("wish")) status = "planned";
            else if (s.includes("drop")) status = "dropped";
            else if (s.includes("comp")) status = "completed";
            else if (s.includes("arch") || s.includes("hold")) status = "archived";
          }

          const addedDate = normalizeEpoch(libraryItem.dateAdded || libraryItem.dateAdded?.$date || libraryItem.addedDate || Math.floor(Date.now() / 1000));
          const lastRead = normalizeEpoch(libraryItem.lastRead || libraryItem.lastOpened || 0);
          const totalChapters = typeof mangaInfo.totalChapters === "number" ? mangaInfo.totalChapters : 0;
          const rating = typeof libraryItem.rating === "number" ? Math.max(0, Math.min(5, libraryItem.rating)) : 0;
          const notes = libraryItem.notes || libraryItem.review || "";

          // Resolve history using progressJSON
          const historyList: ReadingHistoryItem[] = [];
          const progressItems = Array.isArray(progressJSON) 
            ? progressJSON 
            : (progressJSON && typeof progressJSON === "object" ? Object.values(progressJSON) : []);

          progressItems.forEach((marker: any) => {
            if (!marker) return;
            const markerMangaId = marker.mangaId || marker.sourceMangaId || marker.mangaInfoId || marker.sourceId || "";
            const matches = markerMangaId && (
              markerMangaId === id ||
              markerMangaId === sourceMangaId ||
              markerMangaId === mangaInfoId
            );

            if (matches) {
              let chapter = 0;
              if (typeof marker.chapter === "number") {
                chapter = marker.chapter;
              } else if (typeof marker.chapterNumber === "number") {
                chapter = marker.chapterNumber;
              } else if (typeof marker.chapterNumber === "string") {
                chapter = parseFloat(marker.chapterNumber) || 0;
              } else if (marker.lastReadChapter !== undefined) {
                chapter = typeof marker.lastReadChapter === "number" ? marker.lastReadChapter : parseFloat(marker.lastReadChapter) || 0;
              }

              const timestamp = normalizeEpoch(
                typeof marker.lastRead === "number"
                  ? marker.lastRead
                  : typeof marker.time === "number"
                    ? marker.time
                    : typeof marker.timestamp === "number"
                      ? marker.timestamp
                      : typeof marker.dateRead === "number"
                        ? marker.dateRead
                        : 0
              );

              if (chapter > 0 && timestamp > 0) {
                historyList.push({ chapter, timestamp });
              }
            }
          });

          historyList.sort((a, b) => a.timestamp - b.timestamp);
          const seenHist = new Set<string>();
          const dedupedHist: ReadingHistoryItem[] = [];
          historyList.forEach((h) => {
            const key = `${h.chapter}_${h.timestamp}`;
            if (!seenHist.has(key)) {
              seenHist.add(key);
              dedupedHist.push(h);
            }
          });

          let chaptersRead = typeof libraryItem.chaptersRead === "number"
            ? libraryItem.chaptersRead
            : typeof libraryItem.progress === "number"
              ? libraryItem.progress
              : dedupedHist.length > 0
                ? Math.max(...dedupedHist.map(h => h.chapter))
                : 0;

          if (chaptersRead > 0 && dedupedHist.length === 0) {
            const histTime = lastRead > 0 ? lastRead : Math.floor(Date.now() / 1000);
            dedupedHist.push({ chapter: chaptersRead, timestamp: histTime });
          }

          parsedManga.push({
            id,
            title,
            author,
            sourceId,
            coverUrl,
            genres,
            status,
            totalChapters,
            lastRead,
            rating,
            notes,
            tags: genres,
            isBinge: false,
            isStalled: false,
            addedDate,
            plot: mangaInfo.plot || mangaInfo.description || mangaInfo.synopsis || "",
            serialization: mangaInfo.status || "",
          });

          parsedLibrary.push({
            mangaId: id,
            chaptersRead: Math.max(0, chaptersRead),
            lastRead: lastRead > 0 ? lastRead : (dedupedHist.length > 0 ? dedupedHist[dedupedHist.length - 1].timestamp : 0),
            history: dedupedHist,
          });
        });

        // Dedup and build final DBDataset
        const { manga: dedupedManga, library: dedupedLibrary } = deduplicateTitles(parsedManga, parsedLibrary);

        const totalTracked = dedupedManga.length;
        let totalChaptersRead = 0;
        const sourceDistribution: Record<string, number> = {};
        const readingHeatmap: Record<string, number> = {};

        dedupedLibrary.forEach((lib) => {
          totalChaptersRead += lib.chaptersRead;
          (lib.history || []).forEach((h) => {
            if (h && typeof h.timestamp === "number") {
              const dateStr = new Date(h.timestamp * 1000).toISOString().split("T")[0];
              readingHeatmap[dateStr] = (readingHeatmap[dateStr] || 0) + 1;
            }
          });
        });

        dedupedManga.forEach((m) => {
          sourceDistribution[m.sourceId] = (sourceDistribution[m.sourceId] || 0) + 1;
        });

        const oldestAddedDate = dedupedManga.reduce((min, m) => (m.addedDate < min ? m.addedDate : min), Math.floor(Date.now() / 1000));
        const calculatedVelocity = calculateVelocities(dedupedLibrary, oldestAddedDate);

        return {
          metadata: {
            lastSync: Math.floor(Date.now() / 1000),
            version: "1.0",
            history: [],
          },
          manga: dedupedManga,
          library: dedupedLibrary,
          settings: {
            stallThresholdDays: 14,
            bingeThresholdHours: 48,
            difficultyThresholds: {
              easy: 50,
              medium: 200,
              hard: 500,
            },
          },
          stats: {
            totalTracked,
            totalChaptersRead,
            sourceDistribution,
            readingHeatmap,
            velocity: calculatedVelocity,
          },
        };
      } else {
        // If it's a ZIP but not .pas4 format, see if it contains a single backup JSON
        const jsonFileKey = Object.keys(decompressed).find(
          (key) => key.endsWith(".json") || key.includes("backup")
        );

        if (jsonFileKey && decompressed[jsonFileKey]) {
          const decoder = new TextDecoder("utf-8");
          jsonText = decoder.decode(decompressed[jsonFileKey]);
        }
      }
    } catch (e) {
      // Not a ZIP file or unzip failed, try Approach B
    }

    // Approach B: Try raw inflate (if it's a raw zlib/deflate compressed stream)
    if (!jsonText) {
      try {
        const inflated = fflate.inflateSync(bytes);
        const decoder = new TextDecoder("utf-8");
        jsonText = decoder.decode(inflated);
      } catch (e) {
        // Not a zlib stream, try Approach C
      }
    }

    // Approach C: Read as raw UTF-8 JSON text (in case it is uncompressed JSON)
    if (!jsonText) {
      try {
        const decoder = new TextDecoder("utf-8");
        const decoded = decoder.decode(bytes);
        jsonText = decoded.replace(/^\uFEFF/, "").trim(); // Remove UTF-8 BOM if present
        // Verify it is JSON
        JSON.parse(jsonText);
      } catch (e) {
        throw new Error("Unable to decompress or parse backup file. Invalid file format.");
      }
    }

    if (!jsonText) {
      throw new Error("Decompression produced empty output.");
    }

    const backupJson = JSON.parse(jsonText);
    return normalizePaperbackJSON(backupJson);
  } catch (err: any) {
    const errMsg = err.message || "Failed to process backup file.";
    await addErrorLog(`Paperback Extraction Error: ${errMsg}`, "extraction");
    throw new Error(errMsg);
  }
}

/**
 * Normalizes Paperback's internal structure into our standard DBDataset.
 * This handles parsing "sourceManga", "library", "chapters", and "history".
 */
export function normalizePaperbackJSON(backupJson: any): DBDataset {
  if (!backupJson) {
    throw new Error("Empty backup JSON data.");
  }

  // Structure in Paperback formats can vary. Let's find arrays for manga, library, history.
  const rawMangaList: any[] = Array.isArray(backupJson.sourceManga)
    ? backupJson.sourceManga
    : (Array.isArray(backupJson.manga) ? backupJson.manga : []);
  const rawLibraryList: any[] = Array.isArray(backupJson.library)
    ? backupJson.library
    : (Array.isArray(backupJson.libraryManga) ? backupJson.libraryManga : []);
  const rawHistoryList: any[] = Array.isArray(backupJson.history)
    ? backupJson.history
    : (Array.isArray(backupJson.chapterHistory) ? backupJson.chapterHistory : []);
  const rawChaptersList: any[] = Array.isArray(backupJson.chapters) ? backupJson.chapters : [];

  const parsedManga: MangaEntry[] = [];
  const parsedLibrary: LibraryEntry[] = [];

  // Map chapterId to chapter numbers from the chapters list
  const chapterIdToNumberMap = new Map<string, number>();
  rawChaptersList.forEach((c: any) => {
    const mId = c.mangaId || "";
    const cId = c.id || "";
    if (mId && cId && typeof c.chapter === "number") {
      chapterIdToNumberMap.set(`${mId}_${cId}`, c.chapter);
    }
  });

  // Helper to map Paperback status numbers/strings to our MangaStatus
  const mapStatus = (statusVal: any): MangaStatus => {
    if (typeof statusVal === "number") {
      // Paperback uses: 0=Reading, 1=Planned, 2=Completed, 3=Dropped, 4=OnHold/Archived
      switch (statusVal) {
        case 0: return "reading";
        case 1: return "planned";
        case 2: return "completed";
        case 3: return "dropped";
        case 4: return "archived";
        default: return "reading";
      }
    }
    const s = String(statusVal).toLowerCase().trim();
    if (s.includes("read") || s.includes("current")) return "reading";
    if (s.includes("plan") || s.includes("later") || s.includes("wish")) return "planned";
    if (s.includes("drop")) return "dropped";
    if (s.includes("comp")) return "completed";
    if (s.includes("arch") || s.includes("hold")) return "archived";
    return "reading";
  };

  // 1. Process manga list
  rawMangaList.forEach((m: any, index) => {
    // Handle both old and new Paperback models
    const id = m.id || m.mangaId || `manga_${index}`;
    const title = m.title || m.mangaTitle || "Untitled Manga";
    const author = m.author || m.artist || "Unknown Author";
    const sourceId = m.sourceId || m.source || "Paperback";
    const coverUrl = m.cover || m.coverUrl || m.imageUrl || "";
    
    // Clean genres: default to tags, trimmed of spaces
    const genres: string[] = sanitizeGenres(m.genres || m.tags || []);

    // Determine status from corresponding library item if present
    const libEntry = rawLibraryList.find((lib) => (lib.mangaId || lib.id) === id);
    let status: MangaStatus = "reading";
    if (libEntry && Array.isArray(libEntry.categories) && libEntry.categories.length > 0) {
      status = mapStatus(libEntry.categories[0]);
    } else if (m.status !== undefined) {
      status = mapStatus(m.status);
    } else {
      status = "planned";
    }

    const rating = typeof m.rating === "number" ? Math.max(0, Math.min(5, m.rating)) : 0;
    const notes = m.notes || m.review || "";
    const tags: string[] = sanitizeGenres(m.tags || []);
    
    // Total chapters can sometimes be retrieved from metadata
    const rawAddedDate = typeof m.addedDate === "number"
      ? m.addedDate
      : (libEntry && typeof libEntry.dateAdded === "number" ? libEntry.dateAdded : undefined);
    const addedDate = rawAddedDate !== undefined ? normalizeEpoch(rawAddedDate) : Math.floor(Date.now() / 1000);

    const rawLastRead = typeof m.lastRead === "number"
      ? m.lastRead
      : (libEntry && typeof libEntry.lastRead === "number" ? libEntry.lastRead : undefined);
    const lastRead = rawLastRead !== undefined ? normalizeEpoch(rawLastRead) : 0;

    const totalChapters = typeof m.totalChapters === "number" ? m.totalChapters : 0;

    parsedManga.push({
      id,
      title,
      author,
      sourceId,
      coverUrl,
      genres,
      status,
      totalChapters,
      lastRead,
      rating,
      notes,
      tags,
      isBinge: false,
      isStalled: false,
      addedDate,
      plot: m.plot || m.description || "",
      serialization: m.serialization || m.statusDetails || "",
    });
  });

  // 2. Process Library read logs and reading history
  // Map raw history items to grouped arrays by mangaId
  const historyByMangaId: Record<string, ReadingHistoryItem[]> = {};

  rawHistoryList.forEach((h: any) => {
    const mangaId = h.mangaId || h.id;
    if (!mangaId) return;

    let chapter = 0;
    const lookupKey = `${mangaId}_${h.chapterId || ""}`;
    if (chapterIdToNumberMap.has(lookupKey)) {
      chapter = chapterIdToNumberMap.get(lookupKey)!;
    } else if (typeof h.chapter === "number") {
      chapter = h.chapter;
    } else if (h.chapterNumber !== undefined) {
      chapter = parseFloat(h.chapterNumber || "0");
    } else if (typeof h.chapterId === "string") {
      // Try to parse number from c232.8 format
      const match = h.chapterId.match(/c([0-9]+(?:\.[0-9]+)?)/);
      if (match) {
        chapter = parseFloat(match[1]);
      } else {
        const anyNumMatch = h.chapterId.match(/([0-9]+(?:\.[0-9]+)?)/);
        if (anyNumMatch) {
          chapter = parseFloat(anyNumMatch[1]);
        }
      }
    }

    const timestamp = normalizeEpoch(
      typeof h.dateRead === "number"
        ? h.dateRead
        : typeof h.time === "number"
          ? h.time
          : typeof h.timestamp === "number"
            ? h.timestamp
            : Math.floor(Date.now() / 1000)
    );

    if (!historyByMangaId[mangaId]) {
      historyByMangaId[mangaId] = [];
    }
    historyByMangaId[mangaId].push({ chapter, timestamp });
  });

  // Sort histories and group
  rawLibraryList.forEach((lib: any, index) => {
    const mangaId = lib.mangaId || lib.id || (parsedManga[index] ? parsedManga[index].id : "");
    if (!mangaId) return;

    const rawHistoryItems = historyByMangaId[mangaId] || [];
    // Sort chronological ascending
    rawHistoryItems.sort((a, b) => a.timestamp - b.timestamp);

    // Patch any 0 chapter numbers sequentially
    const historyItems = rawHistoryItems.map((h, i) => {
      if (h.chapter === 0) {
        return { ...h, chapter: i + 1 };
      }
      return h;
    });

    // Store back the patched history items so fallback reconstruction block below also uses them
    historyByMangaId[mangaId] = historyItems;

    const chaptersRead = typeof lib.chaptersRead === "number" 
      ? lib.chaptersRead 
      : historyItems.length > 0 
        ? Math.max(...historyItems.map(h => h.chapter)) 
        : 0;

    const lastRead = typeof lib.lastRead === "number" && lib.lastRead > 0
      ? normalizeEpoch(lib.lastRead)
      : historyItems.length > 0
        ? historyItems[historyItems.length - 1].timestamp
        : 0;

    parsedLibrary.push({
      mangaId,
      chaptersRead: Math.max(0, chaptersRead),
      lastRead,
      history: historyItems,
    });
  });

  // If we have history entries but no explicit library records, reconstruct library
  Object.keys(historyByMangaId).forEach((mangaId) => {
    const exists = parsedLibrary.some((lib) => lib.mangaId === mangaId);
    if (!exists) {
      const historyItems = historyByMangaId[mangaId];
      historyItems.sort((a, b) => a.timestamp - b.timestamp);

      parsedLibrary.push({
        mangaId,
        chaptersRead: historyItems.length > 0 ? Math.max(...historyItems.map(h => h.chapter)) : 0,
        lastRead: historyItems.length > 0 ? historyItems[historyItems.length - 1].timestamp : 0,
        history: historyItems,
      });
    }
  });

  // Merge duplicates & canonical deduplication
  const { manga: dedupedManga, library: dedupedLibrary } = deduplicateTitles(parsedManga, parsedLibrary);

  // Compile final DBDataset structure
  const totalTracked = dedupedManga.length;
  let totalChaptersRead = 0;
  const sourceDistribution: Record<string, number> = {};
  const readingHeatmap: Record<string, number> = {};

  dedupedLibrary.forEach((lib) => {
    totalChaptersRead += lib.chaptersRead;
    
    // Build Heatmap (YYYY-MM-DD -> count)
    (lib.history || []).forEach((h) => {
      if (h && typeof h.timestamp === "number") {
        const dateStr = new Date(h.timestamp * 1000).toISOString().split("T")[0];
        readingHeatmap[dateStr] = (readingHeatmap[dateStr] || 0) + 1;
      }
    });
  });

  dedupedManga.forEach((m) => {
    sourceDistribution[m.sourceId] = (sourceDistribution[m.sourceId] || 0) + 1;
  });

  const nowSecs = Math.floor(Date.now() / 1000);
  const oldestAddedDate = dedupedManga.reduce((min, m) => (m.addedDate < min ? m.addedDate : min), nowSecs);
  const calculatedVelocity = calculateVelocities(dedupedLibrary, oldestAddedDate);

  return {
    metadata: {
      lastSync: Math.floor(Date.now() / 1000),
      version: "1.0",
      history: [],
    },
    manga: dedupedManga,
    library: dedupedLibrary,
    settings: {
      stallThresholdDays: 14,
      bingeThresholdHours: 48,
      difficultyThresholds: {
        easy: 50,
        medium: 200,
        hard: 500,
      },
    },
    stats: {
      totalTracked,
      totalChaptersRead,
      sourceDistribution,
      readingHeatmap,
      velocity: calculatedVelocity,
    },
  };
}

/**
 * Deduplicates manga entries based on canonical title fuzzy similarity.
 * Uses a similarity threshold of 0.85. Merges progress history and details.
 */
export function deduplicateTitles(
  mangaList: MangaEntry[],
  libraryList: LibraryEntry[]
): { manga: MangaEntry[]; library: LibraryEntry[] } {
  const mergedManga: MangaEntry[] = [];
  const mergedLibrary: LibraryEntry[] = [];

  // Index maps from mangaId to its library record
  const libMap = new Map<string, LibraryEntry>();
  libraryList.forEach((l) => libMap.set(l.mangaId, l));

  mangaList.forEach((m) => {
    const cleanTitle = cleanMangaTitle(m.title);
    
    // Find if we already have a similar manga merged
    let matchIdx = -1;
    for (let i = 0; i < mergedManga.length; i++) {
      const existingClean = cleanMangaTitle(mergedManga[i].title);
      const similarity = fuzzySimilarity(cleanTitle, existingClean);
      if (similarity >= 0.85) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx === -1) {
      // Keep as a new entry
      mergedManga.push({ ...m });
      const lib = libMap.get(m.id) || { mangaId: m.id, chaptersRead: 0, lastRead: 0, history: [] };
      mergedLibrary.push({ ...lib });
    } else {
      // Merge with existing
      const existing = mergedManga[matchIdx];
      let existingLib = mergedLibrary.find((l) => l.mangaId === existing.id);
      if (!existingLib) {
        existingLib = { mangaId: existing.id, chaptersRead: 0, lastRead: 0, history: [] };
        mergedLibrary.push(existingLib);
      }
      const incomingLib = libMap.get(m.id) || { mangaId: m.id, chaptersRead: 0, lastRead: 0, history: [] };

      // Keep richer record as canonical
      const existingWeight = (existing.coverUrl ? 2 : 0) + (existing.notes ? 3 : 0) + (existing.genres.length > 0 ? 1 : 0);
      const incomingWeight = (m.coverUrl ? 2 : 0) + (m.notes ? 3 : 0) + (m.genres.length > 0 ? 1 : 0);

      if (incomingWeight > existingWeight) {
        // Update canonical fields except ID to maintain associations
        const oldId = existing.id;
        Object.assign(existing, {
          title: m.title,
          author: m.author,
          coverUrl: m.coverUrl || existing.coverUrl,
          plot: m.plot || existing.plot,
          serialization: m.serialization || existing.serialization,
          notes: m.notes || existing.notes,
          rating: Math.max(existing.rating, m.rating),
        });
      }

      // Combine genres & tags
      existing.genres = Array.from(new Set([...existing.genres, ...m.genres]));
      existing.tags = Array.from(new Set([...existing.tags, ...m.tags]));

      // Merge library history logs safely (deduplicate chapters read on identical timestamps/chapters)
      const combinedHistory = [...(existingLib.history || []), ...(incomingLib.history || [])];
      const seenChapters = new Set<string>();
      const dedupedHistory: ReadingHistoryItem[] = [];

      combinedHistory.forEach((h) => {
        if (h && typeof h.timestamp === "number" && typeof h.chapter === "number") {
          // Compound key
          const key = `${h.chapter}_${h.timestamp}`;
          if (!seenChapters.has(key)) {
            seenChapters.add(key);
            dedupedHistory.push(h);
          }
        }
      });

      // Sort chronological ascending
      dedupedHistory.sort((a, b) => a.timestamp - b.timestamp);

      existingLib.history = dedupedHistory;
      existingLib.chaptersRead = Math.max(existingLib.chaptersRead, incomingLib.chaptersRead, dedupedHistory.length);
      existingLib.lastRead = Math.max(existingLib.lastRead, incomingLib.lastRead);
      
      existing.lastRead = Math.max(existing.lastRead, m.lastRead, existingLib.lastRead);
      existing.totalChapters = Math.max(existing.totalChapters, m.totalChapters);
    }
  });

  return { manga: mergedManga, library: mergedLibrary };
}
