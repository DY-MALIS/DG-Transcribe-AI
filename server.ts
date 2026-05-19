import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import PDFDocument from "pdfkit";
import { GoogleGenAI, Type, createPartFromUri, FileState } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const multer = require("multer");
const uploadDir = path.join(os.tmpdir(), "dg-transcribe-uploads");

fs.mkdirSync(uploadDir, { recursive: true });

const mediaUpload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 4 * 1024 * 1024 * 1024,
  },
});

function getGeminiApiKeys() {
  const apiKeys = [
    ...(process.env.GEMINI_API_KEYS || "").split(","),
    process.env.GEMINI_API_KEY || "",
  ]
    .map(key => key.trim())
    .filter(key => key && key !== "MY_GEMINI_API_KEY");

  return [...new Set(apiKeys)];
}

const geminiClients = getGeminiApiKeys().map(apiKey => new GoogleGenAI({ apiKey }));
let geminiClientIndex = 0;

function getGeminiClient(apiKey?: string) {
  if (apiKey?.trim()) {
    return new GoogleGenAI({ apiKey: apiKey.trim() });
  }

  if (geminiClients.length === 0) {
    throw new Error("Missing GEMINI_API_KEY. Add a valid key to .env and restart the server.");
  }

  const client = geminiClients[geminiClientIndex % geminiClients.length];
  geminiClientIndex++;
  return client;
}

const TRANSCRIPTION_MODELS = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.0-flash"];
const TEXT_MODELS = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.0-flash"];
const IMAGE_MODELS = ["gemini-3-pro-image-preview"];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableGeminiError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return message.includes("503") ||
    message.includes("unavailable") ||
    message.includes("overloaded") ||
    message.includes("rate limit") ||
    message.includes("temporarily") ||
    message.includes("deadline");
}

function canTryNextGeminiModel(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return isRetryableGeminiError(error) ||
    message.includes("not found") ||
    message.includes("not supported") ||
    message.includes("unsupported") ||
    message.includes("invalid argument") ||
    message.includes("model");
}

async function withGeminiRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableGeminiError(error) || attempt === attempts) {
        throw error;
      }

      await sleep(1500 * attempt);
    }
  }

  throw lastError;
}

function getRequestGeminiKey(req: express.Request) {
  const header = req.header("x-gemini-api-key");
  return header?.trim();
}

