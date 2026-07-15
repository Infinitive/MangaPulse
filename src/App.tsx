import React, { useState, useEffect } from "react";
import { DBDataset, MangaEntry, LibraryEntry, AppSettings, SyncStatus, MangaStatus } from "./types";
import { getDbDataset, saveDbDataset, getLocalItem, setLocalItem, getDefaultDataset, addErrorLog } from "./utils/db";
import { fetchFromGitHub, pushToGitHub, testGitHubConnection, hasDatasetChanged, compileCommitMessage } from "./utils/github";
import { decryptText } from "./utils/crypto";
import { parsePaperbackBackup, getLastRawBackup } from "./utils/paperback";
import { calculateReadingStreak, calculateVelocities, updateMangaFlags, generateWidgetPayload } from "./utils/analytics";

// Component Imports
import { ReadingHeatmap, TimeOfDayChart, AnalyticsOverview, TitleCompareMatrix, BackupPayloadChart } from "./components/Charts";
import { AiOracle } from "./components/AiOracle";
import { ContextPanel } from "./components/ContextPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ConflictResolutionModal } from "./components/ConflictResolutionModal";
import { JSONInspector } from "./components/JSONInspector";

// Icons
import {
  Brain,
  Settings,
  RefreshCw,
  Search,
  Filter,
  Clock,
  ArrowRight,
  BookOpen,
  Calendar,
  Flame,
  CheckCircle,
  Database,
  Trash2,
  FileText,
  AlertTriangle,
  Grid,
  List,
  Sparkles,
  Plus
} from "lucide-react";

