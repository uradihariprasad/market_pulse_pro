/**
 * CANONICAL OI intelligence (five-metric methodology).
 *
 * Serves the single source of truth for every OI metric: 30s change, rolling
 * 5m, rolling 15m, cumulative change from the persisted opening baseline,
 * derived Combined Total OI, and the provider's Actual Total OI. Reads
 * already-polled shared state — no extra provider requests are made here.
 */
import { NextResponse } from "next/server";
import { ensureBoot } from "@/lib/market/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("instrumentKey") ?? "";
  if (!key) {
    return NextResponse.json({ ok: false, state: "FAILED", error: "instrumentKey required" }, { status: 400 });
  }

  const e = await ensureBoot();
  e.setFocus(key); // prioritise this underlying on the next chain cycle

  const result = e.getCanonicalOi(key);
  if ("error" in result) {
    return NextResponse.json({
      ok: false,
      state: result.state,
      error: result.error,
      tokenStatus: e.getStatus().tokenStatus,
      asOf: Date.now(),
    });
  }

  return NextResponse.json({
    ok: true,
    state: "LOADED",
    oi: result,
    expiries: e.universe?.optionUnderlyings.get(result.underlyingKey)?.expiries ?? [],
    tokenStatus: e.getStatus().tokenStatus,
    marketPhase: e.getStatus().marketPhase,
    asOf: Date.now(),
  });
}
