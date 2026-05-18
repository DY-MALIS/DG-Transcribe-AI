import { GoogleGenAI, Type, ThinkingLevel, createPartFromUri, FileState } from "@google/genai";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getFriendlyGeminiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('quota') || lowerMessage.includes('resource_exhausted')) {
    return 'Your Gemini API quota is exhausted. Use another API key or check billing/quota.';
  }

  if (lowerMessage.includes('api key') || lowerMessage.includes('api_key') || lowerMessage.includes('permission')) {
    return 'Your Gemini API key was rejected. Please paste a valid key in Quick Config and click Save.';
  }

  if (lowerMessage.includes('unsupported') || lowerMessage.includes('mime') || lowerMessage.includes('invalid argument')) {
    return 'Gemini did not accept this media format. Please convert it to MP3, WAV, M4A, or MP4 and upload again.';
  }

  if (lowerMessage.includes('503') || lowerMessage.includes('unavailable') || lowerMessage.includes('overloaded')) {
    return 'Gemini is temporarily unavailable. Please try again in a few minutes.';
  }

  if (lowerMessage.includes('timeout') || lowerMessage.includes('deadline')) {
    return 'Gemini took too long to process this file. Please try a shorter or compressed audio file.';
  }

  return message || 'AI transcription failed.';
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const userApiKey = localStorage.getItem('dg_gemini_api_key') || '';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(userApiKey ? { 'X-Gemini-Api-Key': userApiKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || 'AI request failed.');
  }

  return payload as T;
}

async function waitForGeminiFile(ai: GoogleGenAI, fileName: string) {
  const maxAttempts = 300;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const file = await ai.files.get({ name: fileName });

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

export async function processMediaInBrowser(file: File, apiKey: string) {
  if (!apiKey.trim()) {
    throw new Error("Personal Gemini API key is required for Vercel media uploads.");
  }

  try {
    const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
    const uploadedFile = await ai.files.upload({
      file,
      config: {
        mimeType: file.type,
        displayName: file.name,
      },
    });
    const readyFile = await waitForGeminiFile(ai, uploadedFile.name || "");

    if (!readyFile.uri || !readyFile.mimeType) {
      throw new Error("Gemini did not return a usable file URI.");
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          parts: [
            createPartFromUri(readyFile.uri, readyFile.mimeType),
            {
              text: `FAST MODE TRANSCRIPTION:
            - Detect language.
            - Transcribe speech accurately.
            - Preserve the full meaning; do not shorten important details.
            - If a speaker's voice is clearly female, prefix that speaker's lines with "ស្រី:".
            - If a speaker's voice is clearly male, prefix that speaker's lines with "ប្រុស:".
            - If gender is unclear, use "អ្នកនិយាយ 1:", "អ្នកនិយាយ 2:", etc.
            - Keep summary, points, and takeaways concise but complete.

            Return JSON only: {text, language, summary, points, takeaways}.`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
    });

    if (!response.text) {
      throw new Error("No response text from Gemini");
    }

    return JSON.parse(response.text);
  } catch (error) {
    throw new Error(getFriendlyGeminiError(error));
  }
}

export async function summarizeTranscript(transcript: string, language: string = "original", customInstruction: string = "") {
  return postJson<{ summary: string; points: string[]; takeaways: string[] }>('/api/summarize', {
    transcript,
    language,
    instruction: customInstruction,
  });
}

export async function translateText(text: string, targetLang: string) {
  return postJson<{ translatedText: string }>('/api/translate', {
    text,
    targetLanguage: targetLang,
  });
}
