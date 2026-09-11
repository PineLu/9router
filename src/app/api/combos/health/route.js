import { NextResponse } from "next/server";
import { getComboHealthSnapshot } from "@/../open-sse/services/combo.js";

export const dynamic = "force-dynamic";

// GET /api/combos/health - combo-level cooling snapshot (T2 failure memory)
export async function GET() {
  try {
    const cooling = getComboHealthSnapshot();
    return NextResponse.json({ cooling });
  } catch (error) {
    console.log("Error fetching combo health:", error);
    return NextResponse.json({ error: "Failed to fetch combo health" }, { status: 500 });
  }
}