export default function App() {
  // Splash Screen & Loading
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);

  // Core Datasets
  const [dataset, setDataset] = useState<DBDataset>(getDefaultDataset());
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // GitHub integration states
  const [encryptedPat, setEncryptedPat] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubFilepath, setGithubFilepath] = useState("db.json");
  const [latestSha, setLatestSha] = useState<string | null>(null);

  // Sync state engine
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    status: "synced",
    lastSyncTime: null,
    pendingChangesCount: 0,
  });

  // UI Overlays Toggles
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [activeManga, setActiveManga] = useState<MangaEntry | null>(null);
  const [conflictData, setConflictData] = useState<{ local: DBDataset; remote: DBDataset; sha: string } | null>(null);
  const [rawBackup, setRawBackup] = useState<{ librarymanga: any; sourcemanga: any; mangainfo: any } | null>(null);

  // Filters and Views States
  const [searchQuery, setSearchQuery] = useState("");
  const [statusTab, setStatusTab] = useState<MangaStatus | "all">("reading");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedGenre, setSelectedGenre] = useState("");
  const [selectedSource, setSelectedSource] = useState("");
  const [selectedRating, setSelectedRating] = useState<number | "">("");
  const [viewMode, setViewMode] = useState<"grid" | "row">("grid");

  // On mount: Load cache, register Service Worker, setup connection listeners
  useEffect(() => {
    async function init() {
      try {
        // Register widget Service Worker
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker
            .register("/sw.js")
            .then((reg) => console.log("Widget Service Worker registered successfully:", reg.scope))
            .catch((err) => console.error("Widget Service Worker registration failed:", err));
        }

        // Get local cached dataset
        const localData = await getDbDataset();
        const initialSettings = localData.settings || {
          stallThresholdDays: 14,
          bingeThresholdHours: 48,
          difficultyThresholds: { easy: 5, medium: 15, hard: 30 }
        };
        const updatedMangaList = updateMangaFlags(localData.manga, localData.library, initialSettings);
        const localDataWithFlags = { ...localData, manga: updatedMangaList };
        setDataset(localDataWithFlags);

        // Fetch saved credentials from cache
        const savedPat = await getLocalItem<string>("encrypted_pat") || "";
        const savedRepo = await getLocalItem<string>("github_repo") || "";
        const savedFilepath = await getLocalItem<string>("github_filepath") || "db.json";

        setEncryptedPat(savedPat);
        setGithubRepo(savedRepo);
        setGithubFilepath(savedFilepath);

        // Sync metadata states
        const lastSynced = localData.metadata?.lastSync || null;
        setSyncStatus({
          status: savedPat && savedRepo ? "pending" : "synced",
          lastSyncTime: lastSynced,
          pendingChangesCount: 0,
        });

        // Online triggers
        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);

        // Attempt automatic background sync if credentials exist
        if (savedPat && savedRepo) {
          triggerAutoSync(savedPat, savedRepo, savedFilepath, localData);
        }
      } catch (err: any) {
        console.error("Initialization failure", err);
        await addErrorLog("System Initialization failure: " + err.message, "sync");
      } finally {
        setLoading(false);
      }
    }
    init();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const handleOnline = () => {
    setIsOnline(true);
    triggerAutoSync(encryptedPat, githubRepo, githubFilepath, dataset);
  };

  const handleOffline = () => {
    setIsOnline(false);
  };

  // Triggers automated sync flow in background
  const triggerAutoSync = async (encPat: string, repo: string, filepath: string, currentData: DBDataset) => {
    if (!encPat || !repo || !navigator.onLine) return;
    setSyncStatus((prev) => ({ ...prev, status: "pending" }));

    try {
      // Ask user passphrase or decrypt automatically if possible.
      // For automated flows, we try to decrypt using standard local cache values if stored,
      // or we gracefully report pending status until manual force-sync decrypt is clicked.
      const pass = prompt("Automated sync starting. Please enter your encryption passphrase to authorize GitHub access (or click cancel to sync manually later):");
      if (!pass) {
        setSyncStatus((prev) => ({ ...prev, status: "pending", errorMessage: "Awaiting passphrase decryption." }));
        return;
      }

      const pat = await decryptText(encPat, pass);
      await performSynchronization(pat, repo, filepath, currentData);
    } catch (e: any) {
      console.error("Auto background sync failure", e);
      setSyncStatus((prev) => ({
        ...prev,
        status: "error",
        errorMessage: e.message || "Decryption failed.",
      }));
    }
  };

  // Master Synchronizer Flow
  const performSynchronization = async (pat: string, repo: string, filepath: string, localData: DBDataset) => {
    if (!pat || !repo || !navigator.onLine) return;
    setSyncStatus((prev) => ({ ...prev, status: "pending" }));

    try {
      const remotePayload = await fetchFromGitHub(pat, repo, filepath);

      if (remotePayload === null) {
        // File 404: Doesn't exist on GitHub yet. Push our local cache state!
        const sha = await pushToGitHub(
          pat,
          repo,
          filepath,
          localData,
          null,
          "Synced: Initial db.json database creation"
        );
        setLatestSha(sha);
        setSyncStatus({
          status: "synced",
          lastSyncTime: Math.floor(Date.now() / 1000),
          pendingChangesCount: 0,
        });
        await addErrorLog("Database created successfully on GitHub repository.", "sync");
        return;
      }

      const { data: remoteData, sha } = remotePayload;
      setLatestSha(sha);

      const localTime = localData.metadata?.lastSync || 0;
      const remoteTime = remoteData.metadata?.lastSync || 0;

      if (remoteTime > localTime) {
        // Remote file is newer. Check for actual diffs to present merge panel
        const changed = hasDatasetChanged(localData, remoteData);
        if (changed) {
          setConflictData({ local: localData, remote: remoteData, sha });
        } else {
          // No actual conflicts, load remote directly
          setDataset(remoteData);
          await saveDbDataset(remoteData);
          setSyncStatus({
            status: "synced",
            lastSyncTime: remoteTime,
            pendingChangesCount: 0,
          });
        }
      } else if (localTime > remoteTime || hasDatasetChanged(localData, remoteData)) {
        // Local is newer or has modifications. Push local back to GitHub!
        const changeMsg = compileCommitMessage(localData, remoteData);
        const updatedLocal = {
          ...localData,
          metadata: {
            ...localData.metadata,
            lastSync: Math.floor(Date.now() / 1000),
          },
        };

        const newSha = await pushToGitHub(pat, repo, filepath, updatedLocal, sha, changeMsg);
        setLatestSha(newSha);
        setDataset(updatedLocal);
        await saveDbDataset(updatedLocal);

        setSyncStatus({
          status: "synced",
          lastSyncTime: updatedLocal.metadata.lastSync,
          pendingChangesCount: 0,
        });
      } else {
        // Fully identical/synced!
        setSyncStatus({
          status: "synced",
          lastSyncTime: remoteTime,
          pendingChangesCount: 0,
        });
      }
    } catch (err: any) {
      console.error("Synchronization cycle failed", err);
      setSyncStatus((prev) => ({
        ...prev,
        status: "error",
        errorMessage: err.message || "Sync failed",
      }));
    }
  };

  const handleForceRefresh = async () => {
    const pass = prompt("Please enter your encryption passphrase to decrypt your PAT token and force pull:");
    if (!pass) return;

    try {
      const pat = await decryptText(encryptedPat, pass);
      await performSynchronization(pat, githubRepo, githubFilepath, dataset);
    } catch (e: any) {
      alert("Refresh failed: " + (e.message || "Wrong passphrase."));
    }
  };

  // Conflict resolved callback
  const handleResolveConflicts = async (mergedDataset: DBDataset) => {
    setConflictData(null);
    setDataset(mergedDataset);
    await saveDbDataset(mergedDataset);

    // Push resolved merge to GitHub
    const pass = prompt("Conflict resolved! Enter passphrase to push resolved merge back to GitHub:");
    if (pass) {
      try {
        const pat = await decryptText(encryptedPat, pass);
        const sha = await pushToGitHub(
          pat,
          githubRepo,
          githubFilepath,
          mergedDataset,
          latestSha,
          "Synced: Resolved merge conflicts"
        );
        setLatestSha(sha);
        setSyncStatus({
          status: "synced",
          lastSyncTime: mergedDataset.metadata.lastSync,
          pendingChangesCount: 0,
        });
      } catch (err: any) {
        alert("Pushing resolution failed: " + err.message);
      }
    }
  };

  // Paperback Import file input click
  const handlePaperbackImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setImportProgress(20);

    try {
      const buffer = await file.arrayBuffer();
      setImportProgress(60);

      const parsedDataset = await parsePaperbackBackup(buffer);
      setImportProgress(90);

      // Task 5: Backup Payload Size tracking (sizeInBytes and sizeKB)
      const sizeInBytes = file.size;
      const sizeKB = Math.round((sizeInBytes / 1024) * 100) / 100;
      const newHistoryItem = {
        timestamp: Math.floor(Date.now() / 1000),
        sizeKB,
        sizeInBytes,
      };
      const nextMetadata = {
        ...(parsedDataset.metadata || { lastSync: Math.floor(Date.now() / 1000), version: "1.0", history: [] }),
        history: [...(parsedDataset.metadata?.history || []), newHistoryItem]
      };

      // Recalculate isBinge and isStalled flags upon import for all items
      const currentSettings = parsedDataset.settings || dataset.settings || {
        stallThresholdDays: 14,
        bingeThresholdHours: 48,
        difficultyThresholds: { easy: 5, medium: 15, hard: 30 }
      };
      const updatedMangaList = updateMangaFlags(parsedDataset.manga, parsedDataset.library, currentSettings);

      const finalDataset = {
        ...parsedDataset,
        manga: updatedMangaList,
        metadata: nextMetadata,
      };

      // Save into local IndexedDB
      setDataset(finalDataset);
      await saveDbDataset(finalDataset);
      setRawBackup(getLastRawBackup());

      setImportProgress(100);
      alert(`Import complete! Loaded and fuzzy-merged ${finalDataset.manga.length} titles.`);

      // Prompt to push to GitHub if connected
      if (encryptedPat && githubRepo) {
        const pass = prompt("MangaPulse parsed. Enter passphrase to push this imported library directly to your GitHub repository:");
        if (pass) {
          const pat = await decryptText(encryptedPat, pass);
          await performSynchronization(pat, githubRepo, githubFilepath, finalDataset);
        }
      }
    } catch (err: any) {
      alert("Paperback import failed: " + err.message);
    } finally {
      setImporting(false);
      setImportProgress(0);
    }
  };

  // Core modification triggers
  const handleSaveManga = async (updatedManga: MangaEntry) => {
    const updatedMangaList = dataset.manga.map((m) => (m.id === updatedManga.id ? updatedManga : m));
    const nextDataset = { ...dataset, manga: updatedMangaList };

    setDataset(nextDataset);
    await saveDbDataset(nextDataset);

    if (activeManga?.id === updatedManga.id) {
      setActiveManga(updatedManga);
    }

    setSyncStatus((prev) => ({
      ...prev,
      status: "pending",
      pendingChangesCount: prev.pendingChangesCount + 1,
    }));
  };

  const handleUpdateProgress = async (mangaId: string, chaptersRead: number) => {
    const nowSecs = Math.floor(Date.now() / 1000);

    // Update or create library record
    let libraryList = [...dataset.library];
    let libIdx = libraryList.findIndex((l) => l.mangaId === mangaId);

    if (libIdx === -1) {
      libraryList.push({
        mangaId,
        chaptersRead,
        lastRead: nowSecs,
        history: [{ chapter: chaptersRead, timestamp: nowSecs }],
      });
    } else {
      const currentLib = libraryList[libIdx];
      const historyList = currentLib.history || [];
      // Append chronological history log safely if not already existing
      const exists = historyList.some((h) => h && h.chapter === chaptersRead);
      const updatedHistory = exists
        ? historyList
        : [...historyList, { chapter: chaptersRead, timestamp: nowSecs }].sort((a, b) => a.timestamp - b.timestamp);

      libraryList[libIdx] = {
        ...currentLib,
        chaptersRead,
        lastRead: nowSecs,
        history: updatedHistory,
      };
    }

    // Update lastRead inside manga record too
    const mangaList = dataset.manga.map((m) => {
      if (m.id === mangaId) {
        return {
          ...m,
          lastRead: nowSecs,
        };
      }
      return m;
    });

    // Recompute total chapters and stats
    let totalChaptersRead = 0;
    libraryList.forEach((lib) => {
      totalChaptersRead += lib.chaptersRead;
    });

    // Recalculate velocities based on oldest manga entry added date
    const oldestAddedDate = mangaList.reduce((min, m) => (m.addedDate < min ? m.addedDate : min), nowSecs);
    const newVelocities = calculateVelocities(libraryList, oldestAddedDate);

    // Apply true Binge and Stall Engine threshold calculations dynamically!
    const finalMangaList = updateMangaFlags(mangaList, libraryList, dataset.settings || {
      stallThresholdDays: 14,
      bingeThresholdHours: 48,
      difficultyThresholds: { easy: 5, medium: 15, hard: 30 }
    });

    const nextDataset: DBDataset = {
      ...dataset,
      manga: finalMangaList,
      library: libraryList,
      stats: {
        ...dataset.stats,
        totalChaptersRead,
        velocity: newVelocities,
      },
    };

    setDataset(nextDataset);
    await saveDbDataset(nextDataset);

    // Update active select card reference if open
    const matchingManga = finalMangaList.find((m) => m.id === mangaId);
    if (matchingManga) {
      setActiveManga(matchingManga);
    }

    setSyncStatus((prev) => ({
      ...prev,
      status: "pending",
      pendingChangesCount: prev.pendingChangesCount + 1,
    }));
  };

  const handleDeleteManga = async (mangaId: string) => {
    const nextManga = dataset.manga.filter((m) => m.id !== mangaId);
    const nextLibrary = dataset.library.filter((l) => l.mangaId !== mangaId);

    const nextDataset = {
      ...dataset,
      manga: nextManga,
      library: nextLibrary,
    };

    setDataset(nextDataset);
    await saveDbDataset(nextDataset);
    setActiveManga(null);

    setSyncStatus((prev) => ({
      ...prev,
      status: "pending",
      pendingChangesCount: prev.pendingChangesCount + 1,
    }));
  };

  // State savers from settings
  const handleSaveSettings = async (settings: AppSettings) => {
    const nextDataset = { ...dataset, settings };
    setDataset(nextDataset);
    await saveDbDataset(nextDataset);
  };

  const handleUpdateFullDataset = async (newDataset: DBDataset) => {
    setDataset(newDataset);
    await saveDbDataset(newDataset);
  };

  const handleSaveEncryptedPat = async (encPat: string) => {
    setEncryptedPat(encPat);
    await setLocalItem("encrypted_pat", encPat);
  };

  const handleSaveRepo = async (repo: string) => {
    setGithubRepo(repo);
    await setLocalItem("github_repo", repo);
  };

  const handleSaveFilepath = async (path: string) => {
    setGithubFilepath(path);
    await setLocalItem("github_filepath", path);
  };

  // Calculated overview stats
  const activeStreak = calculateReadingStreak(dataset.library || []);
  const bingeRowManga = dataset.manga.filter((m) => {
    const lib = dataset.library.find((l) => l.mangaId === m.id);
    if (!lib) return false;
    // Binge filter: Reading status and has >= 5 chapters read
    return m.status === "reading" && lib.chaptersRead >= 5;
  });

  const stalledRowManga = dataset.manga.filter((m) => {
    if (m.status !== "reading") return false;
    const thresholdDays = dataset.settings?.stallThresholdDays || 14;
    const lastActivitySecs = m.lastRead || m.addedDate;
    const daysSince = (Math.floor(Date.now() / 1000) - lastActivitySecs) / (24 * 3600);
    return daysSince > thresholdDays;
  });

  // Filter manga list
  const filteredManga = dataset.manga.filter((m) => {
    // 1. Search Query
    const query = searchQuery.toLowerCase().trim();
    if (query) {
      const matchTitle = m.title?.toLowerCase().includes(query);
      const matchAuthor = m.author?.toLowerCase().includes(query);
      const matchSource = m.sourceId?.toLowerCase().includes(query);
      if (!matchTitle && !matchAuthor && !matchSource) return false;
    }

    // 2. Status Tab
    if (statusTab !== "all") {
      if (m.status !== statusTab) return false;
    }

    // 3. Archived Filter
    if (!includeArchived && m.status === "archived") return false;

    // 4. Genre Filter
    if (selectedGenre && !m.genres?.includes(selectedGenre)) return false;

    // 5. Source Filter
    if (selectedSource && m.sourceId !== selectedSource) return false;

    // 6. Rating Filter
    if (selectedRating !== "" && m.rating !== selectedRating) return false;

    return true;
  });

  // Unique lists for filtering dropdowns
  const uniqueGenres = Array.from(new Set(dataset.manga.flatMap((m) => m.genres || []))).sort();
  const uniqueSources = Array.from(new Set(dataset.manga.map((m) => m.sourceId))).sort();

  const formatTimeAgo = (secs: number) => {
    if (!secs) return "Never";
    const diff = Math.floor(Date.now() / 1000) - secs;
    if (diff < 60) return "Just now";
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "Yesterday";
    return `${days} days ago`;
  };

  const nowSecs = Math.floor(Date.now() / 1000);
  const weekSecs = 7 * 24 * 3600;
  const monthSecs = 30 * 24 * 3600;

  const chaptersThisWeek = dataset.history
    ? dataset.history
        .filter((h) => nowSecs - h.timestamp <= weekSecs)
        .reduce((sum, h) => sum + (h.chapterProgress || 1), 0)
    : 0;

  const chaptersThisMonth = dataset.history
    ? dataset.history
        .filter((h) => nowSecs - h.timestamp <= monthSecs)
        .reduce((sum, h) => sum + (h.chapterProgress || 1), 0)
    : 0;

  const totalChaptersRead = dataset.stats?.totalChaptersRead || 0;
  const showDeepAnalytics = dataset.library.length > 0 && totalChaptersRead >= 20;

  // Reading Now shelf (active, non-stalled reading entries)
  const readingNowManga = dataset.manga.filter((m) => {
    if (m.status !== "reading") return false;
    const thresholdDays = dataset.settings?.stallThresholdDays || 14;
    const lastActivitySecs = m.lastRead || m.addedDate;
    const daysSince = (nowSecs - lastActivitySecs) / (24 * 3600);
    return daysSince <= thresholdDays;
  });

  // Stalled shelf
  const stalledMangaShelf = dataset.manga.filter((m) => {
    if (m.status !== "reading") return false;
    const thresholdDays = dataset.settings?.stallThresholdDays || 14;
    const lastActivitySecs = m.lastRead || m.addedDate;
    const daysSince = (nowSecs - lastActivitySecs) / (24 * 3600);
    return daysSince > thresholdDays;
  });

  // Planned shelf
  const plannedMangaShelf = dataset.manga.filter((m) => m.status === "planning" || m.status === "on_hold");

  // Completed shelf
  const completedMangaShelf = dataset.manga.filter((m) => m.status === "completed");

  // Recently added
  const recentlyAddedMangaShelf = dataset.manga
    .slice()
    .sort((a, b) => (b.addedDate || 0) - (a.addedDate || 0))
    .slice(0, 8);

  // Continue Reading (top 3 reading entries)
  const continueReadingManga = dataset.manga
    .filter((m) => m.status === "reading")
    .sort((a, b) => (b.lastRead || b.addedDate || 0) - (a.lastRead || a.addedDate || 0))
    .slice(0, 3);

  // Recommendations for Reading Radar
  const radarRecommendations: Array<{
    type: "stalled" | "completion" | "binge" | "welcome";
    title: string;
    description: string;
    actionText: string;
    manga?: MangaEntry;
  }> = [];

  // 1. Stalled recommendations
  const stalledCandidate = dataset.manga.find((m) => {
    if (m.status !== "reading") return false;
    const thresholdDays = dataset.settings?.stallThresholdDays || 14;
    const lastActivitySecs = m.lastRead || m.addedDate;
    const daysSince = (nowSecs - lastActivitySecs) / (24 * 3600);
    return daysSince > thresholdDays;
  });

  if (stalledCandidate) {
    const days = Math.floor((nowSecs - (stalledCandidate.lastRead || stalledCandidate.addedDate)) / 86400);
    radarRecommendations.push({
      type: "stalled",
      title: "Stalled Series Notice",
      description: `You haven't read any chapters of ${stalledCandidate.title} in ${days} days. Jump back in to sustain your momentum!`,
      actionText: "Resume Reading",
      manga: stalledCandidate,
    });
  }

  // 2. Nearly Completed recommendations
  const nearCompletionCandidate = dataset.manga.find((m) => {
    if (m.status !== "reading" || !m.totalChapters) return false;
    const lib = dataset.library.find((l) => l.mangaId === m.id);
    if (!lib) return false;
    const ratio = lib.chaptersRead / m.totalChapters;
    return ratio >= 0.8 && ratio < 1.0;
  });

  if (nearCompletionCandidate) {
    const lib = dataset.library.find((l) => l.mangaId === nearCompletionCandidate.id);
    radarRecommendations.push({
      type: "completion",
      title: "Nearly Finished Series",
      description: `You've completed ${Math.round(((lib?.chaptersRead || 0) / nearCompletionCandidate.totalChapters!) * 100)}% of ${nearCompletionCandidate.title}. Only ${nearCompletionCandidate.totalChapters! - (lib?.chaptersRead || 0)} chapters remain!`,
      actionText: "Finish Series",
      manga: nearCompletionCandidate,
    });
  }

  // 3. Binge recommendation
  const bingeCandidate = dataset.manga.find((m) => {
    if (m.status !== "reading") return false;
    const lib = dataset.library.find((l) => l.mangaId === m.id);
    return lib && lib.chaptersRead >= 5 && m.isBinge;
  });

  if (bingeCandidate) {
    radarRecommendations.push({
      type: "binge",
      title: "Binge Mode Active",
      description: `You are reading ${bingeCandidate.title} at an incredible speed. Keep the streak hot!`,
      actionText: "Continue Binge",
      manga: bingeCandidate,
    });
  }

  if (radarRecommendations.length === 0) {
    radarRecommendations.push({
      type: "welcome",
      title: "Radar Scan Complete",
      description: "You're fully up-to-date across all ongoing series! Choose a title from your shelves below to begin tracking your next session.",
      actionText: "Explore Shelves",
    });
  }

  // Active filter state
  const isFiltering = searchQuery.trim() !== "" || selectedGenre !== "" || selectedSource !== "" || selectedRating !== "" || statusTab !== "all";

  return (
    <div className="h-screen w-full bg-[#121212] text-[#EAD9C6] flex flex-col font-sans overflow-hidden antialiased selection:bg-[#D98A6C] selection:text-[#121212]">
      
      {/* 1. Splash / Importing Overlay */}
      {importing && (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center p-6 space-y-4">
          <Brain className="w-12 h-12 text-[#D98A6C] animate-spin" />
          <h2 className="text-base font-extrabold uppercase tracking-wide">Importing Paperback Backup</h2>
          <div className="w-64 h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div style={{ width: `${importProgress}%` }} className="h-full bg-[#D98A6C] transition-all duration-300" />
          </div>
          <p className="text-xs text-zinc-500 font-mono">Unzipping and fuzzy merging titles... {importProgress}%</p>
        </div>
      )}

      {/* 2. Top Bar Header */}
      <header className="h-14 border-b border-[#27272A] bg-[#161618] px-6 flex items-center justify-between flex-shrink-0 z-30">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[#D98A6C] rounded-lg flex items-center justify-center text-[#121212]">
              <Flame className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-[#EAD9C6]">Manga<span className="text-[#D98A6C]">Pulse</span></h1>
          </div>
          <span className="hidden sm:inline text-xs font-mono text-zinc-500 tracking-widest uppercase ml-4 border-l border-[#27272A] pl-4">
            Unified Workspace
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Clickable Sync Status Pill */}
          <div
            onClick={() => alert(`Sync status: ${syncStatus.status.toUpperCase()}\nLast updated: ${syncStatus.lastSyncTime ? new Date(syncStatus.lastSyncTime * 1000).toLocaleString() : "Never"}\nPending modifications count: ${syncStatus.pendingChangesCount}`)}
            className={`px-3 py-1 bg-[#121212] rounded-full border text-[10px] font-mono cursor-pointer flex items-center gap-2 transition-all ${
              syncStatus.status === "synced"
                ? "bg-green-950/20 border-green-500/20 text-green-400"
                : syncStatus.status === "error"
                  ? "bg-red-950/20 border-red-500/20 text-red-400"
                  : "bg-amber-950/20 border-amber-500/20 text-amber-400 animate-pulse"
            }`}
          >
            <div className={`w-2 h-2 rounded-full ${syncStatus.status === "synced" ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" : syncStatus.status === "error" ? "bg-red-500" : "bg-amber-500 animate-pulse"}`}></div>
            <span className="uppercase font-semibold text-[9px] tracking-wider">{syncStatus.status}</span>
            {syncStatus.lastSyncTime && (
              <span className="hidden sm:inline text-zinc-500">
                • {Math.round((Math.floor(Date.now() / 1000) - syncStatus.lastSyncTime) / 60)}m ago
              </span>
            )}
          </div>

          <button
            onClick={() => setIsAiOpen(true)}
            title="Consult AI Oracle"
            className="p-2 hover:bg-[#27272A] rounded-full transition-colors text-[#D98A6C] hover:text-[#e4a085] cursor-pointer"
          >
            <Brain className="w-5 h-5" />
          </button>

          <button
            onClick={handleForceRefresh}
            title="Force Pull remote database"
            className="p-2 hover:bg-[#27272A] rounded-full transition-colors text-zinc-400 hover:text-[#EAD9C6] cursor-pointer"
          >
            <RefreshCw className="w-4.5 h-4.5" />
          </button>

          <button
            onClick={() => setIsSettingsOpen(true)}
            title="Settings Console"
            className="p-2 hover:bg-[#27272A] rounded-full transition-colors text-zinc-400 hover:text-[#EAD9C6] cursor-pointer"
          >
            <Settings className="w-4.5 h-4.5" />
          </button>
        </div>
      </header>

      {/* Main Body scrolling workspace */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Unified scrolling canvas */}
        <main className="flex-1 overflow-y-auto py-8 px-6 md:px-12 bg-[#121212] scrollbar-thin scrollbar-thumb-zinc-800">
          <div className="max-w-6xl mx-auto space-y-10">

            {/* Section 1: CONTINUE READING */}
            {continueReadingManga.length > 0 && (
              <section className="space-y-4">
                <div className="flex items-center gap-2 border-b border-[#27272A]/40 pb-2">
                  <span className="w-2 h-2 rounded-full bg-[#D98A6C]" />
                  <h2 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 font-mono">Continue Reading</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  {continueReadingManga.map((m) => {
                    const lib = dataset.library.find((l) => l.mangaId === m.id);
                    const chaptersRead = lib?.chaptersRead || 0;
                    const total = m.totalChapters || 0;
                    const pct = total > 0 ? Math.min(100, Math.round((chaptersRead / total) * 100)) : 0;

                    return (
                      <div
                        key={m.id}
                        onClick={() => setActiveManga(m)}
                        className="group flex gap-4 p-4 bg-[#161618] border border-[#27272A] rounded-2xl hover:border-zinc-700 hover:bg-[#1a1a1d] cursor-pointer transition-all shadow-md relative overflow-hidden"
                      >
                        {/* Cover Art image */}
                        <div className="w-16 h-24 bg-zinc-900 rounded-xl overflow-hidden shrink-0 border border-zinc-800 relative">
                          {m.coverUrl ? (
                            <img
                              src={m.coverUrl}
                              alt={m.title}
                              className="w-full h-full object-cover transition-transform group-hover:scale-105"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-zinc-700 font-bold">📖</div>
                          )}
                        </div>

                        {/* Text and stats */}
                        <div className="flex flex-col justify-between flex-1 min-w-0 py-0.5">
                          <div className="space-y-1">
                            <div className="flex gap-1.5 flex-wrap items-center">
                              <span className="text-[8px] font-bold font-mono px-1.5 py-0.5 bg-[#D98A6C]/10 text-[#D98A6C] rounded uppercase tracking-wider">Active</span>
                              {m.isBinge && (
                                <span className="text-[8px] font-bold font-mono px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded uppercase tracking-wider">Bingeing</span>
                              )}
                            </div>
                            <h3 className="font-bold text-[#EAD9C6] text-xs uppercase line-clamp-1 group-hover:text-[#D98A6C] transition-all tracking-wide">{m.title}</h3>
                            <p className="text-[10px] text-zinc-500 truncate">{m.author || "Unknown Author"}</p>
                          </div>

                          <div className="space-y-1.5">
                            <div className="flex justify-between items-center text-[9px] font-mono text-zinc-400">
                              <span>Ch {chaptersRead} / {total || "∞"}</span>
                              <span className="text-zinc-500">{pct}%</span>
                            </div>
                            <div className="w-full h-1 bg-[#121212] rounded-full overflow-hidden">
                              <div
                                style={{ width: `${pct || 5}%` }}
                                className="h-full bg-[#D98A6C]"
                              />
                            </div>
                            <div className="text-[9px] text-zinc-500 font-mono flex items-center gap-1">
                              <Clock className="w-3 h-3 text-zinc-600" />
                              <span>{formatTimeAgo(m.lastRead || m.addedDate)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Section 2: READING MOMENTUM */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 border-b border-[#27272A]/40 pb-2">
                <span className="w-2 h-2 rounded-full bg-[#D98A6C]" />
                <h2 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 font-mono">Reading Momentum</h2>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Streak Card */}
                <div className="bg-[#161618] border border-[#27272A] rounded-2xl p-4 flex items-center gap-4 shadow-sm">
                  <div className="w-10 h-10 rounded-xl bg-[#D98A6C]/10 flex items-center justify-center text-[#D98A6C] shrink-0">
                    <Flame className="w-5 h-5" />
                  </div>
                  <div>
                    <span className="block text-[10px] text-zinc-500 font-mono uppercase">Daily Streak</span>
                    <span className="block text-lg font-bold font-mono text-[#EAD9C6] leading-tight">{activeStreak} <span className="text-xs font-normal text-zinc-500">Days</span></span>
                    <span className="block text-[8px] text-zinc-600 uppercase font-mono tracking-wider mt-0.5">Consecutive reading</span>
                  </div>
                </div>

                {/* Week Card */}
                <div className="bg-[#161618] border border-[#27272A] rounded-2xl p-4 flex items-center gap-4 shadow-sm">
                  <div className="w-10 h-10 rounded-xl bg-[#D98A6C]/10 flex items-center justify-center text-[#D98A6C] shrink-0">
                    <BookOpen className="w-5 h-5" />
                  </div>
                  <div>
                    <span className="block text-[10px] text-zinc-500 font-mono uppercase">This Week</span>
                    <span className="block text-lg font-bold font-mono text-[#EAD9C6] leading-tight">{chaptersThisWeek} <span className="text-xs font-normal text-zinc-500">Ch.</span></span>
                    <span className="block text-[8px] text-zinc-600 uppercase font-mono tracking-wider mt-0.5">Chapters completed</span>
                  </div>
                </div>

                {/* Month Card */}
                <div className="bg-[#161618] border border-[#27272A] rounded-2xl p-4 flex items-center gap-4 shadow-sm">
                  <div className="w-10 h-10 rounded-xl bg-[#D98A6C]/10 flex items-center justify-center text-[#D98A6C] shrink-0">
                    <Calendar className="w-5 h-5" />
                  </div>
                  <div>
                    <span className="block text-[10px] text-zinc-500 font-mono uppercase">This Month</span>
                    <span className="block text-lg font-bold font-mono text-[#EAD9C6] leading-tight">{chaptersThisMonth} <span className="text-xs font-normal text-zinc-500">Ch.</span></span>
                    <span className="block text-[8px] text-zinc-600 uppercase font-mono tracking-wider mt-0.5">Chapters completed</span>
                  </div>
                </div>

                {/* Speed Card */}
                <div className="bg-[#161618] border border-[#27272A] rounded-2xl p-4 flex items-center gap-4 shadow-sm">
                  <div className="w-10 h-10 rounded-xl bg-[#D98A6C]/10 flex items-center justify-center text-[#D98A6C] shrink-0">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <span className="block text-[10px] text-zinc-500 font-mono uppercase">Reading Pace</span>
                    <span className="block text-lg font-bold font-mono text-[#EAD9C6] leading-tight">
                      {dataset.stats?.velocity?.lifetime || 0} <span className="text-xs font-normal text-zinc-500">Ch/Day</span>
                    </span>
                    <span className="block text-[8px] text-[#D98A6C] uppercase font-mono font-bold tracking-wider mt-0.5">
                      {chaptersThisWeek > 14 ? "HIGH SPEED" : chaptersThisWeek > 5 ? "STEADY" : "MAINTAINING"}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* Section 3: READING RADAR */}
            <section className="space-y-4">
              <div className="flex items-center gap-2 border-b border-[#27272A]/40 pb-2">
                <span className="w-2 h-2 rounded-full bg-[#D98A6C]" />
                <h2 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 font-mono">Reading Radar Recommendations</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {radarRecommendations.map((rec, i) => (
                  <div
                    key={i}
                    className="p-5 bg-[#1a1311] border border-[#44281f] rounded-2xl text-[#f4dcd6] flex items-start gap-4 relative overflow-hidden group"
                  >
                    <div className="w-10 h-10 rounded-xl bg-[#44281f] flex items-center justify-center text-[#D98A6C] shrink-0">
                      <Sparkles className="w-5 h-5" />
                    </div>
                    <div className="space-y-2 flex-1">
                      <h3 className="font-extrabold uppercase font-mono text-[10px] tracking-wider text-[#D98A6C]">{rec.title}</h3>
                      <p className="text-xs text-[#EAD9C6]/85 leading-relaxed">{rec.description}</p>
                      
                      {rec.manga ? (
                        <button
                          onClick={() => setActiveManga(rec.manga)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#D98A6C] text-[#121212] hover:bg-[#e4a085] rounded-lg font-bold font-mono text-[9px] uppercase tracking-wider transition-colors cursor-pointer mt-2"
                        >
                          {rec.actionText} <ArrowRight className="w-3 h-3" />
                        </button>
                      ) : (
                        <div className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mt-1">Status: nominal</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Section 4: LIBRARY SECTIONS */}
            <section className="space-y-6">
              
              {/* Inline Search and Filter Bar */}
              <div className="bg-[#161618] p-5 rounded-2xl border border-[#27272A] space-y-4 shadow-sm">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1 relative">
                    <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search series titles, authors, translators, tags..."
                      className="w-full bg-[#121212] border border-[#27272A] rounded-xl pl-10 pr-4 py-2.5 text-xs text-[#EAD9C6] placeholder-zinc-500 focus:outline-none focus:border-[#D98A6C] transition-colors"
                    />
                  </div>

                  {/* Unzip Paperback Backups manually inline */}
                  <label className="px-4 py-2 bg-[#27272A] hover:bg-zinc-800 border border-[#27272A] text-zinc-300 hover:text-[#EAD9C6] rounded-xl text-xs font-bold text-center cursor-pointer flex items-center justify-center gap-1.5 transition-colors shrink-0 font-mono uppercase text-[10px] tracking-wider">
                    <Database className="w-4 h-4 text-[#D98A6C]" /> Unzip .pas4
                    <input
                      type="file"
                      accept=".pas4,.paperback,.json"
                      onChange={handlePaperbackImport}
                      className="hidden"
                    />
                  </label>
                </div>

                {/* Multiselect selectors */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                  <div>
                    <label className="block text-[9px] text-zinc-500 uppercase tracking-widest mb-1 font-mono">Genre Tag</label>
                    <select
                      value={selectedGenre}
                      onChange={(e) => setSelectedGenre(e.target.value)}
                      className="w-full bg-[#121212] text-xs text-[#EAD9C6] px-3 py-2 rounded-lg border border-[#27272A] focus:outline-none focus:border-[#D98A6C] font-mono text-[10px]"
                    >
                      <option value="">All Genres</option>
                      {uniqueGenres.map((g) => (
                        <option key={g} value={g}>{g}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[9px] text-zinc-500 uppercase tracking-widest mb-1 font-mono">Source Extension</label>
                    <select
                      value={selectedSource}
                      onChange={(e) => setSelectedSource(e.target.value)}
                      className="w-full bg-[#121212] text-xs text-[#EAD9C6] px-3 py-2 rounded-lg border border-[#27272A] focus:outline-none focus:border-[#D98A6C] font-mono text-[10px]"
                    >
                      <option value="">All Sources</option>
                      {uniqueSources.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[9px] text-zinc-500 uppercase tracking-widest mb-1 font-mono">Star Rating</label>
                    <select
                      value={selectedRating}
                      onChange={(e) => setSelectedRating(e.target.value === "" ? "" : parseInt(e.target.value, 10))}
                      className="w-full bg-[#121212] text-xs text-[#EAD9C6] px-3 py-2 rounded-lg border border-[#27272A] focus:outline-none focus:border-[#D98A6C] font-mono text-[10px]"
                    >
                      <option value="">All Ratings</option>
                      {[5, 4, 3, 2, 1, 0].map((r) => (
                        <option key={r} value={r}>{r} Stars</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[9px] text-zinc-500 uppercase tracking-widest mb-1 font-mono">Reading Status</label>
                    <select
                      value={statusTab}
                      onChange={(e) => setStatusTab(e.target.value as MangaStatus | "all")}
                      className="w-full bg-[#121212] text-xs text-[#EAD9C6] px-3 py-2 rounded-lg border border-[#27272A] focus:outline-none focus:border-[#D98A6C] font-mono text-[10px] uppercase"
                    >
                      <option value="all">All Statuses</option>
                      <option value="reading">Reading Now</option>
                      <option value="planning">Planned</option>
                      <option value="completed">Completed</option>
                      <option value="on_hold">On Hold</option>
                      <option value="dropped">Dropped</option>
                    </select>
                  </div>
                </div>

                {isFiltering && (
                  <div className="pt-2 flex justify-between items-center text-[10px] font-mono">
                    <span className="text-zinc-500 uppercase">Filters active: showing {filteredManga.length} series matches</span>
                    <button
                      onClick={() => {
                        setSearchQuery("");
                        setSelectedGenre("");
                        setSelectedSource("");
                        setSelectedRating("");
                        setStatusTab("all");
                      }}
                      className="text-[#D98A6C] hover:underline font-bold"
                    >
                      Clear All Filters
                    </button>
                  </div>
                )}
              </div>

              {/* Filtering / Search Results Active View */}
              {isFiltering ? (
                <div className="space-y-4">
                  <div className="flex justify-between items-center border-b border-[#27272A]/40 pb-2">
                    <h3 className="text-xs font-bold tracking-widest uppercase text-zinc-400 font-mono">Search & Filter Matches ({filteredManga.length})</h3>
                  </div>

                  {filteredManga.length === 0 ? (
                    <div className="bg-[#161618] border border-[#27272A] rounded-2xl p-12 text-center space-y-2">
                      <BookOpen className="w-10 h-10 text-zinc-600 mx-auto" />
                      <h4 className="font-bold text-[#EAD9C6] text-xs uppercase tracking-wider font-mono">No matched entries found</h4>
                      <p className="text-zinc-500 text-[10px]">Try resetting search values or setting broader genre/rating criteria.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-5">
                      {filteredManga.map((m) => {
                        const lib = dataset.library.find((l) => l.mangaId === m.id);
                        const progress = lib?.chaptersRead || 0;
                        const total = m.totalChapters || 0;

                        return (
                          <div
                            key={m.id}
                            onClick={() => setActiveManga(m)}
                            className="bg-[#161618] border border-[#27272A] hover:border-zinc-700 rounded-xl p-3 flex flex-col justify-between cursor-pointer hover:scale-[1.02] transition-all group shadow-md"
                          >
                            <div className="space-y-2">
                              <div className="aspect-[3/4] bg-zinc-900 rounded-lg overflow-hidden border border-[#27272A] relative">
                                {m.coverUrl ? (
                                  <img src={m.coverUrl} alt={m.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-zinc-700 bg-[#121212] font-bold">📖</div>
                                )}
                                {m.rating ? (
                                  <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/80 text-[#D98A6C] text-[8px] font-mono font-bold tracking-wider uppercase">
                                    ★ {m.rating}
                                  </span>
                                ) : null}
                              </div>
                              <div className="space-y-0.5">
                                <h4 className="font-bold text-xs truncate text-[#EAD9C6] group-hover:text-[#D98A6C] transition-all uppercase tracking-wide">{m.title}</h4>
                                <p className="text-[10px] text-zinc-500 truncate">{m.author || "Unknown Author"}</p>
                              </div>
                            </div>

                            <div className="pt-2 border-t border-[#27272A]/40 mt-3 space-y-1">
                              <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                                <span>Ch {progress}</span>
                                <span>/ {total || "∞"}</span>
                              </div>
                              {total > 0 && (
                                <div className="w-full h-1 bg-[#121212] rounded-full overflow-hidden">
                                  <div
                                    style={{ width: `${Math.min(100, (progress / total) * 100)}%` }}
                                    className="h-full bg-[#D98A6C]"
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                /* Primary Scrolling Horizontal Shelves */
                <div className="space-y-8">
                  
                  {/* Shelves 1: READING NOW */}
                  {readingNowManga.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex justify-between items-center border-b border-[#27272A]/30 pb-2">
                        <h3 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 font-mono flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-green-500" /> Reading Now ({readingNowManga.length})
                        </h3>
                      </div>
                      <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-zinc-800">
                        {readingNowManga.map((m) => {
                          const lib = dataset.library.find((l) => l.mangaId === m.id);
                          return (
                            <div
                              key={m.id}
                              onClick={() => setActiveManga(m)}
                              className="w-32 md:w-36 shrink-0 group relative cursor-pointer"
                            >
                              <div className="h-44 md:h-48 rounded-xl overflow-hidden relative border border-zinc-800/80 bg-zinc-900">
                                {m.coverUrl ? (
                                  <img src={m.coverUrl} alt={m.title} className="w-full h-full object-cover transition-transform group-hover:scale-105" referrerPolicy="no-referrer" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-zinc-700 bg-[#121212] font-bold">📖</div>
                                )}
                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                                  <span className="text-[9px] text-[#D98A6C] font-mono uppercase font-bold">Resume Tracking</span>
                                </div>
                                <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/85 text-[#D98A6C] text-[8px] font-mono font-bold border border-zinc-800">
                                  Ch {lib?.chaptersRead || 0}
                                </span>
                              </div>
                              <h4 className="mt-2 font-bold uppercase text-[10px] tracking-wide line-clamp-1 text-[#EAD9C6] group-hover:text-[#D98A6C] transition-colors">{m.title}</h4>
                              <p className="text-[9px] text-zinc-500 font-mono mt-0.5">{m.author || "Unknown"}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Shelves 2: STALLED */}
                  {stalledMangaShelf.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex justify-between items-center border-b border-[#27272A]/30 pb-2">
                        <h3 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 font-mono flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-amber-500" /> Stagnant / Stalled Series ({stalledMangaShelf.length})
                        </h3>
                      </div>
                      <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-zinc-800">
                        {stalledMangaShelf.map((m) => {
                          const lib = dataset.library.find((l) => l.mangaId === m.id);
                          return (
                            <div
                              key={m.id}
                              onClick={() => setActiveManga(m)}
                              className="w-32 md:w-36 shrink-0 group relative cursor-pointer opacity-75 hover:opacity-100 transition-all"
                            >
                              <div className="h-44 md:h-48 rounded-xl overflow-hidden relative border border-zinc-800/80 bg-zinc-900">
                                {m.coverUrl ? (
                                  <img src={m.coverUrl} alt={m.title} className="w-full h-full object-cover transition-transform group-hover:scale-105 grayscale group-hover:grayscale-0" referrerPolicy="no-referrer" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-zinc-700 bg-[#121212] font-bold">📖</div>
                                )}
                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                                  <span className="text-[9px] text-amber-500 font-mono uppercase font-bold">Unstall Series</span>
                                </div>
                                <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/85 text-amber-500 text-[8px] font-mono font-bold border border-zinc-800">
                                  Ch {lib?.chaptersRead || 0}
                                </span>
                              </div>
                              <h4 className="mt-2 font-bold uppercase text-[10px] tracking-wide line-clamp-1 text-[#EAD9C6] group-hover:text-[#D98A6C] transition-colors">{m.title}</h4>
                              <p className="text-[9px] text-zinc-500 font-mono mt-0.5">Last read {formatTimeAgo(m.lastRead || m.addedDate)}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Shelves 3: PLANNED */}
                  {plannedMangaShelf.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex justify-between items-center border-b border-[#27272A]/30 pb-2">
                        <h3 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 font-mono flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-zinc-500" /> Planned / On Hold ({plannedMangaShelf.length})
                        </h3>
                      </div>
                      <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-zinc-800">
                        {plannedMangaShelf.map((m) => {
                          return (
                            <div
                              key={m.id}
                              onClick={() => setActiveManga(m)}
                              className="w-32 md:w-36 shrink-0 group relative cursor-pointer"
                            >
                              <div className="h-44 md:h-48 rounded-xl overflow-hidden relative border border-zinc-800/80 bg-zinc-900">
                                {m.coverUrl ? (
                                  <img src={m.coverUrl} alt={m.title} className="w-full h-full object-cover transition-transform group-hover:scale-105" referrerPolicy="no-referrer" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-zinc-700 bg-[#121212] font-bold">📖</div>
                                )}
                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                                  <span className="text-[9px] text-zinc-400 font-mono uppercase font-bold">Start Reading</span>
                                </div>
                              </div>
                              <h4 className="mt-2 font-bold uppercase text-[10px] tracking-wide line-clamp-1 text-[#EAD9C6] group-hover:text-[#D98A6C] transition-colors">{m.title}</h4>
                              <p className="text-[9px] text-zinc-500 font-mono mt-0.5">{m.author || "Unknown"}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Shelves 4: RECENTLY ADDED */}
                  {recentlyAddedMangaShelf.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex justify-between items-center border-b border-[#27272A]/30 pb-2">
                        <h3 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 font-mono flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-indigo-500" /> Recently Ingested ({dataset.manga.length})
                        </h3>
                      </div>
                      <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-zinc-800">
                        {recentlyAddedMangaShelf.map((m) => {
                          return (
                            <div
                              key={m.id}
                              onClick={() => setActiveManga(m)}
                              className="w-32 md:w-36 shrink-0 group relative cursor-pointer"
                            >
                              <div className="h-44 md:h-48 rounded-xl overflow-hidden relative border border-zinc-800/80 bg-zinc-900">
                                {m.coverUrl ? (
                                  <img src={m.coverUrl} alt={m.title} className="w-full h-full object-cover transition-transform group-hover:scale-105" referrerPolicy="no-referrer" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-zinc-700 bg-[#121212] font-bold">📖</div>
                                )}
                              </div>
                              <h4 className="mt-2 font-bold uppercase text-[10px] tracking-wide line-clamp-1 text-[#EAD9C6] group-hover:text-[#D98A6C] transition-colors">{m.title}</h4>
                              <p className="text-[9px] text-zinc-500 font-mono mt-0.5">Added {formatTimeAgo(m.addedDate)}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Shelves 5: COMPLETED */}
                  {completedMangaShelf.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex justify-between items-center border-b border-[#27272A]/30 pb-2">
                        <h3 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 font-mono flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-500" /> Completed Shelves ({completedMangaShelf.length})
                        </h3>
                      </div>
                      <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-zinc-800">
                        {completedMangaShelf.map((m) => {
                          return (
                            <div
                              key={m.id}
                              onClick={() => setActiveManga(m)}
                              className="w-32 md:w-36 shrink-0 group relative cursor-pointer"
                            >
                              <div className="h-44 md:h-48 rounded-xl overflow-hidden relative border border-zinc-800/80 bg-zinc-900">
                                {m.coverUrl ? (
                                  <img src={m.coverUrl} alt={m.title} className="w-full h-full object-cover transition-transform group-hover:scale-105" referrerPolicy="no-referrer" />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-zinc-700 bg-[#121212] font-bold">📖</div>
                                )}
                                <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[8px] font-mono font-bold">
                                  ★ Done
                                </span>
                              </div>
                              <h4 className="mt-2 font-bold uppercase text-[10px] tracking-wide line-clamp-1 text-[#EAD9C6] group-hover:text-[#D98A6C] transition-colors">{m.title}</h4>
                              <p className="text-[9px] text-zinc-500 font-mono mt-0.5">Finished {formatTimeAgo(m.lastRead || m.addedDate)}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                </div>
              )}

            </section>

            {/* Section 5: SECONDARY ANALYTICS */}
            <section className="space-y-6">
              <div className="flex items-center gap-2 border-b border-[#27272A]/40 pb-2">
                <span className="w-2 h-2 rounded-full bg-[#D98A6C]" />
                <h2 className="text-[10px] font-bold tracking-widest uppercase text-zinc-400 font-mono">Secondary Core Analytics</h2>
              </div>

              {showDeepAnalytics ? (
                <div className="space-y-8 animate-fade-in">
                  {/* Heatmap Section */}
                  <div className="bg-[#161618] border border-[#27272A] rounded-2xl p-5 shadow-sm">
                    <ReadingHeatmap dataset={dataset} />
                  </div>

                  {/* Deep charts graphs */}
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2">
                      <AnalyticsOverview dataset={dataset} />
                    </div>
                    <div>
                      <TimeOfDayChart dataset={dataset} />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <TitleCompareMatrix dataset={dataset} />
                    <BackupPayloadChart dataset={dataset} />
                  </div>
                </div>
              ) : (
                <div className="bg-[#161618] border border-[#27272A] rounded-2xl p-8 text-center space-y-3 font-mono">
                  <Sparkles className="w-8 h-8 text-[#D98A6C]/80 mx-auto animate-pulse" />
                  <h3 className="font-bold text-[#EAD9C6] text-xs uppercase tracking-wider">Velocity Analysis & Reading Patterns</h3>
                  <p className="text-zinc-500 text-[10px] max-w-md mx-auto leading-relaxed">
                    You need at least 20 chapters of logged reading history before deep velocity trends, heatmaps, and pattern analytics become active. Continue reading and updating logs to unlock!
                  </p>
                </div>
              )}
            </section>

          </div>
        </main>

      </div>

      {/* 4. Bottom Status Bar */}
      <footer className="h-8 bg-[#121212] border-t border-[#27272A] px-6 flex items-center justify-between text-[10px] text-zinc-500 font-mono shrink-0">
        <div className="flex gap-4">
          <span>DB: {githubFilepath || "db.json"}</span>
          <span>Payload: {dataset.metadata?.history?.[dataset.metadata.history.length - 1]?.sizeKB || 412} KB</span>
        </div>
        <div className="flex gap-4">
          <span className="text-zinc-500">Paperback Import Support</span>
          <span className="text-[#D98A6C]/80 uppercase">Cache: IndexedDB</span>
        </div>
      </footer>

      {/* 5. Drawers / Overlay portals */}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        dataset={dataset}
        onSaveSettings={handleSaveSettings}
        onUpdateFullDataset={handleUpdateFullDataset}
        encryptedPat={encryptedPat}
        onSaveEncryptedPat={handleSaveEncryptedPat}
        githubRepo={githubRepo}
        onSaveRepo={handleSaveRepo}
        githubFilepath={githubFilepath}
        onSaveFilepath={handleSaveFilepath}
        rawBackup={rawBackup}
      />

      {/* AI Assistant drawer */}
      <AiOracle
        dataset={dataset}
        isOpen={isAiOpen}
        onClose={() => setIsAiOpen(false)}
      />

      {/* Context bottom panel */}
      {activeManga && (
        <ContextPanel
          manga={activeManga}
          libraryEntry={dataset.library.find((l) => l.mangaId === activeManga.id)}
          lifetimeVelocity={dataset.stats?.velocity?.lifetime || 0}
          onClose={() => setActiveManga(null)}
          onSaveManga={handleSaveManga}
          onUpdateProgress={handleUpdateProgress}
          onDeleteManga={handleDeleteManga}
          allManga={dataset.manga}
          onSelectManga={setActiveManga}
        />
      )}

      {/* Conflict resolution portal */}
      {conflictData && (
        <ConflictResolutionModal
          local={conflictData.local}
          remote={conflictData.remote}
          onCancel={() => setConflictData(null)}
          onResolve={handleResolveConflicts}
        />
      )}

    </div>
  );
}
