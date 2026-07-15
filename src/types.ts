export type MangaStatus = "reading" | "planned" | "dropped" | "completed" | "archived";

export interface MangaEntry {
  id: string;
  title: string;
  author: string;
  sourceId: string;
  coverUrl: string;
  genres: string[];
  status: MangaStatus;
  totalChapters: number;
  lastRead: number; // Unix timestamp
  rating: number; // 0 to 5 stars
  notes: string; // Markdown text
  tags: string[];
  isBinge: boolean;
  isStalled: boolean;
  addedDate: number; // Unix timestamp
  // Phase 3 / Phase 4 additional metadata fields
  plot?: string;
  serialization?: string;
  hiatusOverride?: boolean; // Hiatus list override
  nextReleasePrediction?: string; // Release prediction
  confidenceLevel?: string; // Prediction confidence
  sourceExtensionWarning?: boolean; // Ghost progress alternate source detection
}

export interface ReadingHistoryItem {
  chapter: number;
  timestamp: number; // Unix timestamp
}

export interface LibraryEntry {
  mangaId: string;
  chaptersRead: number;
  lastRead: number; // Unix timestamp
  history: ReadingHistoryItem[];
}

export interface DifficultyThresholds {
  easy: number;
  medium: number;
  hard: number;
}

export interface AppSettings {
  stallThresholdDays: number;
  bingeThresholdHours: number;
  difficultyThresholds: DifficultyThresholds;
}

export interface SizeHistoryItem {
  timestamp: number;
  sizeKB: number;
  sizeInBytes?: number;
}

export interface SyncMetadata {
  lastSync: number; // Unix timestamp
  version: string;
  history?: SizeHistoryItem[]; // Saved payload sizes over time
}

export interface AppStats {
  totalTracked: number;
  totalChaptersRead: number;
  sourceDistribution: Record<string, number>;
  readingHeatmap: Record<string, number>; // YYYY-MM-DD -> chapters read count
  velocity: {
    "7d": number;
    "30d": number;
    "lifetime": number;
  };
}

export interface DBDataset {
  metadata: SyncMetadata;
  manga: MangaEntry[];
  library: LibraryEntry[];
  settings: AppSettings;
  stats: AppStats;
}

export interface ErrorLog {
  timestamp: number; // Unix timestamp
  message: string;
  type: "extraction" | "github" | "validation" | "sync" | "auth";
}

export interface SyncStatus {
  status: "synced" | "pending" | "error";
  lastSyncTime: number | null;
  pendingChangesCount: number;
  errorMessage?: string;
}
