import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { assertConfigured, errorResponse, getConfig, setOauthStateCookie } from "../../../lib/youtube";

export const runtime = "nodejs";

export async function GET() {
  try {
    assertConfigured();
    const { clientId, redirectUri, scope } = getConfig();
    const state = crypto.randomBytes(16).toString("hex");
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);

    const response = NextResponse.redirect(authUrl);
    setOauthStateCookie(response, state);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
