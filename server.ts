import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

dotenv.config();

// Lazy-initialized Gemini Client helper
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not defined. Please add it via the Secrets panel.");
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Configure JSON parser with higher limits to support full dataset transfers
  app.use(express.json({ limit: "20mb" }));

  // API endpoint for health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", service: "MangaPulse Server" });
  });

  // API endpoint for smart AI analysis with Thinking Mode (ThinkingLevel.HIGH)
  app.post("/api/chat", async (req, res) => {
    try {
      const { prompt, dataset } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      let ai;
      try {
        ai = getGeminiClient();
      } catch (e: any) {
        return res.status(500).json({
          error: "Gemini API client failed to initialize.",
          details: e.message || "Please make sure GEMINI_API_KEY is configured in Settings > Secrets."
        });
      }

      // Compact/extract relevant info from dataset for better context window efficiency
      const mangaCompact = dataset?.manga?.map((m: any) => ({
        title: m.title,
        status: m.status,
        author: m.author,
        genres: m.genres,
        rating: m.rating,
        notes: m.notes ? m.notes.slice(0, 200) + (m.notes.length > 200 ? "..." : "") : "",
        lastRead: m.lastRead,
        isBinge: m.isBinge,
        isStalled: m.isStalled,
        totalChapters: m.totalChapters,
      })) || [];

      const stats = dataset?.stats || {};
      const velocity = stats.velocity || {};

      const systemInstruction = `You are the MangaPulse AI Oracle, a sophisticated anime/manga analytics companion.
Your job is to analyze the user's reading dataset and answer their questions with professional literary intelligence, detailed graphs (drawn using ASCII or text blocks if necessary), and creative feedback.

Here is the current MangaPulse library state for the user:
- Total Tracked Titles: ${stats.totalTracked || mangaCompact.length}
- Cumulative Read Chapters: ${stats.totalChaptersRead || 0}
- Current velocities: 7-day average is ${velocity["7d"] || 0} chapters/day, 30-day average is ${velocity["30d"] || 0}, and lifetime average is ${velocity["lifetime"] || 0} chapters/day.
- Source distribution: ${JSON.stringify(stats.sourceDistribution || {})}

Titles list (compacted):
${JSON.stringify(mangaCompact, null, 2)}

When answering:
1. Provide in-depth literary analysis, progress suggestions, binge metrics, or reading habits suggestions.
2. Structure your answer beautifully with clear headers.
3. If recommended, suggest next chapters, transition items, or identifying stalled series to move to "dropped" or "completed".
4. Speak clearly and maintain the theme of MangaPulse. Keep technical jargon light.`;

      // Generate content with High Thinking Enabled!
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
      });

      const responseText = response.text || "No response received from model.";
      res.json({ reply: responseText });
    } catch (error: any) {
      console.error("Gemini API server route error:", error);
      res.status(500).json({
        error: "AI analysis failed. Please verify your GEMINI_API_KEY.",
        details: error.message || error,
      });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite development middleware mounted.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("Serving static assets in production mode.");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MangaPulse Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start MangaPulse Server:", err);
});
