/**
 * In-memory LRU Cache for Cover Images.
 * Keeps up to 50 base64-encoded or raw URL resources in memory.
 */
class ImageLRUCache {
  private cache: Map<string, string>;
  private maxEntries: number;

  constructor(maxEntries = 50) {
    this.cache = new Map<string, string>();
    this.maxEntries = maxEntries;
  }

  public get(url: string): string | null {
    if (!this.cache.has(url)) {
      return null;
    }
    // Refresh position
    const val = this.cache.get(url)!;
    this.cache.delete(url);
    this.cache.set(url, val);
    return val;
  }

  public put(url: string, base64OrUrl: string): void {
    if (this.cache.has(url)) {
      this.cache.delete(url);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry (first item in map iterator)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(url, base64OrUrl);
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}

export const coverImageCache = new ImageLRUCache(50);
