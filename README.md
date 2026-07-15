# MangaPulse

MangaPulse is a high-performance, local-first, zero-backend client-side manga tracking engine designed to ingest native Paperback backup files (`.pas4`), persist them locally using IndexedDB, and synchronize state securely to private GitHub repositories using the GitHub REST API.

---

## 🚀 Key Features & Sprint Engineering

- **Native Paperback Ingestion (`.pas4`)**: Unzips, decompresses, and parses native Paperback backup archives directly in the browser using `fflate` with zero server-side processing.
- **Relational Ingestion Inspector**: An interactive, hierarchical collapsible tree viewer matching the Obsidian slate theme to inspect raw database elements (`librarymanga`, `sourcemanga`, `mangainfo`) in real-time.
- **True 48-Hour Binge Engine**: Real-time reading speed calculator analyzing chronological history markers to identify rapid binging streaks where users complete >3 chapters within a rolling 48-hour window.
- **Stalled Title Decay Engine**: Automated detection flagging titles unread for over 14 days with structured decay scoring that maps into "Binge" and "Stalled" visual buckets.
- **Client-Side Widget Data Provider**: Generates standard JSON payloads (matching `/api/widget.json` specifications) containing streaks, heatmaps, and stats to power external iOS/Android home screen widgets.
- **Heuristic Recommendation Engine**: Suggests top-rated, active, or completed alternatives from the user's library when a series is stalled or dropped, matching genre and creator tags.
- **Zero-Backend GitHub Sync**: Implements secure local-first syncing to a private GitHub repository with encrypted Personal Access Token (PAT) caching and smart, granular commit message compilation.

---

## 📂 Architecture & Data Flow

```
+--------------------+
|  Paperback Backup  |  (.pas4 file)
+---------+----------+
          |
          v [fflate decompression]
+-----------------------------------------------------------+
|  Raw Relational Blocks:                                   |
|  - librarymanga   - sourcemanga   - mangainfo             |
+---------+-------------------------------------------------+
          |
          v [Fuzzy Merging / Ingestion Pipeline]
+-----------------------------------------------------------+
|  Unified Dataset Schema (DBDataset)                       |
+---------+-------------------------------------------------+
          |
          +---------> Persist to IndexedDB (MangaPulseDB)
          |
          +---------> Sync to GitHub Repository (db.json)
```

---

## 📊 Relational Database Schema

### `MangaEntry`
Represents the individual manga series within the database.
```typescript
interface MangaEntry {
  id: string;               // Unique series ID
  title: string;            // Name of the manga
  author: string;           // Manga creator/author
  coverUrl?: string;        // Cover art image URL
  sourceId: string;         // Paperback source catalog identifier
  totalChapters: number;    // Total chapter count (0 if ongoing/unknown)
  addedDate: number;        // Unix epoch timestamp (seconds) when added
  lastRead: number;         // Unix epoch timestamp (seconds) of last progress
  status: MangaStatus;      // "reading" | "completed" | "on_hold" | "dropped" | "planning"
  rating: number;           // User rating (1-5 stars, 0 if unrated)
  notes?: string;           // Markdown-compatible personal review notes
  isBinge?: boolean;        // Automatically computed binge flag (active rolling speed)
  isStalled?: boolean;      // Automatically computed stalling flag (unread for 14+ days)
}
```

### `LibraryEntry`
Tracks the user's reading history, chapters completed, and timestamp marks.
```typescript
interface LibraryEntry {
  mangaId: string;                      // Reference to the MangaEntry id
  chaptersRead: number;                 // Total chapters completed
  lastRead: number;                     // Unix epoch timestamp (seconds) of last increment
  history: ReadingHistoryItem[];        // Chronological log of individual chapter accomplishments
}

interface ReadingHistoryItem {
  chapter: number;                      // Chapter number read
  timestamp: number;                    // Unix epoch timestamp (seconds) when completed
}
```

### `DBDataset`
The root state payload represented as a single cohesive relational block.
```typescript
interface DBDataset {
  manga: MangaEntry[];
  library: LibraryEntry[];
  settings: AppSettings;
  stats?: {
    totalChaptersRead: number;
    velocity?: {
      daily: number;
      weekly: number;
      monthly: number;
      lifetime: number;
    };
  };
  metadata?: {
    lastSync: number;
    version: string;
    history: SizeHistoryItem[];         // Byte-precise ingestion size logs
  };
}
```

---

## 🛠️ Security & Cryptographic Handlers

To achieve zero-backend synchronization without exposing secrets:
1. **Local Encryption**: Personal Access Tokens (PATs) are salted, encrypted client-side using **PBKDF2** for key derivation and **AES-GCM (256-bit)** via standard Web Crypto APIs, and stored in `localStorage`.
2. **Decryption on Demand**: The decrypted token is stored in volatile memory and never saved in raw text on the disk.
3. **Private Synchronization**: All REST transactions are done directly between the client browser and GitHub APIs.

---

## 💻 Tech Stack & Dependencies

- **Framework**: React 18, Vite, TypeScript
- **Styling**: Tailwind CSS v4
- **Decompression**: `fflate` (unzipping `.pas4` archives)
- **Charts & Heatmaps**: Custom SVG layouts & `lucide-react` icons
- **Persistence**: IndexedDB (`MangaPulseDB`)

---

## ⚙️ Build and Development

### Setup & Install
```bash
npm install
```

### Dev Environment
```bash
npm run dev
```

### Build Production Assets
```bash
npm run build
```
The compiled SPA builds directly into `/dist`, fully compatible with static hosts like **GitHub Pages**, **Vercel**, or **Netlify**.
