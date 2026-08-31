import { NextRequest, NextResponse } from "next/server";

// Demonstrates the optimistic-update + rollback pattern from the brief.
// Idempotent by design (state-setting, not toggling): POST always means
// "ensure watched," DELETE always means "ensure unwatched" — calling
// either repeatedly has the same net effect.
//
// No real persistence backend exists for this demo (watch state lives
// client-side in the Zustand store) — this endpoint's job is purely to
// simulate a real network round-trip (latency + a chance of failure) so
// the optimistic-update-then-reconcile flow has something real to react
// to, not to be a production watchlist service.
const SIMULATED_LATENCY_MS = 400;
const SIMULATED_FAILURE_RATE = 0.3;

async function simulateBackend(propId: string) {
  await new Promise((resolve) => setTimeout(resolve, SIMULATED_LATENCY_MS));
  if (Math.random() < SIMULATED_FAILURE_RATE) {
    return NextResponse.json(
      { success: false, reason: "Simulated transient failure (demo)" },
      { status: 500 }
    );
  }
  return NextResponse.json({ success: true, propId });
}

export async function POST(request: NextRequest) {
  const { propId } = await request.json();
  return simulateBackend(propId);
}

export async function DELETE(request: NextRequest) {
  const { propId } = await request.json();
  return simulateBackend(propId);
}
