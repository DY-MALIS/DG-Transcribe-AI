let appPromise: Promise<any> | null = null;

function toClientSafeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Missing GEMINI_API_KEY")) {
    return message;
  }

  if (message.includes("Cannot find module") || message.includes("ERR_MODULE_NOT_FOUND")) {
    return `Vercel API module failed to load: ${message}`;
  }

  return message || "Vercel API failed to start.";
}

function getApp() {
  if (!appPromise) {
    appPromise = import("../server.ts").then(mod => mod.createApp({ includeVite: false }));
  }

  return appPromise;
}

export default async function handler(req: any, res: any) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (error) {
    console.error("Vercel API boot error:", error);
    res.status(500).json({ error: toClientSafeErrorMessage(error) });
  }
}
