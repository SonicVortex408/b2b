import { NextResponse } from "next/server";

/** Proxies to the FastAPI OR-Tools service (solver/). 503 when SOLVER_URL is unset so the client falls back. */
export async function POST(req: Request) {
  const url = process.env.SOLVER_URL;
  if (!url) return NextResponse.json({ error: "SOLVER_URL not configured" }, { status: 503 });
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/solver/schedule`, { method: "POST", headers: { "content-type": "application/json" }, body: await req.text(), signal: AbortSignal.timeout(15000) });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "solver unreachable" }, { status: 502 });
  }
}
