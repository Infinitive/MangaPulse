// Service Worker to intercept Widget API requests and serve them from IndexedDB
const CACHE_NAME = "mangapulse-sw-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Intercepts /api/widget.json and constructs a JSON response using IndexedDB state.
 */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.endsWith("/api/widget.json")) {
    event.respondWith(
      new Promise((resolve) => {
        const dbRequest = indexedDB.open("MangaPulseDB", 1);

        dbRequest.onerror = () => {
          resolve(
            new Response(
              JSON.stringify({ error: "Failed to open IndexedDB" }),
              {
                status: 500,
                headers: { "Content-Type": "application/json" },
              }
            )
          );
        };

        dbRequest.onsuccess = () => {
          const db = dbRequest.result;
          if (!db.objectStoreNames.contains("kv")) {
            resolve(
              new Response(
                JSON.stringify({
                  activeCount: 0,
                  recentlyRead: [],
                  bingeCount: 0,
                  stalledCount: 0,
                  notice: "IndexedDB store 'kv' not initialized yet.",
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }
              )
            );
            return;
          }

          const transaction = db.transaction("kv", "readonly");
          const store = transaction.objectStore("kv");
          const getRequest = store.get("db_json");

          getRequest.onerror = () => {
            resolve(
              new Response(
                JSON.stringify({ error: "Failed to fetch db_json from IndexedDB" }),
                {
                  status: 500,
                  headers: { "Content-Type": "application/json" },
                }
              )
            );
          };

          getRequest.onsuccess = () => {
            const dbData = getRequest.result;
            if (!dbData) {
              resolve(
                new Response(
                  JSON.stringify({
                    activeCount: 0,
                    recentlyRead: [],
                    bingeCount: 0,
                    stalledCount: 0,
                    notice: "No database local cache found. Please import some data first.",
                  }),
                  {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  }
                )
              );
              return;
            }

            // Perform dynamic aggregation
            const mangaList = dbData.manga || [];
            const libraryList = dbData.library || [];

            const activeManga = mangaList.filter((m) => m.status === "reading");
            const activeCount = activeManga.length;

            const bingeCount = mangaList.filter((m) => m.status === "reading" && m.isBinge).length;
            const stalledCount = mangaList.filter((m) => m.status === "reading" && m.isStalled).length;

            // Compile recently read: sorted by lastRead descending, max 5
            const recentlyRead = activeManga
              .sort((a, b) => b.lastRead - a.lastRead)
              .slice(0, 5)
              .map((m) => {
                const lib = libraryList.find((l) => l.mangaId === m.id);
                return {
                  title: m.title,
                  chapters: lib ? lib.chaptersRead : 0,
                  lastRead: m.lastRead,
                };
              });

            const widgetResponse = {
              activeCount,
              recentlyRead,
              bingeCount,
              stalledCount,
            };

            resolve(
              new Response(JSON.stringify(widgetResponse), {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              })
            );
          };
        };

        // If table doesn't exist yet, we handle onupgradeneeded gracefully
        dbRequest.onupgradeneeded = (event) => {
          const db = dbRequest.result;
          if (!db.objectStoreNames.contains("kv")) {
            db.createObjectStore("kv");
          }
        };
      })
    );
  }
});
