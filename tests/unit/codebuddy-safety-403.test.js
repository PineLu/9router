import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  getAntigravityQuotaCache: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: mocks.validateApiKey,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));

vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: mocks.getAntigravityQuotaCache,
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  warn: mocks.warn,
  debug: mocks.debug,
  info: mocks.info,
}));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const CODEBUDDY_SAFETY_403 = JSON.stringify({
  code: 11140,
  msg: "request illegal",
  requestId: "test-request",
  displayMsg: {
    en: "The content did not pass the safety review. Please adjust and retry.",
    zh: "内容未通过安全审核，请调整后重试。",
  },
});

describe("CodeBuddy request-scoped safety 403", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "account-1",
        displayName: "Account 1",
        backoffLevel: 0,
      },
    ]);
    mocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  it("does not persist modelLock or mark the account unavailable for code=11140", async () => {
    const result = await markAccountUnavailable(
      "account-1",
      403,
      `[403]: ${CODEBUDDY_SAFETY_403}`,
      "codebuddy-intl",
      "deepseek-v4.1-flash",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("recognizes the cbai short alias without persisting a lock", async () => {
    const result = await markAccountUnavailable(
      "account-1",
      403,
      `[403]: ${CODEBUDDY_SAFETY_403}`,
      "cbai",
      "deepseek-v4.1-flash",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("still locks an ordinary CodeBuddy permission 403", async () => {
    const result = await markAccountUnavailable(
      "account-1",
      403,
      "permission denied",
      "codebuddy-intl",
      "deepseek-v4.1-flash",
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBe(2 * 60 * 1000);
    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);

    const [, update] = mocks.updateProviderConnection.mock.calls[0];
    expect(update.testStatus).toBe("unavailable");
    expect(update.errorCode).toBe(403);
    expect(update["modelLock_deepseek-v4.1-flash"]).toEqual(expect.any(String));
  });
});
