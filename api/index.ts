import { GoogleGenAI, Type, createPartFromUri } from "@google/genai";
import PDFDocument from "pdfkit";

type VercelRequest = {
  url?: string;
  method?: string;
  body?: any;
  headers?: Record<string, string | string[] | undefined>;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

type AgentHistoryItem = {
  role?: string;
  content?: string;
};

const TEXT_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-3-flash-preview"];
const TRANSCRIPTION_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-3-flash-preview"];
const IMAGE_MODELS = ["gemini-3-pro-image-preview"];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getApiKeys() {
  const keys = [
    ...(process.env.GEMINI_API_KEYS || "").split(","),
    process.env.GEMINI_API_KEY || "",
  ]
    .map(key => key.trim())
    .filter(key => key && key !== "MY_GEMINI_API_KEY");

  return [...new Set(keys)];
}

let clientIndex = 0;

function getGeminiClient(req: VercelRequest) {
  const headerKey = req.headers?.["x-gemini-api-key"];
  const personalKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  if (personalKey?.trim()) {
    return new GoogleGenAI({ apiKey: personalKey.trim() });
  }

  const keys = getApiKeys();
  if (keys.length === 0) {
    throw new Error("Missing GEMINI_API_KEY. Add it in Vercel Environment Variables and redeploy.");
  }

  const key = keys[clientIndex % keys.length];
  clientIndex++;
  return new GoogleGenAI({ apiKey: key });
}

function isRetryable(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("503") ||
    message.includes("unavailable") ||
    message.includes("overloaded") ||
    message.includes("rate limit") ||
    message.includes("temporarily") ||
    message.includes("deadline");
}

function canTryNextModel(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return isRetryable(error) ||
    message.includes("not found") ||
    message.includes("not supported") ||
    message.includes("unsupported") ||
    message.includes("invalid argument") ||
    message.includes("model");
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 3) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) {
        throw error;
      }
      await sleep(1200 * attempt);
    }
  }

  throw lastError;
}

