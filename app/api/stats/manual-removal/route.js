import { errorResponse, incrementGlobalRemoved } from "../../../../lib/youtube";

export const runtime = "nodejs";

export async function POST() {
  try {
    const globalStats = await incrementGlobalRemoved(1);
    return Response.json({ globalStats });
  } catch (error) {
    return errorResponse(error);
  }
}
