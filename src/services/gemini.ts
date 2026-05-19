async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || 'AI request failed.');
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
