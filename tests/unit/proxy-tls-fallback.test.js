import { afterEach, describe, expect, it, vi } from "vitest";

const realFetch = globalThis.fetch;
const originalStrictSsl = process.env.STRICT_SSL;

function tlsCertError() {
  const err = new TypeError("fetch failed");
  err.cause = { code: "DEPTH_ZERO_SELF_SIGNED_CERT" };
  return err;
}

async function loadWithFetch(fetchMock) {
  vi.resetModules();
  globalThis.fetch = fetchMock;
  return import("../../open-sse/utils/proxyFetch.js");
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalStrictSsl === undefined) delete process.env.STRICT_SSL;
  else process.env.STRICT_SSL = originalStrictSsl;
});

describe("proxy TLS certificate fallback", () => {
  it("does not retry with insecure TLS when STRICT_SSL is unset", async () => {
    delete process.env.STRICT_SSL;
    const err = tlsCertError();
    const fetchMock = vi.fn().mockRejectedValue(err);
    const { proxyAwareFetch } = await loadWithFetch(fetchMock);

    await expect(proxyAwareFetch("https://example.test/v1/chat", {
      headers: { authorization: "Bearer secret" },
    })).rejects.toBe(err);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows the insecure retry only when STRICT_SSL=false is explicit", async () => {
    process.env.STRICT_SSL = "false";
    const err = tlsCertError();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const { proxyAwareFetch } = await loadWithFetch(fetchMock);

    const response = await proxyAwareFetch("https://example.test/v1/chat");
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.dispatcher).toBeTruthy();
  });
});
