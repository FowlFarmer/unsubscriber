import { errorResponse, runDevCommand } from "../../../lib/youtube";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    return Response.json(await runDevCommand(body.command));
  } catch (error) {
    return errorResponse(error);
  }
}
