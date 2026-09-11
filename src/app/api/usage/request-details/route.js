import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";

/**
 * Pull a one-line error summary out of a stored request detail (before its
 * bodies get redacted). Returns null when there is no error info.
 */
function extractErrorMessage(d) {
  if (!d || d.status === "success") return null;
  const cands = [
    d?.response?.error,
    d?.providerResponse?.error,
    d?.response?.message,
    d?.providerResponse?.message,
    d?.error,
  ];
  for (const c of cands) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 300);
    if (c && typeof c === "object") {
      const m = c.message || c.error || c.msg;
      if (typeof m === "string" && m.trim()) return m.trim().slice(0, 300);
      try {
        const s = JSON.stringify(c);
        if (s && s !== "{}") return s.slice(0, 300);
      } catch {
        // ignore stringify failures
      }
    }
  }
  return null;
}

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const result = await getRequestDetails(filter);

    // Redact conversation payloads: the stored details include full request
    // bodies (user prompts, tool calls) and provider responses. Returning them
    // wholesale lets any dashboard-authenticated user (or, if requireLogin is
    // disabled, anyone) read every user's conversation history. Keep the
    // metadata (model, tokens, latency, status) but drop message content.
    // A one-line error summary is extracted first so failures stay diagnosable.
    const redactedDetails = (result.details || []).map((d) => {
      const redacted = { ...d, errorMessage: extractErrorMessage(d) };
      for (const key of ["request", "providerRequest", "providerResponse", "response"]) {
        if (redacted[key] !== undefined) {
          redacted[key] = { redacted: true };
        }
      }
      return redacted;
    });

    return NextResponse.json({ ...result, details: redactedDetails });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
