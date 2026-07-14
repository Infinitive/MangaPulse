import { DBDataset, ErrorLog } from "../types";

const DB_NAME = "MangaPulseDB";
const STORE_NAME = "kv";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export async function getLocalItem<T>(key: string): Promise<T | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result as T || null);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error("IndexedDB getLocalItem error", err);
    return null;
  }
}

export async function setLocalItem<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(value, key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error("IndexedDB setLocalItem error", err);
  }
}

export function getDefaultDataset(): DBDataset {
  return {
    metadata: {
      lastSync: Math.floor(Date.now() / 1000),
      version: "1.0",
      history: [],
    },
    manga: [],
    library: [],
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
      totalTracked: 0,
      totalChaptersRead: 0,
      sourceDistribution: {},
      readingHeatmap: {},
      velocity: {
        "7d": 0,
        "30d": 0,
        "lifetime": 0,
      },
    },
  };
}

export async function getDbDataset(): Promise<DBDataset> {
  const cached = await getLocalItem<DBDataset>("db_json");
  if (cached) {
    // Fill in defaults if properties are missing
    if (!cached.metadata) cached.metadata = { lastSync: 0, version: "1.0", history: [] };
    if (!cached.metadata.history) cached.metadata.history = [];
    if (!cached.manga) cached.manga = [];
    if (!cached.library) cached.library = [];
    if (!cached.settings) {
      cached.settings = {
        stallThresholdDays: 14,
        bingeThresholdHours: 48,
        difficultyThresholds: { easy: 50, medium: 200, hard: 500 },
      };
    }
    if (!cached.stats) {
      cached.stats = {
        totalTracked: 0,
        totalChaptersRead: 0,
        sourceDistribution: {},
        readingHeatmap: {},
        velocity: { "7d": 0, "30d": 0, "lifetime": 0 },
      };
    }
    return cached;
  }
  const defaultSet = getDefaultDataset();
  await setLocalItem("db_json", defaultSet);
  return defaultSet;
}

export async function saveDbDataset(data: DBDataset): Promise<void> {
  await setLocalItem("db_json", data);
}

export async function getErrorLogs(): Promise<ErrorLog[]> {
  const logs = await getLocalItem<ErrorLog[]>("error_logs");
  return logs || [];
}

export async function addErrorLog(message: string, type: ErrorLog["type"]): Promise<void> {
  const logs = await getErrorLogs();
  const newLog: ErrorLog = {
    timestamp: Math.floor(Date.now() / 1000),
    message,
    type,
  };
  logs.push(newLog);
  // Keep last 100 logs
  if (logs.length > 100) {
    logs.shift();
  }
  await setLocalItem("error_logs", logs);
}

export async function clearErrorLogs(): Promise<void> {
  await setLocalItem("error_logs", []);
}
