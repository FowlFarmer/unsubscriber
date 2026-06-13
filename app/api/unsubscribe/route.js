import { errorResponse, unsubscribe } from "../../../lib/youtube";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    return Response.json(await unsubscribe(body.subscriptionIds));
  } catch (error) {
    return errorResponse(error);
  }
}
