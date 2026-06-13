import { getAuthStatus } from "../../../lib/youtube";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await getAuthStatus());
}
