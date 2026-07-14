import React, { useState, useEffect } from "react";
import { DBDataset, MangaEntry, LibraryEntry, AppSettings, SyncStatus, MangaStatus } from "./types";
import { getDbDataset, saveDbDataset, getLocalItem, setLocalItem, getDefaultDataset, addErrorLog } from "./utils/db";
import { fetchFromGitHub, pushToGitHub, testGitHubConnection, hasDatasetChanged } from "./utils/github";
import { decryptText } from "./utils/crypto";
import { parsePaperbackBackup } from "./utils/paperback";
import { calculateReadingStreak, calculateVelocities } from "./utils/analytics";

// Component Imports
import { ReadingHeatmap, TimeOfDayChart, AnalyticsOverview, TitleCompareMatrix, BackupPayloadChart } from "./components/Charts";
import { AiOracle } from "./components/AiOracle";
import { ContextPanel } from "./components/ContextPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ConflictResolutionModal } from "./components/ConflictResolutionModal";

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
        setDataset(localData);

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
        const changeMsg = `Synced: Updated library with ${localData.manga.length} titles`;
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

      // Save into local IndexedDB
      setDataset(parsedDataset);
      await saveDbDataset(parsedDataset);

      setImportProgress(100);
      alert(`Import complete! Loaded and fuzzy-merged ${parsedDataset.manga.length} titles.`);

      // Prompt to push to GitHub if connected
      if (encryptedPat && githubRepo) {
        const pass = prompt("MangaPulse parsed. Enter passphrase to push this imported library directly to your GitHub repository:");
        if (pass) {
          const pat = await decryptText(encryptedPat, pass);
          await performSynchronization(pat, githubRepo, githubFilepath, parsedDataset);
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
          // Calculate if binge row eligibility applies
          isBinge: chaptersRead > 5,
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

    const nextDataset: DBDataset = {
      ...dataset,
      manga: mangaList,
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
    const matchingManga = mangaList.find((m) => m.id === mangaId);
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
          <nav className="hidden md:flex gap-6 ml-10 text-sm font-medium text-zinc-400">
            <button
              onClick={() => { setStatusTab("all"); setSearchQuery(""); }}
              className={`pb-4 -mb-4 px-1 transition-colors cursor-pointer ${statusTab === "all" && searchQuery === "" ? "text-[#D98A6C] border-b-2 border-[#D98A6C]" : "hover:text-[#EAD9C6]"}`}
            >
              Dashboard
            </button>
            <button
              onClick={() => { setStatusTab("reading"); }}
              className={`pb-4 -mb-4 px-1 transition-colors cursor-pointer ${statusTab === "reading" ? "text-[#D98A6C] border-b-2 border-[#D98A6C]" : "hover:text-[#EAD9C6]"}`}
            >
              Library
            </button>
            <button
              onClick={() => {
                const elem = document.getElementById("analytics-charts");
                elem?.scrollIntoView({ behavior: "smooth" });
              }}
              className="hover:text-[#EAD9C6] transition-colors cursor-pointer pb-4 -mb-4 px-1"
            >
              Analytics
            </button>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="hover:text-[#EAD9C6] transition-colors cursor-pointer pb-4 -mb-4 px-1"
            >
              Import
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          {/* Clickable Sync indicator bubble */}
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
            <span className="uppercase font-semibold">{syncStatus.status}</span>
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
            title="Settings"
            className="p-2 hover:bg-[#27272A] rounded-full transition-colors text-zinc-400 hover:text-[#EAD9C6] cursor-pointer"
          >
            <Settings className="w-4.5 h-4.5" />
          </button>
        </div>
      </header>

      {/* Main Body with Sidebar + Main content flex layout */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Sidebar / Stats Rail */}
        <aside className="hidden lg:flex w-64 bg-[#161618] border-r border-[#27272A] p-6 flex-col gap-8 shrink-0 overflow-y-auto">
          <section>
            <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-4 font-mono">Library Stats</h3>
            <div className="grid gap-3">
              <div className="bg-[#121212] p-3 rounded-lg border border-[#27272A]">
                <div className="text-xs text-zinc-400">Tracked Titles</div>
                <div className="text-2xl font-bold text-[#EAD9C6] font-mono">{dataset.manga.length}</div>
              </div>
              <div className="bg-[#121212] p-3 rounded-lg border border-[#27272A]">
                <div className="text-xs text-zinc-400">Total Chapters</div>
                <div className="text-2xl font-bold text-[#EAD9C6] font-mono">{dataset.stats?.totalChaptersRead || 0}</div>
              </div>
              <div className="bg-[#121212] p-3 rounded-lg border border-[#27272A]">
                <div className="text-xs text-zinc-400">Current Streak</div>
                <div className="text-2xl font-bold text-[#D98A6C] font-mono">
                  {activeStreak} <span className="text-xs font-normal text-zinc-500">days</span>
                </div>
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-4 font-mono">Filters</h3>
            <div className="flex flex-col gap-1">
              {(["reading", "planned", "completed", "dropped", "all"] as Array<MangaStatus | "all">).map((st) => {
                const count = st === "all" ? dataset.manga.length : dataset.manga.filter((m) => m.status === st).length;
                const isActive = statusTab === st;
                return (
                  <button
                    key={st}
                    onClick={() => setStatusTab(st)}
                    className={`flex items-center justify-between w-full px-3 py-2 rounded-md text-sm font-medium transition-all cursor-pointer ${
                      isActive
                        ? "bg-[#D98A6C]/10 text-[#D98A6C]"
                        : "text-zinc-400 hover:text-[#EAD9C6] hover:bg-[#27272A]/10"
                    }`}
                  >
                    <span className="capitalize">{st}</span>
                    <span className={`text-[10px] px-1.5 rounded font-mono ${isActive ? "bg-[#D98A6C] text-[#121212]" : "bg-[#27272A] text-zinc-400"}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="mt-auto">
            <div className="p-4 rounded-xl bg-gradient-to-br from-[#D98A6C]/20 to-transparent border border-[#D98A6C]/30">
              <div className="text-xs text-[#D98A6C] font-bold mb-1 tracking-wider font-mono">VELOCITY</div>
              <div className="text-lg font-bold italic text-[#EAD9C6] font-mono">
                {dataset.stats?.velocity?.lifetime || 0} <span className="text-xs font-normal opacity-70 italic font-mono">ch/day</span>
              </div>
              <div className="h-1 w-full bg-[#121212] rounded-full mt-3 overflow-hidden">
                <div
                  className="h-full bg-[#D98A6C]"
                  style={{
                    width: `${Math.min(100, ((dataset.stats?.velocity?.lifetime || 0) / 3) * 100)}%`,
                  }}
                ></div>
              </div>
              <div className="text-[9px] text-zinc-500 mt-2 tracking-wide uppercase font-mono">Lifetime reading pace</div>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 p-6 md:p-8 overflow-y-auto space-y-8">
          
          {/* Overview bento blocks - only visible on mobile/tablet because sidebar covers it on desktop */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 lg:hidden animate-fade-in" id="stats-grid">
            <div className="bg-[#161618] p-4 rounded-xl border border-[#27272A] flex flex-col justify-between">
              <span className="text-zinc-500 uppercase tracking-wider text-[9px] font-bold font-mono">Total Tracked Titles</span>
              <span className="text-2xl font-extrabold text-[#EAD9C6] font-mono mt-1">{dataset.manga.length}</span>
            </div>

            <div className="bg-[#161618] p-4 rounded-xl border border-[#27272A] flex flex-col justify-between">
              <span className="text-zinc-500 uppercase tracking-wider text-[9px] font-bold font-mono">Read Chapters</span>
              <span className="text-2xl font-extrabold text-[#EAD9C6] font-mono mt-1">{dataset.stats?.totalChaptersRead || 0}</span>
            </div>

            <div className="bg-[#161618] p-4 rounded-xl border border-[#27272A] flex flex-col justify-between">
              <span className="text-zinc-500 uppercase tracking-wider text-[9px] font-bold font-mono">Current Streak</span>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-2xl font-extrabold text-[#D98A6C] font-mono">{activeStreak}</span>
                <span className="text-xs text-zinc-400">days</span>
              </div>
            </div>

            <div className="bg-[#161618] p-4 rounded-xl border border-[#27272A] flex flex-col justify-between">
              <span className="text-zinc-500 uppercase tracking-wider text-[9px] font-bold font-mono">Velocity (Lifetime)</span>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-2xl font-extrabold text-[#EAD9C6] font-mono">{dataset.stats?.velocity?.lifetime || 0}</span>
                <span className="text-xs text-zinc-400">Ch/Day</span>
              </div>
            </div>
          </div>

          {/* Binge Bucket Section */}
          {bingeRowManga.length > 0 && (
            <section className="space-y-4" id="binge-row">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold tracking-widest uppercase text-zinc-400 flex items-center gap-2 font-mono">
                  <span className="w-2 h-2 rounded-full bg-[#D98A6C] animate-pulse"></span>
                  Binge Bucket
                </h2>
                <span className="text-[10px] text-zinc-500 font-mono uppercase">Last 48 Hours</span>
              </div>
              <div className="flex gap-4 overflow-x-auto pb-3 snap-x scrollbar-thin scrollbar-thumb-zinc-800">
                {bingeRowManga.map((m) => {
                  const lib = dataset.library.find((l) => l.mangaId === m.id);
                  return (
                    <div
                      key={m.id}
                      onClick={() => setActiveManga(m)}
                      className="w-[220px] bg-[#161618] border-2 border-[#D98A6C] rounded-xl overflow-hidden shadow-xl shrink-0 snap-start cursor-pointer hover:scale-[1.02] transition-transform duration-200"
                    >
                      <div className="h-32 bg-zinc-800 relative overflow-hidden">
                        {m.coverUrl ? (
                          <img
                            src={m.coverUrl}
                            alt={m.title}
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-zinc-600 font-bold bg-[#121212]">📖</div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-[#161618] to-transparent"></div>
                        <div className="absolute bottom-2 left-3">
                          <span className="px-1.5 py-0.5 bg-[#D98A6C] text-[#121212] text-[10px] font-bold rounded uppercase tracking-wider font-mono">Binging</span>
                        </div>
                      </div>
                      <div className="p-3 space-y-1">
                        <h4 className="font-bold text-sm truncate text-[#EAD9C6]">{m.title}</h4>
                        <p className="text-[10px] text-zinc-500 font-mono">{lib?.chaptersRead || 0} chapters read</p>
                        <div className="flex justify-between items-end pt-1">
                          <div className="text-xs">
                            <span className="text-[#EAD9C6] font-bold font-mono">{lib?.chaptersRead || 0}</span>
                            <span className="text-zinc-600 font-mono">/{m.totalChapters || "∞"}</span>
                          </div>
                          <div className="text-[10px] text-zinc-500 font-mono">
                            {m.totalChapters ? `${Math.round(((lib?.chaptersRead || 0) / m.totalChapters) * 100)}% done` : "ongoing"}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Stalled Row Section */}
          {stalledRowManga.length > 0 && (
            <section className="space-y-4" id="stalled-row">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold tracking-widest uppercase text-zinc-400 flex items-center gap-2 font-mono">
                  <span className="w-2 h-2 rounded-full bg-yellow-600/80"></span>
                  Stalled Bucket
                </h2>
                <span className="text-[10px] text-zinc-500 font-mono uppercase">Inactive series</span>
              </div>
              <div className="flex gap-4 overflow-x-auto pb-3 snap-x scrollbar-thin scrollbar-thumb-zinc-800">
                {stalledRowManga.map((m) => {
                  const lib = dataset.library.find((l) => l.mangaId === m.id);
                  return (
                    <div
                      key={m.id}
                      onClick={() => setActiveManga(m)}
                      className="w-[220px] bg-[#161618] border border-[#27272A] rounded-xl overflow-hidden shadow-md shrink-0 snap-start cursor-pointer opacity-80 hover:opacity-100 hover:border-yellow-600/50 hover:scale-[1.02] transition-all duration-200"
                    >
                      <div className="h-32 bg-zinc-800 relative overflow-hidden">
                        {m.coverUrl ? (
                          <img
                            src={m.coverUrl}
                            alt={m.title}
                            className="w-full h-full object-cover grayscale"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-zinc-600 font-bold bg-[#121212]">📖</div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-[#161618] to-transparent"></div>
                        <div className="absolute bottom-2 left-3">
                          <span className="px-1.5 py-0.5 bg-yellow-600/80 text-white text-[10px] font-bold rounded uppercase tracking-wider font-mono">Stalled</span>
                        </div>
                      </div>
                      <div className="p-3 space-y-1">
                        <h4 className="font-bold text-sm truncate text-[#EAD9C6]">{m.title}</h4>
                        <p className="text-[10px] text-zinc-500 font-mono">Last: {lib ? new Date(lib.lastRead * 1000).toLocaleDateString() : "Never"}</p>
                        <div className="flex justify-between items-end pt-1">
                          <div className="text-xs">
                            <span className="text-[#EAD9C6] font-bold font-mono">{lib?.chaptersRead || 0}</span>
                            <span className="text-zinc-600 font-mono">/{m.totalChapters || "∞"}</span>
                          </div>
                          <div className="text-[10px] text-zinc-500 font-mono">
                            {m.totalChapters ? `${Math.round(((lib?.chaptersRead || 0) / m.totalChapters) * 100)}% done` : "ongoing"}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Active Reading Section & Filters */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold tracking-widest uppercase text-zinc-400 font-mono">Active Library</h2>
              <div className="flex items-center gap-2 text-xs font-mono">
                <span className="text-zinc-500 uppercase">Sort:</span>
                <span className="text-[#D98A6C] font-semibold">Recent</span>
              </div>
            </div>

            {/* Filter controls panel */}
            <div className="bg-[#161618] p-5 rounded-xl border border-[#27272A] space-y-4">
              {/* Search and Paperback Unpacker */}
              <div className="flex flex-col md:flex-row gap-3">
                <div className="flex-1 relative">
                  <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search library titles, authors, extensions..."
                    className="w-full bg-[#121212] border border-[#27272A] rounded-lg pl-10 pr-4 py-2 text-xs text-[#EAD9C6] placeholder-zinc-500 focus:outline-none focus:border-[#D98A6C] transition-colors"
                  />
                </div>

                {/* Backup unpacker label */}
                <label className="px-4 py-2 bg-[#27272A] hover:bg-zinc-800 border border-[#27272A] text-zinc-300 hover:text-[#EAD9C6] rounded-lg text-xs font-bold text-center cursor-pointer flex items-center justify-center gap-1.5 transition-colors shrink-0">
                  <Database className="w-4 h-4 text-[#D98A6C]" /> Unzip .pas4 Backup
                  <input
                    type="file"
                    accept=".pas4,.paperback,.json"
                    onChange={handlePaperbackImport}
                    className="hidden"
                  />
                </label>
              </div>

              {/* Status Tabs ROW - ONLY visible on mobile/tablet */}
              <div className="flex flex-wrap gap-2 border-b border-[#27272A]/50 pb-3 justify-between items-center lg:hidden">
                <div className="flex flex-wrap gap-1.5">
                  {(["reading", "planned", "completed", "dropped", "all"] as Array<MangaStatus | "all">).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setStatusTab(tab)}
                      className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
                        statusTab === tab
                          ? "bg-[#D98A6C] text-[#121212]"
                          : "bg-[#121212] border border-[#27272A] text-zinc-400 hover:text-[#EAD9C6]"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-4">
                  {/* Grid / List view selectors */}
                  <div className="flex gap-1.5 bg-[#121212] p-1 rounded-lg border border-[#27272A]">
                    <button
                      onClick={() => setViewMode("grid")}
                      className={`p-1.5 rounded ${viewMode === "grid" ? "bg-[#27272A] text-[#D98A6C]" : "text-zinc-500 hover:text-zinc-300"} cursor-pointer`}
                    >
                      <Grid className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setViewMode("row")}
                      className={`p-1.5 rounded ${viewMode === "row" ? "bg-[#27272A] text-[#D98A6C]" : "text-zinc-500 hover:text-zinc-300"} cursor-pointer`}
                    >
                      <List className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Archive toggler */}
                  <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeArchived}
                      onChange={(e) => setIncludeArchived(e.target.checked)}
                      className="accent-[#D98A6C] rounded"
                    />
                    Archived
                  </label>
                </div>
              </div>

              {/* Advanced filter toggles and view selectors for Desktop (since tabs are hidden on desktop) */}
              <div className="hidden lg:flex justify-between items-center border-b border-[#27272A]/50 pb-3">
                <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">Advanced Filters</span>
                <div className="flex items-center gap-4">
                  <div className="flex gap-1.5 bg-[#121212] p-1 rounded-lg border border-[#27272A]">
                    <button
                      onClick={() => setViewMode("grid")}
                      title="Grid View"
                      className={`p-1.5 rounded ${viewMode === "grid" ? "bg-[#27272A] text-[#D98A6C]" : "text-zinc-500 hover:text-zinc-300"} cursor-pointer`}
                    >
                      <Grid className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setViewMode("row")}
                      title="Row List View"
                      className={`p-1.5 rounded ${viewMode === "row" ? "bg-[#27272A] text-[#D98A6C]" : "text-zinc-500 hover:text-zinc-300"} cursor-pointer`}
                    >
                      <List className="w-4 h-4" />
                    </button>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeArchived}
                      onChange={(e) => setIncludeArchived(e.target.checked)}
                      className="accent-[#D98A6C] rounded"
                    />
                    Show Archived
                  </label>
                </div>
              </div>

              {/* Advanced filter selectors */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1 font-mono">Filter by Genre</label>
                  <select
                    value={selectedGenre}
                    onChange={(e) => setSelectedGenre(e.target.value)}
                    className="w-full bg-[#121212] text-xs text-[#EAD9C6] px-3 py-2 rounded-lg border border-[#27272A] focus:outline-none focus:border-[#D98A6C]"
                  >
                    <option value="">All Genres</option>
                    {uniqueGenres.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1 font-mono">Filter by Source Extension</label>
                  <select
                    value={selectedSource}
                    onChange={(e) => setSelectedSource(e.target.value)}
                    className="w-full bg-[#121212] text-xs text-[#EAD9C6] px-3 py-2 rounded-lg border border-[#27272A] focus:outline-none focus:border-[#D98A6C]"
                  >
                    <option value="">All Sources</option>
                    {uniqueSources.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1 font-mono">Filter by Star Rating</label>
                  <select
                    value={selectedRating}
                    onChange={(e) => setSelectedRating(e.target.value === "" ? "" : parseInt(e.target.value, 10))}
                    className="w-full bg-[#121212] text-xs text-[#EAD9C6] px-3 py-2 rounded-lg border border-[#27272A] focus:outline-none focus:border-[#D98A6C]"
                  >
                    <option value="">All Ratings</option>
                    {[5, 4, 3, 2, 1, 0].map((r) => (
                      <option key={r} value={r}>{r} Stars</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Core Library Listing Grid/Row */}
            {filteredManga.length === 0 ? (
              <div className="bg-[#161618] border border-[#27272A] rounded-2xl p-12 text-center space-y-3" id="empty-state">
                <BookOpen className="w-10 h-10 text-zinc-600 mx-auto" />
                <h3 className="font-bold text-[#EAD9C6]">No matching series found</h3>
                <p className="text-zinc-500 text-xs">Try adjusting your filters, searching other titles, or unpacking a new `.pas4` Paperback backup.</p>
              </div>
            ) : viewMode === "grid" ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4" id="manga-grid">
                {filteredManga.map((m) => {
                  const lib = dataset.library.find((l) => l.mangaId === m.id);
                  return (
                    <div
                      key={m.id}
                      onClick={() => setActiveManga(m)}
                      className="bg-[#161618] border border-[#27272A] hover:border-zinc-700 p-3 rounded-xl flex flex-col justify-between cursor-pointer hover:scale-[1.02] transition-all group shadow-sm"
                    >
                      <div className="space-y-2">
                        <div className="aspect-[3/4] bg-zinc-900 rounded-lg overflow-hidden border border-[#27272A] relative">
                          {m.coverUrl ? (
                            <img src={m.coverUrl} alt={m.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-zinc-700 bg-[#121212]">📖</div>
                          )}
                          {m.status === "archived" && (
                            <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/80 border border-[#27272A] text-zinc-500 text-[8px] uppercase font-bold tracking-wider font-mono">
                              Archived
                            </span>
                          )}
                        </div>
                        <div className="space-y-0.5">
                          <p className="font-bold text-xs truncate text-[#EAD9C6] group-hover:text-[#D98A6C] transition-colors">{m.title}</p>
                          <p className="text-[10px] text-zinc-500 truncate">{m.author || "Unknown Author"}</p>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-[#27272A]/40 mt-2 space-y-1.5">
                        <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                          <span>Ch: {lib?.chaptersRead || 0}</span>
                          <span>/ {m.totalChapters || "∞"}</span>
                        </div>
                        {m.totalChapters > 0 && (
                          <div className="w-full h-1 bg-[#121212] rounded-full overflow-hidden">
                            <div
                              style={{ width: `${Math.min(100, ((lib?.chaptersRead || 0) / m.totalChapters) * 100)}%` }}
                              className="h-full bg-[#D98A6C]"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="bg-[#161618] border border-[#27272A] rounded-xl divide-y divide-[#27272A]" id="manga-list-rows">
                {filteredManga.map((m) => {
                  const lib = dataset.library.find((l) => l.mangaId === m.id);
                  return (
                    <div
                      key={m.id}
                      onClick={() => setActiveManga(m)}
                      className="p-3 hover:bg-[#27272A]/15 cursor-pointer flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-14 bg-zinc-900 rounded border border-[#27272A] overflow-hidden shrink-0">
                          {m.coverUrl ? (
                            <img src={m.coverUrl} alt={m.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-zinc-700 bg-[#121212]">📖</div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-xs text-[#EAD9C6] truncate">{m.title}</p>
                          <p className="text-[10px] text-zinc-500 truncate">{m.author || "Unknown Author"} • {m.sourceId}</p>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <span className="text-xs font-bold text-[#D98A6C] font-mono">Ch {lib?.chaptersRead || 0}</span>
                        <span className="text-[10px] text-zinc-500 font-mono"> / {m.totalChapters || "∞"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Heatmap Section */}
          <section>
            <ReadingHeatmap dataset={dataset} />
          </section>

          {/* Deep analytics & charts graphs */}
          <section id="analytics-charts" className="space-y-6 pt-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2.5 h-2.5 rounded-full bg-[#D98A6C]" />
              <h2 className="text-sm font-bold tracking-widest uppercase text-zinc-400 font-mono">Analytics Suite</h2>
            </div>
            
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
          </section>

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
