import { getConfig, readTokens } from "../../../lib/youtube";

export const runtime = "nodejs";

export async function GET() {
  const config = getConfig();
  return Response.json({
    configured: Boolean(config.clientId && config.clientSecret),
    authenticated: Boolean(await readTokens()),
    origin: config.origin,
    redirectUri: config.redirectUri,
  });
}
