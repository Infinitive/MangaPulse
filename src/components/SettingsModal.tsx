import React, { useState, useEffect } from "react";
import { DBDataset, AppSettings, ErrorLog, SyncStatus } from "../types";
import { testGitHubConnection, createGitHubRepository } from "../utils/github";
import { encryptText, decryptText } from "../utils/crypto";
import { getErrorLogs, clearErrorLogs } from "../utils/db";
import { Settings, Lock, Unlock, Key, Github, RefreshCw, Sliders, AlertCircle, FileJson, Trash2, X } from "lucide-react";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  dataset: DBDataset;
  onSaveSettings: (settings: AppSettings) => void;
  onUpdateFullDataset: (newDataset: DBDataset) => void;
  // GitHub states
  encryptedPat: string;
  onSaveEncryptedPat: (encPat: string) => void;
  githubRepo: string;
  onSaveRepo: (repo: string) => void;
  githubFilepath: string;
  onSaveFilepath: (path: string) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  dataset,
  onSaveSettings,
  onUpdateFullDataset,
  encryptedPat,
  onSaveEncryptedPat,
  githubRepo,
  onSaveRepo,
  githubFilepath,
  onSaveFilepath,
}: SettingsModalProps) {
  // Passphrase flow
  const [passphrase, setPassphrase] = useState("");
  const [rawPat, setRawPat] = useState("");
  const [isPatDecrypted, setIsPatDecrypted] = useState(false);

  // Settings sliders
  const [stallThresholdDays, setStallThresholdDays] = useState(dataset.settings?.stallThresholdDays || 14);
  const [bingeThresholdHours, setBingeThresholdHours] = useState(dataset.settings?.bingeThresholdHours || 48);
  const [easyThreshold, setEasyThreshold] = useState(dataset.settings?.difficultyThresholds?.easy || 50);
  const [mediumThreshold, setMediumThreshold] = useState(dataset.settings?.difficultyThresholds?.medium || 200);

  // Repo inputs
  const [repoInput, setRepoInput] = useState(githubRepo || "");
  const [filepathInput, setFilepathInput] = useState(githubFilepath || "db.json");

  // Diagnostics
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [creatingRepo, setCreatingRepo] = useState(false);

  // Error Log Console
  const [logs, setLogs] = useState<ErrorLog[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadLogs();
      setRepoInput(githubRepo);
      setFilepathInput(githubFilepath);
    }
  }, [isOpen, githubRepo, githubFilepath]);

  const loadLogs = async () => {
    const errorLogs = await getErrorLogs();
    setLogs(errorLogs);
  };

  const handleClearLogs = async () => {
    await clearErrorLogs();
    setLogs([]);
  };

  if (!isOpen) return null;

  // Cryptography handlers
  const handleDecryptPAT = async () => {
    if (!encryptedPat) {
      alert("No encrypted PAT is currently saved in local storage. Enter a PAT below to encrypt and save first.");
      return;
    }
    if (!passphrase) {
      alert("Please enter a decryption passphrase.");
      return;
    }
    try {
      const decrypted = await decryptText(encryptedPat, passphrase);
      setRawPat(decrypted);
      setIsPatDecrypted(true);
      setTestResult(null);
    } catch (e: any) {
      alert(e.message || "Decryption failed. Please check your passphrase.");
    }
  };

  const handleEncryptAndSavePAT = async () => {
    if (!rawPat) {
      alert("Please enter a raw PAT token.");
      return;
    }
    if (!passphrase) {
      alert("Please provide a passphrase to encrypt and secure your PAT.");
      return;
    }
    try {
      const encrypted = await encryptText(rawPat, passphrase);
      onSaveEncryptedPat(encrypted);
      setIsPatDecrypted(true);
      alert("PAT securely encrypted with AES-256 and stored in localStorage!");
    } catch (e: any) {
      alert("Encryption failure: " + e.message);
    }
  };

  const handleTestConnection = async () => {
    if (!rawPat) {
      alert("Please decrypt your saved PAT or input a PAT token first before testing.");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testGitHubConnection(rawPat, repoInput, filepathInput);
      setTestResult(result);
      if (result.success) {
        onSaveRepo(repoInput);
        onSaveFilepath(filepathInput);
      }
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || "Connection failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleCreateRepo = async () => {
    if (!rawPat) {
      alert("Please decrypt your saved PAT or input a PAT token first before creating a repository.");
      return;
    }
    if (!repoInput) {
      alert("Please enter a desired repository name first (e.g. johndoe/manga-backup).");
      return;
    }
    setCreatingRepo(true);
    setTestResult(null);
    try {
      const result = await createGitHubRepository(rawPat, repoInput, true);
      if (result.success && result.repoPath) {
        setRepoInput(result.repoPath);
        onSaveRepo(result.repoPath);
        setTestResult({ success: true, message: result.message });
      } else {
        setTestResult({ success: false, message: result.message });
      }
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || "Repository creation failed" });
    } finally {
      setCreatingRepo(false);
    }
  };

  // Sliders save
  const handleSaveConfig = () => {
    onSaveSettings({
      stallThresholdDays,
      bingeThresholdHours,
      difficultyThresholds: {
        easy: easyThreshold,
        medium: mediumThreshold,
        hard: mediumThreshold + 300, // automatic sliding gap
      },
    });
    onSaveRepo(repoInput);
    onSaveFilepath(filepathInput);
    onClose();
  };

  // Raw local JSON imports
  const handleJSONImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        if (!json.manga || !json.library) {
          alert("Invalid MangaPulse schema: File must contain 'manga' and 'library' arrays.");
          return;
        }
        onUpdateFullDataset(json);
        alert(`Successfully restored ${json.manga.length} titles and statistics!`);
      } catch (err: any) {
        alert("Failed to parse JSON file: " + err.message);
      }
    };
    reader.readAsText(file);
  };

  const handleJSONExport = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(dataset, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `mangapulse_backup_${Math.floor(Date.now() / 1000)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-[#161618] border border-[#27272A] w-full max-w-lg rounded-2xl flex flex-col max-h-[90vh] text-xs text-[#EAD9C6]">
        {/* Header */}
        <div className="p-4 border-b border-[#27272A] flex justify-between items-center bg-[#121212] rounded-t-2xl">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-[#D98A6C]" />
            <h2 className="font-extrabold uppercase tracking-wide">MangaPulse Settings Console</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-[#27272A] rounded-md text-zinc-400 hover:text-[#EAD9C6] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal body (Scrollable) */}
        <div className="p-5 flex-1 overflow-y-auto space-y-6 scrollbar-thin scrollbar-thumb-zinc-800">
          
          {/* GitHub PAT Secure Management */}
          <div className="space-y-3 bg-[#121212] p-4 rounded-xl border border-[#27272A]">
            <h3 className="font-bold uppercase tracking-wider text-[10px] text-zinc-400 flex items-center gap-1">
              <Lock className="w-3.5 h-3.5 text-[#D98A6C]" /> Secure GitHub PAT Storage (AES-256)
            </h3>

            <div className="space-y-2">
              <label className="block text-[10px] text-zinc-500 uppercase tracking-wide">Security Passphrase</label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Passphrase to encrypt/decrypt Token..."
                className="w-full bg-[#161618] border border-[#27272A] rounded px-3 py-1.5 text-xs text-[#EAD9C6] placeholder-zinc-600 focus:outline-none focus:border-[#D98A6C]"
              />
            </div>

            {encryptedPat && !isPatDecrypted ? (
              <div className="pt-2 flex gap-2">
                <button
                  onClick={handleDecryptPAT}
                  className="flex items-center justify-center gap-1 px-3 py-1.5 bg-[#27272A] hover:bg-[#D98A6C] text-zinc-300 hover:text-[#121212] rounded font-semibold border border-transparent transition-all cursor-pointer"
                >
                  <Unlock className="w-3.5 h-3.5" /> Decrypt Stored Token
                </button>
                <div className="text-[10px] text-zinc-500 self-center">⚠️ Saved PAT is encrypted. Decrypt first to test or edit.</div>
              </div>
            ) : (
              <div className="space-y-3 pt-2">
                <div>
                  <label className="block text-[10px] text-zinc-500 uppercase tracking-wide mb-1">GitHub Personal Access Token (PAT)</label>
                  <input
                    type="password"
                    value={rawPat}
                    onChange={(e) => setRawPat(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxx..."
                    className="w-full bg-[#161618] border border-[#27272A] rounded px-3 py-1.5 text-xs text-[#EAD9C6] placeholder-zinc-600 focus:outline-none focus:border-[#D98A6C] font-mono"
                  />
                </div>
                <button
                  onClick={handleEncryptAndSavePAT}
                  className="px-3 py-1.5 bg-[#D98A6C] hover:bg-[#e4a085] text-[#121212] rounded font-bold transition-colors cursor-pointer"
                >
                  Encrypt & Save to LocalStorage
                </button>
              </div>
            )}
          </div>

          {/* Repository synchronization */}
          <div className="space-y-3 bg-[#121212] p-4 rounded-xl border border-[#27272A]">
            <h3 className="font-bold uppercase tracking-wider text-[10px] text-zinc-400 flex items-center gap-1">
              <Github className="w-3.5 h-3.5 text-[#D98A6C]" /> Target private Repository
            </h3>
            
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">Repository Name (owner/repo)</label>
                <input
                  type="text"
                  value={repoInput}
                  onChange={(e) => setRepoInput(e.target.value)}
                  placeholder="johndoe/manga-backup"
                  className="w-full bg-[#161618] border border-[#27272A] rounded px-3 py-1.5 text-xs text-[#EAD9C6] focus:outline-none focus:border-[#D98A6C]"
                />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">File Target (e.g. db.json)</label>
                <input
                  type="text"
                  value={filepathInput}
                  onChange={(e) => setFilepathInput(e.target.value)}
                  placeholder="db.json"
                  className="w-full bg-[#161618] border border-[#27272A] rounded px-3 py-1.5 text-xs text-[#EAD9C6] focus:outline-none focus:border-[#D98A6C]"
                />
              </div>
            </div>

            <div className="pt-2 flex flex-wrap gap-2">
              <button
                onClick={handleTestConnection}
                disabled={testing || creatingRepo}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#27272A] hover:bg-[#202022] rounded font-semibold border border-[#27272A] text-[#EAD9C6] hover:text-white transition-all disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testing ? "animate-spin" : ""}`} />
                Test Connection Diagnostics
              </button>

              <button
                onClick={handleCreateRepo}
                disabled={testing || creatingRepo}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#D98A6C]/20 hover:bg-[#D98A6C]/30 text-[#D98A6C] rounded font-semibold border border-[#D98A6C]/40 hover:border-[#D98A6C]/60 transition-all disabled:opacity-50 cursor-pointer"
              >
                <Github className={`w-3.5 h-3.5 ${creatingRepo ? "animate-pulse" : ""}`} />
                Create Private Repository
              </button>
            </div>

            {testResult && (
              <div
                className={`p-3 rounded-lg border text-[11px] leading-relaxed flex gap-2 ${
                  testResult.success
                    ? "bg-green-950/20 border-green-500/30 text-green-300"
                    : "bg-red-950/20 border-red-500/30 text-red-300"
                }`}
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p>{testResult.message}</p>
              </div>
            )}
          </div>

          {/* Threshold sliders */}
          <div className="space-y-4 bg-[#121212] p-4 rounded-xl border border-[#27272A]">
            <h3 className="font-bold uppercase tracking-wider text-[10px] text-zinc-400 flex items-center gap-1">
              <Sliders className="w-3.5 h-3.5 text-[#D98A6C]" /> Threshold Sliders
            </h3>

            {/* Stall threshold days */}
            <div className="space-y-1">
              <div className="flex justify-between font-medium">
                <span className="text-zinc-400">Stall Threshold:</span>
                <span className="text-[#D98A6C] font-semibold">{stallThresholdDays} days</span>
              </div>
              <input
                type="range"
                min={3}
                max={60}
                value={stallThresholdDays}
                onChange={(e) => setStallThresholdDays(parseInt(e.target.value, 10))}
                className="w-full accent-[#D98A6C] cursor-pointer"
              />
              <p className="text-[9px] text-zinc-500">Manga with lastRead older than this are flagged as stalled.</p>
            </div>

            {/* Binge threshold hours */}
            <div className="space-y-1 pt-2">
              <div className="flex justify-between font-medium">
                <span className="text-zinc-400">Binge Session window:</span>
                <span className="text-[#D98A6C] font-semibold">{bingeThresholdHours} hours</span>
              </div>
              <input
                type="range"
                min={12}
                max={96}
                value={bingeThresholdHours}
                onChange={(e) => setBingeThresholdHours(parseInt(e.target.value, 10))}
                className="w-full accent-[#D98A6C] cursor-pointer"
              />
              <p className="text-[9px] text-zinc-500">Hourly timeframe used to identify contiguous reading streaks.</p>
            </div>

            {/* Difficulty benchmarks */}
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div className="space-y-1">
                <span className="block text-[10px] text-zinc-500 uppercase font-semibold">Easy Difficulty ceiling</span>
                <input
                  type="number"
                  value={easyThreshold}
                  onChange={(e) => setEasyThreshold(parseInt(e.target.value, 10) || 50)}
                  className="w-full bg-[#161618] border border-[#27272A] rounded px-2.5 py-1 text-[#EAD9C6] focus:outline-none focus:border-[#D98A6C]"
                />
              </div>
              <div className="space-y-1">
                <span className="block text-[10px] text-zinc-500 uppercase font-semibold">Medium Difficulty ceiling</span>
                <input
                  type="number"
                  value={mediumThreshold}
                  onChange={(e) => setMediumThreshold(parseInt(e.target.value, 10) || 200)}
                  className="w-full bg-[#161618] border border-[#27272A] rounded px-2.5 py-1 text-[#EAD9C6] focus:outline-none focus:border-[#D98A6C]"
                />
              </div>
            </div>
          </div>

          {/* Local storage import/export */}
          <div className="space-y-3 bg-[#121212] p-4 rounded-xl border border-[#27272A]">
            <h3 className="font-bold uppercase tracking-wider text-[10px] text-zinc-400 flex items-center gap-1">
              <FileJson className="w-3.5 h-3.5 text-[#D98A6C]" /> Raw JSON Backup Panel
            </h3>
            <p className="text-[10px] text-zinc-500">Test or import/export raw db.json payloads locally without GitHub APIs active.</p>
            
            <div className="flex gap-2.5 pt-1.5">
              <label className="flex items-center justify-center gap-1.5 px-3 py-2 bg-[#27272A] hover:bg-zinc-800 border border-[#27272A] text-zinc-300 hover:text-white rounded font-semibold text-center cursor-pointer flex-1 transition-colors">
                <FileJson className="w-3.5 h-3.5" /> Import JSON Backup
                <input
                  type="file"
                  accept=".json"
                  onChange={handleJSONImport}
                  className="hidden"
                />
              </label>
              <button
                onClick={handleJSONExport}
                className="flex items-center justify-center gap-1.5 px-3 py-2 bg-[#27272A] hover:bg-zinc-800 border border-[#27272A] text-zinc-300 hover:text-white rounded font-semibold flex-1 transition-colors cursor-pointer"
              >
                <FileJson className="w-3.5 h-3.5" /> Export DB JSON
              </button>
            </div>
          </div>

          {/* Toggleable error console log drawer */}
          <div className="space-y-2">
            <button
              onClick={() => {
                setShowLogs(!showLogs);
                if (!showLogs) loadLogs();
              }}
              className="text-[#D98A6C] font-semibold text-[11px] underline flex items-center gap-1 hover:text-[#e4a085] cursor-pointer"
            >
              <Sliders className="w-3 h-3" /> {showLogs ? "Hide" : "Show"} System Error & Diagnostic Log Console
            </button>

            {showLogs && (
              <div className="bg-[#121212] border border-[#27272A] rounded-xl p-3 space-y-3 max-h-48 overflow-y-auto font-mono text-[10px]">
                <div className="flex justify-between items-center pb-1.5 border-b border-[#27272A]">
                  <span className="font-bold text-zinc-400">DIAGNOSTIC LOG RECORDS</span>
                  <button
                    onClick={handleClearLogs}
                    className="flex items-center gap-1 text-red-400 hover:text-red-300 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" /> Clear logs
                  </button>
                </div>
                {logs.length === 0 ? (
                  <p className="text-zinc-600 italic text-center py-4">No diagnostic logs generated yet.</p>
                ) : (
                  <div className="space-y-2 divide-y divide-[#27272A]/30">
                    {logs.map((l, i) => (
                      <div key={i} className="pt-2">
                        <span className="text-zinc-500">[{new Date(l.timestamp * 1000).toLocaleTimeString()}]</span>{" "}
                        <span className="font-semibold uppercase text-zinc-400">({l.type})</span>:{" "}
                        <span className="text-zinc-300">{l.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

        </div>

        {/* Footer actions */}
        <div className="p-4 border-t border-[#27272A] bg-[#121212] flex justify-end gap-2 rounded-b-2xl">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-[#27272A] hover:bg-zinc-800 rounded text-zinc-300 hover:text-white font-semibold transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSaveConfig}
            className="px-4 py-2 bg-[#D98A6C] hover:bg-[#e4a085] text-[#121212] rounded font-bold transition-colors cursor-pointer"
          >
            Apply Configurations
          </button>
        </div>

      </div>
    </div>
  );
}
