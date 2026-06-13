import { NextResponse } from "next/server";
import { errorResponse, exchangeCode, getConfig, setTokenCookie } from "../../../lib/youtube";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    const requestUrl = new URL(request.url);
    const state = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");
    const expectedState = request.cookies.get("youtube_oauth_state")?.value;

    if (!state || state !== expectedState) {
      const error = new Error("Invalid OAuth state.");
      error.statusCode = 400;
      throw error;
    }
    if (!code) {
      const error = new Error("OAuth callback did not include a code.");
      error.statusCode = 400;
      throw error;
    }

    const tokens = await exchangeCode(code);
    const response = NextResponse.redirect(new URL("/?signed_in=1", getConfig().origin));
    setTokenCookie(response, tokens);
    response.cookies.delete("youtube_oauth_state");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
