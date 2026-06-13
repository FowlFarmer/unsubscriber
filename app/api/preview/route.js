import { errorResponse, previewMatches } from "../../../lib/youtube";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    return Response.json(await previewMatches(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}