async function generateWithFallback(client: GoogleGenAI, requestFactory: (model: string) => Parameters<GoogleGenAI["models"]["generateContent"]>[0]) {
  let lastError: unknown;

  for (const model of TEXT_MODELS) {
    try {
      return await withRetry(() => client.models.generateContent(requestFactory(model)));
    } catch (error) {
      lastError = error;
      if (!canTryNextModel(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function transcribeWithFallback(client: GoogleGenAI, fileUrl: string, fileType: string) {
  let lastError: unknown;

  for (const model of TRANSCRIPTION_MODELS) {
    try {
      const response = await withRetry(() => client.models.generateContent({
        model,
        contents: [
          {
            parts: [
              createPartFromUri(fileUrl, fileType),
              {
                text: `Transcribe this media accurately.
Preserve the full meaning.
If the speaker is clearly female, prefix lines with "ស្រី:".
If the speaker is clearly male, prefix lines with "ប្រុស:".
If gender is unclear, use "អ្នកនិយាយ 1:", "អ្នកនិយាយ 2:".
Return JSON only: {text, language, summary, points, takeaways}.`,
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING },
              language: { type: Type.STRING },
              summary: { type: Type.STRING },
              points: { type: Type.ARRAY, items: { type: Type.STRING } },
              takeaways: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ["text", "language", "summary", "points", "takeaways"],
          },
        },
      }));

      if (!response.text) {
        throw new Error("No transcription response from Gemini.");
      }

      return JSON.parse(response.text);
    } catch (error) {
      lastError = error;
      if (!canTryNextModel(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function summarize(client: GoogleGenAI, transcript: string, language = "original", instruction = "") {
  const response = await generateWithFallback(client, model => ({
    model,
    contents: `Summarize this transcript clearly.
${instruction ? `Instruction: ${instruction}` : "Include useful detail."}
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

  if (!response.text) throw new Error("No summary response from Gemini.");
  return JSON.parse(response.text);
}

async function translate(client: GoogleGenAI, text: string, targetLanguage: string) {
  const response = await generateWithFallback(client, model => ({
    model,
    contents: `Translate this transcript into ${targetLanguage} with full meaning and natural wording.
Do not summarize or omit details. Preserve speaker turns.

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

  if (!response.text) throw new Error("No translation response from Gemini.");
  return JSON.parse(response.text);
}

async function askAgent(client: GoogleGenAI, message: string, history: AgentHistoryItem[] = []) {
  const recentHistory = history
    .slice(-10)
    .map(item => `${item.role === "assistant" ? "Assistant" : "User"}: ${item.content || ""}`)
    .join("\n");

  const response = await generateWithFallback(client, model => ({
    model,
    contents: `You are DG Transcribe AI Agent, a helpful assistant inside a transcription app.
Answer clearly in the user's language. If the user asks in Khmer, answer in Khmer.

Recent conversation:
${recentHistory || "(none)"}

User:
${message}`,
  }));

  return { text: response.text || "I could not create a response. Please try again." };
}

async function createImage(client: GoogleGenAI, prompt: string) {
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
      if (!canTryNextModel(error)) throw error;
    }
  }

  throw lastError;
}

function getSafeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (message.includes("CONSUMER_SUSPENDED") || message.includes("has been suspended")) {
    return "Gemini API key is suspended. Create a new key in Vercel Environment Variables.";
  }
  if (message.includes("API key not valid") || message.includes("API_KEY_INVALID")) {
    return "Gemini API key is invalid. Update GEMINI_API_KEY in Vercel Environment Variables.";
  }
  if (lower.includes("quota") || message.includes("RESOURCE_EXHAUSTED")) {
    return "Gemini quota is exhausted. Add billing/quota or add more keys in GEMINI_API_KEYS.";
  }
  if (lower.includes("image") || lower.includes("modalit")) {
    return "Image generation is not available for this Gemini key/model yet. Try Ask Agent or enable Gemini image model access.";
  }
  if (message.includes("Missing GEMINI_API_KEY")) {
    return message;
  }

  return message || "AI request failed.";
}

function getBody(req: VercelRequest) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const pathname = new URL(req.url || "/api/health", "https://local.app").pathname;

  try {
    if (pathname.endsWith("/health")) {
      return res.status(200).json({ status: "ok" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed." });
    }

    const body = getBody(req);
    const client = getGeminiClient(req);

    if (pathname.endsWith("/agent")) {
      if (!body.message || typeof body.message !== "string") {
        return res.status(400).json({ error: "Agent message is required." });
      }
      if (body.mode === "image") {
        return res.status(200).json(await createImage(client, body.message));
      }
      return res.status(200).json(await askAgent(client, body.message, Array.isArray(body.history) ? body.history : []));
    }

    if (pathname.endsWith("/summarize")) {
      if (!body.transcript || typeof body.transcript !== "string") {
        return res.status(400).json({ error: "Transcript text is required." });
      }
      return res.status(200).json(await summarize(client, body.transcript, body.language, body.instruction));
    }

    if (pathname.endsWith("/translate")) {
      if (!body.text || !body.targetLanguage) {
        return res.status(400).json({ error: "Text and targetLanguage are required." });
      }
      return res.status(200).json(await translate(client, body.text, body.targetLanguage));
    }

    if (pathname.endsWith("/transcribe")) {
      if (!body.fileUrl || !body.fileName || !body.fileType) {
        return res.status(400).json({ error: "Cloud file URL, name, and type are required." });
      }
      return res.status(200).json(await transcribeWithFallback(client, String(body.fileUrl), String(body.fileType)));
    }

    if (pathname.endsWith("/export/pdf")) {
      if (!body.content) {
        return res.status(400).json({ error: "Content is required." });
      }
      const filename = body.title ? `${String(body.title).replace(/\s+/g, "_")}.pdf` : "transcript.pdf";
      res.setHeader("Content-disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-type", "application/pdf");
      const doc = new PDFDocument();
      doc.pipe(res as any);
      doc.fontSize(20).text(body.title || "Transcript", { align: "center" });
      doc.moveDown();
      doc.fontSize(12).text(body.content);
      doc.end();
      return;
    }

    return res.status(404).json({ error: "API route not found." });
  } catch (error) {
    console.error("Vercel API Error:", error);
    return res.status(500).json({ error: getSafeError(error) });
  }
}
