import { createApp } from "../server";

const appPromise = createApp({ includeVite: false });

export default async function handler(req: any, res: any) {
  const app = await appPromise;
  return app(req, res);
}
