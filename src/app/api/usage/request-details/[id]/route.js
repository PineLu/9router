import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/usageDb";

/**
 * GET /api/usage/request-details/[id]
 * Returns the full stored request detail (request/response bodies included)
 * for the dashboard drill-down drawer. The list endpoint redacts bodies;
 * this single-record endpoint restores them. Because it exposes full prompt
 * and response bodies, dashboardGuard always requires a JWT/CLI token here,
 * even when passwordless dashboard access is enabled for the redacted list.
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Missing detail id" },
        { status: 400 }
      );
    }

    const detail = await getRequestDetailById(id);
    if (!detail) {
      return NextResponse.json(
        { error: "Request detail not found" },
        { status: 404 }
      );
    }

    // Best-effort account name resolution (mirrors the list route).
    try {
      const { getProviderConnections } = await import("@/lib/db/repos/connectionsRepo.js");
      for (const c of (await getProviderConnections()) || []) {
        if (detail.connectionId && c.id === detail.connectionId) {
          detail.accountName = c.name || c.email || String(c.id).slice(0, 8);
          break;
        }
      }
    } catch { /* name resolution is best-effort */ }

    return NextResponse.json({ detail });
  } catch (error) {
    console.error("[API] Failed to get request detail:", error);
    return NextResponse.json(
      { error: "Failed to fetch request detail" },
      { status: 500 }
    );
  }
}
