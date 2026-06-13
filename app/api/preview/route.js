export const runtime = "nodejs";

export async function POST() {
  return Response.json(
    {
      error: "Regex preview now runs in the browser against the cached subscription snapshot.",
    },
    { status: 410 },
  );
}
