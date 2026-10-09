import { NextResponse } from "next/server";

// Fork safety policy: upstream's public Netlify relay permits arbitrary target URLs
// without caller authentication. Do not deploy a vulnerable public function.
// Existing Netlify pool compatibility is intentionally unaffected.
export async function POST() {
  return NextResponse.json(
    { error: "Netlify Relay deployment is disabled for security. Use a different proxy type." },
    { status: 403 }
  );
}
