async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let payload: any = {};

  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = { error: responseText };
  }

  if (!response.ok) {
    throw new Error(payload.error || `AI request failed with status ${response.status}.`);
  }

  return payload as T;
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

export type AgentHistoryItem = {
  role: 'user' | 'assistant';
  content: string;
};

export async function askAgent(message: string, history: AgentHistoryItem[]) {
  return postJson<{ text: string }>('/api/agent', {
    message,
    history,
    mode: 'chat',
  });
}

export async function createAgentImage(message: string, history: AgentHistoryItem[]) {
  return postJson<{ text?: string; imageUrl: string }>('/api/agent', {
    message,
    history,
    mode: 'image',
  });
}
