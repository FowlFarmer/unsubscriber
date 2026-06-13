import { createSubscriptionSnapshot, errorResponse } from "../../../../lib/youtube";

export const runtime = "nodejs";

export async function POST() {
  try {
    return Response.json(await createSubscriptionSnapshot());
  } catch (error) {
    return errorResponse(error);
  }
}
