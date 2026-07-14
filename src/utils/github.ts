import { DBDataset, ErrorLog, SyncStatus } from "../types";
import { addErrorLog } from "./db";

// Exponential backoff helper
export async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FetchOptions extends RequestInit {
  abortSignal?: AbortSignal;
}

/**
 * A custom fetch wrapper that handles GitHub Personal Access Tokens,
 * exponential backoff for rate limits, and custom AbortControllers.
 */
export async function githubFetch(
  url: string,
  pat: string,
  options: FetchOptions = {},
  retries = 3,
  backoffMs = 1000
): Promise<Response> {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `token ${pat}`);
  headers.set("Accept", "application/vnd.github.v3+json");

  const controller = new AbortController();
  const signal = options.abortSignal || controller.signal;

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal,
    });

    // Check for rate limits (403 Forbidden with rate limit headers or 429 Too Many Requests)
    const isRateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
         response.headers.get("retry-after") !== null));

    if (isRateLimited && retries > 0) {
      const retryAfter = response.headers.get("retry-after");
      const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoffMs;
      await addErrorLog(`GitHub Rate limit hit. Backing off for ${waitTime}ms. Retries left: ${retries}`, "github");
      await delay(waitTime);
      return githubFetch(url, pat, options, retries - 1, backoffMs * 2);
    }

    return response;
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw err;
    }
    if (retries > 0) {
      await delay(backoffMs);
      return githubFetch(url, pat, options, retries - 1, backoffMs * 2);
    }
    throw err;
  }
}

export interface GitHubRepoConfig {
  repo: string; // "owner/repo"
  filepath: string; // e.g. "db.json"
}

/**
 * Validates the GitHub PAT and ensures the target repository exists.
 */
export async function testGitHubConnection(
  pat: string,
  repo: string,
  filepath: string,
  signal?: AbortSignal
): Promise<{ success: boolean; message: string; fileExists: boolean }> {
  if (!pat) {
    return { success: false, message: "PAT token is empty", fileExists: false };
  }
  if (!repo || !repo.includes("/")) {
    return { success: false, message: "Repository must be in format owner/name", fileExists: false };
  }

  try {
    // 1. Test repository existence
    const repoUrl = `https://api.github.com/repos/${repo}`;
    const repoRes = await githubFetch(repoUrl, pat, { abortSignal: signal });

    if (repoRes.status === 401) {
      await addErrorLog("GitHub authentication failed: Invalid Personal Access Token (401)", "auth");
      return { success: false, message: "Invalid PAT (401)", fileExists: false };
    }
    if (repoRes.status === 403) {
      await addErrorLog("GitHub API Access Forbidden (403). Check PAT permissions/scopes.", "auth");
      return { success: false, message: "Forbidden (403). Check PAT scopes.", fileExists: false };
    }
    if (repoRes.status === 404) {
      await addErrorLog(`GitHub Repository '${repo}' not found (404)`, "github");
      return { success: false, message: "Repository not found (404)", fileExists: false };
    }
    if (!repoRes.ok) {
      return { success: false, message: `GitHub API error (${repoRes.status})`, fileExists: false };
    }

    // 2. Test file existence in repository
    const fileUrl = `https://api.github.com/repos/${repo}/contents/${filepath}`;
    const fileRes = await githubFetch(fileUrl, pat, { abortSignal: signal });

    if (fileRes.status === 404) {
      return { success: true, message: "Connected! Repository is reachable but file does not exist yet (it will be created on first sync).", fileExists: false };
    }
    if (fileRes.ok) {
      return { success: true, message: "Connected! Repository is reachable and file exists.", fileExists: true };
    }

    return { success: true, message: `Connected, but file check returned code: ${fileRes.status}`, fileExists: false };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { success: false, message: "Connection test canceled.", fileExists: false };
    }
    const errMsg = err.message || "Network error. Please check your connection.";
    await addErrorLog(`GitHub Connection Test Failed: ${errMsg}`, "github");
    return { success: false, message: errMsg, fileExists: false };
  }
}

/**
 * Fetches the raw contents of db.json from GitHub, returning the dataset and its SHA.
 */
export async function fetchFromGitHub(
  pat: string,
  repo: string,
  filepath: string,
  signal?: AbortSignal
): Promise<{ data: DBDataset; sha: string } | null> {
  const url = `https://api.github.com/repos/${repo}/contents/${filepath}`;
  try {
    const res = await githubFetch(url, pat, { abortSignal: signal });

    if (res.status === 404) {
      return null; // File does not exist yet
    }

    if (!res.ok) {
      throw new Error(`Failed to fetch from GitHub: ${res.statusText} (${res.status})`);
    }

    const payload = await res.json();
    const sha = payload.sha;
    // Base64 decode file content. Handles multi-line base64 payloads safely by stripping newlines.
    const decodedContent = decodeURIComponent(
      atob(payload.content.replace(/\s/g, ""))
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );

    const data = JSON.parse(decodedContent) as DBDataset;
    return { data, sha };
  } catch (err: any) {
    if (err.name === "AbortError") throw err;
    const msg = err.message || "Unknown error";
    await addErrorLog(`GitHub fetch failure: ${msg}`, "github");
    throw err;
  }
}

