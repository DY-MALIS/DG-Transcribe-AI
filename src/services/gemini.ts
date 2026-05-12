import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function processMediaAI(fileBase64: string, mimeType: string) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            {
              inlineData: {
                data: fileBase64,
                mimeType: mimeType,
              },
            },
            {
              text: `FASTEST TRANSCRIPTION:
              1. DETECT language. 2. TRANSCRIBE word-for-word.
              3. LABELS: Identify speakers (e.g. Speaker 1). Add "(ស្រី)" if female.
              
              JSON Format: {text, language, summary, points, takeaways}.
              PRIORITY: SPEED.`,
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
            text: { type: Type.STRING, description: "Full transcription" },
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
    console.error("Gemini API Error:", error);
    throw error;
  }
}

export async function summarizeTranscript(transcript: string, language: string = "original", customInstruction: string = "") {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Please summarize the following transcript deeply and intelligently. 
      ${customInstruction ? `SPECIAL USER INSTRUCTION: ${customInstruction}` : "The summary should be comprehensive and professional, capturing the core essence and important details clearly. Do NOT make the summary too short; ensure it provides enough context to be fully understood."}
      Provide the summary in ${language === "original" ? "the original language of the transcript" : language}.
      
      Transcript:
      ${transcript}
      
      Output strictly in JSON format with fields: 'summary', 'points', 'takeaways'.`,
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
    });

    if (!response.text) throw new Error("No response");
    return JSON.parse(response.text);
  } catch (error) {
    console.error("Summarization Error:", error);
    throw error;
  }
}

export async function translateText(text: string, targetLang: string) {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Translate the following text into ${targetLang}. Preserve any speaker labels.
    
    Text:
    ${text}
    
    Output the translation as a plain string inside a JSON object with the field 'translatedText'.`,
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
  });

  return JSON.parse(response.text || "{}");
}

export async function generateActionItems(transcript: string) {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Analyze this transcript and extract actionable items and smart meeting notes.
    
    Transcript:
    ${transcript}
    
    Output in JSON format with fields: 'actionItems' (array of strings), 'meetingNotes' (string).`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          actionItems: { type: Type.ARRAY, items: { type: Type.STRING } },
          meetingNotes: { type: Type.STRING },
        },
        required: ["actionItems", "meetingNotes"],
      },
    },
  });

  return JSON.parse(response.text || "{}");
}
