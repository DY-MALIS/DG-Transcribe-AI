import { createApp, toClientSafeErrorMessage } from "../server.ts";

let appPromise: ReturnType<typeof createApp> | null = null;

function getApp() {
  if (!appPromise) {
    appPromise = createApp({ includeVite: false });
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