/**
 * Pushes updated db.json contents to GitHub, returning the new SHA.
 */
export async function pushToGitHub(
  pat: string,
  repo: string,
  filepath: string,
  content: DBDataset,
  sha: string | null,
  commitMessage: string,
  signal?: AbortSignal
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${filepath}`;
  
  // Clean up content before stringifying
  const jsonString = JSON.stringify(content, null, 2);
  const base64Content = btoa(
    encodeURIComponent(jsonString).replace(/%([0-9A-F]{2})/g, (_, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  );

  const body: any = {
    message: commitMessage,
    content: base64Content,
  };

  if (sha) {
    body.sha = sha;
  }

  try {
    const res = await githubFetch(
      url,
      pat,
      {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        abortSignal: signal,
      }
    );

    if (!res.ok) {
      const errorJson = await res.json().catch(() => ({}));
      const errorDetails = errorJson.message || res.statusText;
      throw new Error(`GitHub push failure: ${errorDetails} (${res.status})`);
    }

    const payload = await res.json();
    return payload.content.sha;
  } catch (err: any) {
    if (err.name === "AbortError") throw err;
    const msg = err.message || "Unknown error";
    await addErrorLog(`GitHub push failure: ${msg}`, "github");
    throw err;
  }
}

/**
 * Simple diff function to determine if there are changes between two datasets.
 */
export function hasDatasetChanged(local: DBDataset, remote: DBDataset): boolean {
  // If lengths differ, we definitely changed something
  if (local.manga.length !== remote.manga.length || local.library.length !== remote.library.length) {
    return true;
  }

  // Check manga records
  for (let i = 0; i < local.manga.length; i++) {
    const lm = local.manga[i];
    const rm = remote.manga.find((m) => m.id === lm.id);
    if (!rm) return true;
    if (
      lm.status !== rm.status ||
      lm.rating !== rm.rating ||
      lm.notes !== rm.notes ||
      lm.totalChapters !== rm.totalChapters ||
      lm.lastRead !== rm.lastRead ||
      lm.isBinge !== rm.isBinge ||
      lm.isStalled !== rm.isStalled
    ) {
      return true;
    }
  }

  // Check library records
  for (let i = 0; i < local.library.length; i++) {
    const ll = local.library[i];
    const rl = remote.library.find((l) => l.mangaId === ll.mangaId);
    if (!rl) return true;
    if (ll.chaptersRead !== rl.chaptersRead || ll.lastRead !== rl.lastRead) {
      return true;
    }
  }

  return false;
}

/**
 * Creates a new private GitHub repository for the user.
 */
export async function createGitHubRepository(
  pat: string,
  repoFullPath: string,
  isPrivate = true,
  signal?: AbortSignal
): Promise<{ success: boolean; message: string; repoPath?: string }> {
  if (!pat) {
    return { success: false, message: "PAT token is empty" };
  }
  
  let repoName = repoFullPath.trim();
  if (repoName.includes("/")) {
    const parts = repoName.split("/");
    repoName = parts[parts.length - 1].trim();
  }

  if (!repoName) {
    repoName = "mangapulse-backup";
  }

  try {
    const url = "https://api.github.com/user/repos";
    const res = await githubFetch(
      url,
      pat,
      {
        method: "POST",
        body: JSON.stringify({
          name: repoName,
          private: isPrivate,
          description: "MangaPulse automated cloud backup storage repo",
          auto_init: true,
        }),
        headers: { "Content-Type": "application/json" },
        abortSignal: signal,
      }
    );

    if (res.status === 401) {
      await addErrorLog("GitHub repository creation failed: Invalid Personal Access Token (401)", "auth");
      return { success: false, message: "Invalid PAT (401)" };
    }

    if (res.status === 422) {
      const errorJson = await res.json().catch(() => ({}));
      const msg = errorJson.message || "Repository already exists or name invalid.";
      await addErrorLog(`GitHub Repository creation error: ${msg} (422)`, "github");
      return { success: false, message: `Repository creation failed: ${msg}` };
    }

    if (!res.ok) {
      const errorJson = await res.json().catch(() => ({}));
      const errorDetails = errorJson.message || res.statusText;
      await addErrorLog(`GitHub Repository creation error: ${errorDetails} (${res.status})`, "github");
      return { success: false, message: `Failed to create repository: ${errorDetails} (${res.status})` };
    }

    const payload = await res.json();
    const createdRepoPath = payload.full_name; // e.g. "johndoe/mangapulse-backup"
    
    await addErrorLog(`GitHub Repository '${createdRepoPath}' created successfully!`, "github");
    return {
      success: true,
      message: `Successfully created private repository '${createdRepoPath}'! Initialized with a default commit.`,
      repoPath: createdRepoPath,
    };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { success: false, message: "Repository creation canceled." };
    }
    const errMsg = err.message || "Network error. Please check your connection.";
    await addErrorLog(`GitHub Repository creation failed: ${errMsg}`, "github");
    return { success: false, message: errMsg };
  }
}

