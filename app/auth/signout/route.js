import { NextResponse } from "next/server";
import { clearAuthCookies } from "../../../lib/youtube";

export const runtime = "nodejs";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  clearAuthCookies(response);
  return response;
}