async function generateWithModelFallback(client: GoogleGenAI, requestFactory: (model: string) => Parameters<GoogleGenAI["models"]["generateContent"]>[0]) {
  let lastError: unknown;

  for (const model of TEXT_MODELS) {
    try {
      return await withGeminiRetry(() => client.models.generateContent(requestFactory(model)), 3);
    } catch (error) {
      lastError = error;

      if (!canTryNextGeminiModel(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function transcribeWithModelFallback(client: GoogleGenAI, readyFileUri: string, readyFileMimeType: string) {
  let lastError: unknown;

  for (const model of TRANSCRIPTION_MODELS) {
    try {
      return await withGeminiRetry(() => client.models.generateContent({
        model,
        contents: [
          {
            parts: [
              createPartFromUri(readyFileUri, readyFileMimeType),
              {
                text: `FAST MODE TRANSCRIPTION:
                - Detect language.
                - Transcribe speech accurately.
                - Preserve the full meaning; do not shorten important details.
                - If a speaker's voice is clearly female, prefix that speaker's lines with "ស្រី:".
                - If a speaker's voice is clearly male, prefix that speaker's lines with "ប្រុស:".
                - If gender is unclear, use "អ្នកនិយាយ 1:", "អ្នកនិយាយ 2:", etc.
                - Keep summary, points, and takeaways concise but complete.

                Return JSON only: {text, language, summary, points, takeaways}.
                PRIORITY: FASTEST POSSIBLE RESPONSE.`,
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING, description: "Full transcription" },
              language: { type: Type.STRING },
              summary: { type: Type.STRING },
              points: { type: Type.ARRAY, items: { type: Type.STRING } },
              takeaways: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ["text", "language", "summary", "points", "takeaways"],
          },
        },
      }), 3);
    } catch (error) {
      lastError = error;

      if (!canTryNextGeminiModel(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function waitForGeminiFile(client: GoogleGenAI, fileName: string) {
  const maxAttempts = 300;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const file = await withGeminiRetry(() => client.files.get({ name: fileName }), 3);

    if (file.state === FileState.ACTIVE) {
      return file;
    }

    if (file.state === FileState.FAILED) {
      throw new Error(file.error?.message || "Gemini could not process this media file.");
    }

    await sleep(2000);
  }

  throw new Error("Gemini file preparation took too long. Please try a smaller or more compressed file.");
}

async function transcribeMedia(client: GoogleGenAI, filePath: string, originalName: string, mimeType: string) {
  const uploadedFile = await withGeminiRetry(() => client.files.upload({
    file: filePath,
    config: {
      mimeType,
      displayName: originalName,
    },
  }), 3);
  const readyFile = await waitForGeminiFile(client, uploadedFile.name || "");

  if (!readyFile.uri || !readyFile.mimeType) {
    throw new Error("Gemini did not return a usable file URI.");
  }

  const response = await transcribeWithModelFallback(client, readyFile.uri, readyFile.mimeType);

  if (!response.text) {
    throw new Error("No response text from Gemini");
  }

  return JSON.parse(response.text);
}

async function transcribeMediaUrl(client: GoogleGenAI, fileUrl: string, originalName: string, mimeType: string) {
  if (!fileUrl.startsWith("https://")) {
    throw new Error("Media URL must be an HTTPS URL.");
  }

  const response = await transcribeWithModelFallback(client, fileUrl, mimeType);

  if (!response.text) {
    throw new Error(`No transcription response from Gemini for ${originalName}`);
  }

  return JSON.parse(response.text);
}

async function summarizeText(client: GoogleGenAI, transcript: string, language: string = "original", customInstruction: string = "") {
  const response = await generateWithModelFallback(client, (model) => ({
    model,
    contents: `Summarize this transcript clearly.
    ${customInstruction ? `Instruction: ${customInstruction}` : "Include enough detail to be useful."}
    Language: ${language === "original" ? "same as transcript" : language}

    Transcript:
    ${transcript}

    Return JSON only: {summary, points, takeaways}.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          points: { type: Type.ARRAY, items: { type: Type.STRING } },
          takeaways: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["summary", "points", "takeaways"],
      },
    },
  }));

  if (!response.text) {
    throw new Error("No summary response from Gemini");
  }

  return JSON.parse(response.text);
}

async function translateTranscript(client: GoogleGenAI, text: string, targetLanguage: string) {
  const response = await generateWithModelFallback(client, (model) => ({
    model,
    contents: `Translate this transcript into ${targetLanguage} with full meaning and natural wording.
    Do not summarize or omit details.
    Preserve speaker turns.
    If the label says female, woman, ស្រី, or clearly indicates a female speaker, start that line with "ស្រី:".
    If the label says male, man, ប្រុស, or clearly indicates a male speaker, start that line with "ប្រុស:".
    If gender is unclear, use "អ្នកនិយាយ 1:", "អ្នកនិយាយ 2:", etc.

    Transcript:
    ${text}

    Return JSON only: {translatedText}.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          translatedText: { type: Type.STRING },
        },
        required: ["translatedText"],
      },
    },
  }));

  if (!response.text) {
    throw new Error("No translation response from Gemini");
  }

  return JSON.parse(response.text);
}

type AgentHistoryItem = {
  role?: string;
  content?: string;
};

async function askAgent(client: GoogleGenAI, message: string, history: AgentHistoryItem[] = []) {
  const recentHistory = history
    .slice(-10)
    .map(item => `${item.role === "assistant" ? "Assistant" : "User"}: ${item.content || ""}`)
    .join("\n");

  const response = await generateWithModelFallback(client, (model) => ({
    model,
    contents: `You are DG Transcribe AI Agent, a helpful assistant inside a transcription app.
Answer clearly in the user's language. If the user asks in Khmer, answer in Khmer.
Help with general questions, writing, summaries, transcription workflows, and app usage.

Recent conversation:
${recentHistory || "(none)"}

User:
${message}`,
  }));

  return { text: response.text || "I could not create a response. Please try again." };
}

async function createAgentImage(client: GoogleGenAI, prompt: string) {
  let lastError: unknown;

  for (const model of IMAGE_MODELS) {
    try {
      const interaction = await (client as any).interactions.create({
        model,
        input: prompt,
        response_modalities: ["image"],
      });

      const imageOutput = interaction.outputs?.find((output: any) => output.type === "image" && output.data);
      if (imageOutput?.data) {
        return {
          imageUrl: `data:${imageOutput.mime_type || "image/png"};base64,${imageOutput.data}`,
          text: "Image created.",
        };
      }

      throw new Error("Gemini did not return an image.");
    } catch (error) {
      lastError = error;
      if (!canTryNextGeminiModel(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

function getClientSafeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (message.includes("CONSUMER_SUSPENDED") || message.includes("has been suspended")) {
    return "Gemini API key is suspended. Please create a new Gemini API key, update .env, and restart the server.";
  }

  if (message.includes("API key not valid") || message.includes("API_KEY_INVALID")) {
    return "Gemini API key is invalid. Please update GEMINI_API_KEY in .env and restart the server.";
  }

  if (message.includes("Missing GEMINI_API_KEY")) {
    return message;
  }

  if (message.includes("quota") || message.includes("RESOURCE_EXHAUSTED")) {
    return "Gemini quota is exhausted. Add your own Gemini API key in Quick Config, or add more server keys in GEMINI_API_KEYS.";
  }

  if (lowerMessage.includes("unsupported") || lowerMessage.includes("mime") || lowerMessage.includes("invalid argument")) {
    return "This media format was not accepted by Gemini. Please convert it to MP3, WAV, M4A, or MP4 and upload again.";
  }

  if (lowerMessage.includes("too large") || lowerMessage.includes("payload") || lowerMessage.includes("file size")) {
    return "This file is too large for the current AI request. The app now uploads media through cloud storage first, but Gemini may still require a compressed or shorter file.";
  }

  if (lowerMessage.includes("413") || lowerMessage.includes("function_payload_too_large") || lowerMessage.includes("body size")) {
    return "The upload was too large for a Vercel Function. Please refresh and upload again so the app can use cloud-storage upload mode.";
  }

  if (lowerMessage.includes("deadline") || lowerMessage.includes("timeout") || lowerMessage.includes("timed out")) {
    return "Gemini took too long to process this file. Please try a shorter or compressed audio file.";
  }

  if (lowerMessage.includes("503") || lowerMessage.includes("unavailable")) {
    return "Gemini is temporarily unavailable. Please try again in a few minutes.";
  }

  if (lowerMessage.includes("image") || lowerMessage.includes("response_modalities") || lowerMessage.includes("modalities")) {
    return "Image generation is not available for this Gemini key/model yet. Please check Gemini image model access or try a text question.";
  }

  return "AI transcription failed. Please try a compressed file, or check the Gemini API key and quota.";
}

export function toClientSafeErrorMessage(error: unknown) {
  return getClientSafeErrorMessage(error);
}

export async function createApp(options: { includeVite?: boolean } = {}) {
  const app = express();
  const includeVite = options.includeVite ?? process.env.NODE_ENV !== "production";

  app.use(express.json({ limit: "25mb" }));

  // API Route: Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/transcribe", async (req, res) => {
    try {
      const { fileUrl, fileName, fileType } = req.body || {};
      if (fileUrl && fileName && fileType) {
        const result = await transcribeMediaUrl(
          getGeminiClient(getRequestGeminiKey(req)),
          String(fileUrl),
          String(fileName),
          String(fileType)
        );
        return res.json(result);
      }

      await new Promise<void>((resolve, reject) => {
        mediaUpload.single("media")(req, res, (error: unknown) => {
          if (error) reject(error);
          else resolve();
        });
      });

      const file = (req as express.Request & {
        file?: {
          path: string;
          originalname: string;
          mimetype: string;
        };
      }).file;

      if (!file) {
        return res.status(400).json({ error: "Media file URL or media upload is required." });
      }

      const result = await transcribeMedia(getGeminiClient(getRequestGeminiKey(req)), file.path, file.originalname, file.mimetype);
      res.json(result);
    } catch (error) {
      console.error("Transcription API Error:", error);
      res.status(500).json({
        error: getClientSafeErrorMessage(error),
      });
    } finally {
      const file = (req as express.Request & { file?: { path: string } }).file;
      if (file?.path) {
        fs.promises.unlink(file.path).catch(() => {});
      }
    }
  });

  app.post("/api/summarize", async (req, res) => {
    const { transcript, language, instruction } = req.body || {};

    if (!transcript || typeof transcript !== "string") {
      return res.status(400).json({ error: "Transcript text is required." });
    }

    try {
      res.json(await summarizeText(getGeminiClient(getRequestGeminiKey(req)), transcript, language, instruction));
    } catch (error) {
      console.error("Summarize API Error:", error);
      res.status(500).json({ error: getClientSafeErrorMessage(error) });
    }
  });

  app.post("/api/translate", async (req, res) => {
    const { text, targetLanguage } = req.body || {};

    if (!text || typeof text !== "string" || !targetLanguage || typeof targetLanguage !== "string") {
      return res.status(400).json({ error: "Text and targetLanguage are required." });
    }

    try {
      res.json(await translateTranscript(getGeminiClient(getRequestGeminiKey(req)), text, targetLanguage));
    } catch (error) {
      console.error("Translate API Error:", error);
      res.status(500).json({ error: getClientSafeErrorMessage(error) });
    }
  });

  app.post("/api/agent", async (req, res) => {
    const { message, mode, history } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Agent message is required." });
    }

    try {
      const client = getGeminiClient(getRequestGeminiKey(req));
      if (mode === "image") {
        return res.json(await createAgentImage(client, message));
      }

      return res.json(await askAgent(client, message, Array.isArray(history) ? history : []));
    } catch (error) {
      console.error("Agent API Error:", error);
      res.status(500).json({ error: getClientSafeErrorMessage(error) });
    }
  });

  // API Route: PDF Export
  app.post("/api/export/pdf", (req, res) => {
    const { title, content } = req.body;
    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }

    const doc = new PDFDocument();
    let filename = title ? `${title.replace(/\s+/g, '_')}.pdf` : 'transcript.pdf';
    
    // Set headers
    res.setHeader('Content-disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-type', 'application/pdf');

    doc.pipe(res);
    doc.fontSize(20).text(title || "Transcript", { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(content);
    doc.end();
  });

  // Vite middleware for development
  if (includeVite) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return app;
}

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  const app = await createApp();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}
