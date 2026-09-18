// Silent-refusal ("content_policy_blocked") root-cause fix: an HTTP-200 turn
// whose model declined the request must behave like a failure so routing moves
// on. Covers three paths:
//
//  1. contentFilter unit — refusal detector (finish_reason / finishReason /
//     short refusal text) shared by all handlers.
//  2. non-stream handlers — detected refusals become 403 errors → combo tries
//     the next model on the SAME request, account layer cools the credential.
//  3. streaming completion — the turn is already on the wire, so only combo
//     failure memory is recorded (2min skip); the NEXT request avoids it.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const {
  getContentFilterRefusal,
  extractRefusalPreview,
  isContentFilterFinish,
  isRefusalText,
} = await import("../../open-sse/handlers/chatCore/contentFilter.js");

const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
const usageDb = await import("@/lib/usageDb.js");
const { handleComboChat, isComboModelCooling, resetComboRotation } = await import("../../open-sse/services/combo.js");

function refusalBody() {
  return {
    id: "chatcmpl-x",
    object: "chat.completion",
    created: 1700000000,
    model: "cbcn/deepseek-v4.1-flash",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "抱歉，我无法帮助处理这个请求。" },
      finish_reason: "content_filter",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
  };
}

function okBody() {
  return {
    id: "chatcmpl-y",
    object: "chat.completion",
    created: 1700000000,
    model: "cl/good",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "Here is the diff you asked for…" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe("contentFilter detector", () => {
  it("flags OpenAI finish_reason=content_filter", () => {
    expect(getContentFilterRefusal(refusalBody())).toBe("finish_reason=content_filter");
  });

  it("flags gemini SAFETY / native blocked bodies", () => {
    expect(getContentFilterRefusal({ candidates: [{ finishReason: "SAFETY" }] })).toBe("finishReason=SAFETY");
    expect(getContentFilterRefusal({ response: { candidates: [{ finishReason: "RECITATION" }] } })).toBe("finishReason=RECITATION");
  });

  it("flags short refusal text even with finish_reason=stop", () => {
    const body = {
      choices: [{ message: { role: "assistant", content: "I can't help with this request due to content policy." }, finish_reason: "stop" }],
    };
    expect(getContentFilterRefusal(body)).toBe("refusal-text");
  });

  it("flags Responses API refusal items and refusal output_text", () => {
    const explicit = {
      object: "response",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "I can't help with this request." }],
      }],
    };
    expect(getContentFilterRefusal(explicit)).toBe("response-refusal");
    expect(extractRefusalPreview(explicit)).toContain("can't help");

    const textOnly = {
      object: "response",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "抱歉，我无法帮助处理这个请求。" }],
      }],
    };
    expect(getContentFilterRefusal(textOnly)).toBe("refusal-text");
  });

  it("passes normal answers and tool_calls turns", () => {
    expect(getContentFilterRefusal(okBody())).toBeNull();
    const toolTurn = {
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    };
    expect(getContentFilterRefusal(toolTurn)).toBeNull();
    // Long-form discussion of policy is not a refusal.
    expect(isRefusalText(`content policy discussion ${"x".repeat(700)}`)).toBe(false);
  });

  it("does not flag short legitimate policy/moderation explanations", () => {
    expect(isRefusalText("A content policy defines which categories require moderation.")).toBe(false);
    expect(isRefusalText("Sensitive content is a category used by moderation systems.")).toBe(false);
    expect(isRefusalText("Policy violation detection should distinguish discussion from refusal.")).toBe(false);
    expect(isRefusalText("这段代码用于检测内容违规，不代表模型拒绝回答。")).toBe(false);
  });

  it("still flags explicit policy refusals", () => {
    expect(isRefusalText("This request violates our content policy.")).toBe(true);
    expect(isRefusalText("I'm sorry, I can't help with this request.")).toBe(true);
    expect(isRefusalText("抱歉，这个请求涉及敏感内容，我无法提供帮助。")).toBe(true);
  });

  it("isContentFilterFinish covers hub + gemini blocked values", () => {
    expect(isContentFilterFinish("content_filter")).toBe(true);
    expect(isContentFilterFinish("SAFETY")).toBe(true);
    expect(isContentFilterFinish("stop")).toBe(false);
    expect(isContentFilterFinish(null)).toBe(false);
  });

  it("extractRefusalPreview returns a one-line snippet", () => {
    expect(extractRefusalPreview(refusalBody())).toContain("抱歉");
    expect(extractRefusalPreview(okBody()).length).toBeGreaterThan(0);
    expect(extractRefusalPreview(null)).toBe("");
  });
});

describe("non-stream refusal → 403 error (combo can fall back)", () => {
  function callHandler(body) {
    const providerResponse = {
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body,
    };
    const logged = [];
    return handleNonStreamingResponse({
      providerResponse,
      provider: "codebuddy-cn",
      model: "deepseek-v4.1-flash",
      sourceFormat: "openai",
      targetFormat: "openai",
      body: { stream: false },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "c1",
      apiKey: "k",
      clientRawRequest: null,
      onRequestSuccess: () => {},
      reqLogger: { logProviderResponse() {}, logConvertedResponse() {}, logError() {} },
      toolNameMap: null,
      customToolNames: null,
      trackDone: () => {},
      appendLog: (e) => logged.push(e),
      pxpipe: null,
      reqTag: "T",
      log: { line: (...a) => logged.push(a.join(" ")) },
    }).then((r) => ({ result: r, logged }));
  }

  it("converts a content_filter body into success:false + 403", async () => {
    const { result, logged } = await callHandler(refusalBody());
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/Content filtered/);
    expect(logged.some((e) => String(e?.status || e).includes("403"))).toBe(true);
  });

  it("leaves a normal body as success:true", async () => {
    const { result } = await callHandler(okBody());
    expect(result.success).toBe(true);
  });
});

describe("streaming refusal → combo failure memory for the NEXT request", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("records 2min cooling keyed combo::provider/model on content_filter finish", () => {
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "codebuddy-cn",
      model: "deepseek-v4.1-flash",
      connectionId: "c1",
      apiKey: "k",
      requestStartTime: Date.now(),
      body: {},
      stream: true,
      finalBody: null,
      translatedBody: null,
      clientRawRequest: null,
      pxpipe: null,
      reqTag: "T",
      log: { line() {} },
      comboName: "my-combo",
    });
    onStreamComplete({ content: "抱歉，我无法帮助。", thinking: null }, null, Date.now(), { finishReason: "content_filter" });
    expect(isComboModelCooling("my-combo", "codebuddy-cn/deepseek-v4.1-flash")).toBe(true);
  });

  it("cools on finish_reason=stop when the streamed text is a refusal", () => {
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "codebuddy-cn",
      model: "deepseek-v4.1-flash",
      connectionId: "c1",
      apiKey: "k",
      requestStartTime: Date.now(),
      body: {},
      stream: true,
      finalBody: null,
      translatedBody: null,
      clientRawRequest: null,
      pxpipe: null,
      reqTag: "T",
      log: { line() {} },
      comboName: "my-combo",
    });
    onStreamComplete({ content: "抱歉，我无法帮助处理这个请求。", thinking: null }, null, Date.now(), { finishReason: "stop" });
    expect(isComboModelCooling("my-combo", "codebuddy-cn/deepseek-v4.1-flash")).toBe(true);
  });

  it("does nothing for a normal stop finish", () => {
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "codebuddy-cn",
      model: "deepseek-v4.1-flash",
      connectionId: "c1",
      apiKey: "k",
      requestStartTime: Date.now(),
      body: {},
      stream: true,
      finalBody: null,
      translatedBody: null,
      clientRawRequest: null,
      pxpipe: null,
      reqTag: "T",
      log: { line() {} },
      comboName: "my-combo",
    });
    onStreamComplete({ content: "here is the code", thinking: null }, null, Date.now(), { finishReason: "stop" });
    expect(isComboModelCooling("my-combo", "codebuddy-cn/deepseek-v4.1-flash")).toBe(false);
  });
});

describe("forced Responses SSE → JSON", () => {
  function responsesSse(item, usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14 }) {
    return [
      'event: response.created',
      'data: {"response":{"id":"resp-test","created_at":1700000000}}',
      '',
      'event: response.output_item.done',
      `data: ${JSON.stringify({ output_index: 0, item })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ response: { usage } })}`,
      '',
      '',
    ].join("\n");
  }

  function callForced(item) {
    return handleForcedSSEToJson({
      providerResponse: new Response(responsesSse(item), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: "openai",
      targetFormat: "openai-responses",
      provider: "test-provider",
      model: "test-model",
      body: { model: "my-combo", stream: false },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "c1",
      apiKey: "k",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: { model: "my-combo" } },
      onRequestSuccess: () => {},
      customToolNames: null,
      trackDone: () => {},
      appendLog: () => {},
      reqTag: "T",
      log: { line() {} },
      comboName: "my-combo",
    });
  }

  it("returns JSON instead of throwing on a normal Responses body", async () => {
    const result = await callForced({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Here is the answer." }],
    });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices?.[0]?.message?.content).toBe("Here is the answer.");
  });

  it("turns a Responses refusal into 403 for combo fallback", async () => {
    const result = await callForced({
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal: "I can't help with that request." }],
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/Content filtered/);
  });
});

describe("usage attribution", () => {
  it("persists comboName and the original requested model", () => {
    usageDb.saveRequestUsage.mockClear();
    saveUsageStats({
      provider: "codebuddy-cn",
      model: "deepseek-v4.1-flash",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
      connectionId: "c1",
      apiKey: "k",
      endpoint: "/v1/chat/completions",
      comboName: "my-combo",
      requestedModel: "my-combo",
      silent: true,
    });
    expect(usageDb.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      comboName: "my-combo",
      requestedModel: "my-combo",
    }));
  });
});

describe("combo falls back on the SAME non-stream request after a refusal", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("tries the second model when the first returns a 403 refusal response", async () => {
    const calls = [];
    const refusal403 = new Response(
      JSON.stringify({ error: { message: "[403]: Content filtered (finish_reason=content_filter)" } }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
    const good = new Response(JSON.stringify(okBody()), { status: 200, headers: { "Content-Type": "application/json" } });
    const handleSingleModel = async (_body, model) => {
      calls.push(model);
      return model === "cbcn/bad" ? refusal403 : good;
    };
    const log = { info() {}, warn() {} };
    const r = await handleComboChat({
      body: {},
      models: ["cbcn/bad", "cl/good"],
      handleSingleModel,
      log,
      comboName: "refusal-combo",
    });
    expect(calls).toEqual(["cbcn/bad", "cl/good"]);
    expect(r.ok).toBe(true);
    // The refused model cools so the NEXT request skips it outright.
    expect(isComboModelCooling("refusal-combo", "cbcn/bad")).toBe(true);
  });
});

// A refusal is returned to the client as 403, so the observability records must
// agree: no 200 OK, no status=success, and no onRequestSuccess() (which would
// clear the account cooldown/health state for a turn the model actually
// refused). Token usage is still persisted — the upstream turn really ran.
describe("refusal observability matches the final HTTP result", () => {
  function callNonStreaming(body) {
    const providerResponse = {
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body,
    };
    const onRequestSuccess = vi.fn();
    const logged = [];
    return handleNonStreamingResponse({
      providerResponse,
      provider: "codebuddy-cn",
      model: "deepseek-v4.1-flash",
      sourceFormat: "openai",
      targetFormat: "openai",
      body: { stream: false },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "c1",
      apiKey: "k",
      clientRawRequest: null,
      onRequestSuccess,
      reqLogger: { logProviderResponse() {}, logConvertedResponse() {}, logError() {} },
      toolNameMap: null,
      customToolNames: null,
      trackDone: () => {},
      appendLog: (e) => logged.push(e),
      pxpipe: null,
      reqTag: "T",
      log: { line: (...a) => logged.push(a.join(" ")) },
    }).then((r) => ({ result: r, logged, onRequestSuccess }));
  }

  it("non-stream refusal: error status, 403 logged, no onRequestSuccess, usage kept", async () => {
    usageDb.saveRequestDetail.mockClear();
    usageDb.saveRequestUsage.mockClear();
    usageDb.appendRequestLog.mockClear();

    const { result, logged, onRequestSuccess } = await callNonStreaming(refusalBody());

    expect(result.status).toBe(403);
    expect(onRequestSuccess).not.toHaveBeenCalled();

    const detailArg = usageDb.saveRequestDetail.mock.calls.at(-1)?.[0];
    expect(detailArg?.status).toBe("error");
    expect(detailArg?.status).not.toBe("success");

    const statuses = logged.map((e) => String(e?.status ?? e));
    expect(statuses.some((s) => s.includes("403"))).toBe(true);
    expect(statuses.some((s) => s === "200 OK")).toBe(false);

    // Upstream consumed tokens even though it refused → usage still recorded.
    expect(usageDb.saveRequestUsage).toHaveBeenCalled();
  });

  it("non-stream normal answer: success status, 200 logged, onRequestSuccess fired once", async () => {
    usageDb.saveRequestDetail.mockClear();
    usageDb.saveRequestUsage.mockClear();

    const { result, logged, onRequestSuccess } = await callNonStreaming(okBody());

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);

    const detailArg = usageDb.saveRequestDetail.mock.calls.at(-1)?.[0];
    expect(detailArg?.status).toBe("success");
    expect(logged.map((e) => String(e?.status ?? e))).toContain("200 OK");
  });

  function responsesSse(item, usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14 }) {
    return [
      'event: response.created',
      'data: {"response":{"id":"resp-obs","created_at":1700000000}}',
      '',
      'event: response.output_item.done',
      `data: ${JSON.stringify({ output_index: 0, item })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ response: { usage } })}`,
      '',
      '',
    ].join("\n");
  }

  function callForced(item) {
    const onRequestSuccess = vi.fn();
    const logged = [];
    return handleForcedSSEToJson({
      providerResponse: new Response(responsesSse(item), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: "openai",
      targetFormat: "openai-responses",
      provider: "test-provider",
      model: "test-model",
      body: { model: "my-combo", stream: false },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "c1",
      apiKey: "k",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: { model: "my-combo" } },
      onRequestSuccess,
      customToolNames: null,
      trackDone: () => {},
      appendLog: (e) => logged.push(e),
      reqTag: "T",
      log: { line: (...a) => logged.push(a.join(" ")) },
      comboName: "my-combo",
    }).then((r) => ({ result: r, logged, onRequestSuccess }));
  }

  it("Responses SSE→JSON refusal: 403, no onRequestSuccess, detail error, usage kept", async () => {
    usageDb.saveRequestDetail.mockClear();
    usageDb.saveRequestUsage.mockClear();

    const { result, logged, onRequestSuccess } = await callForced({
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal: "I can't help with that request." }],
    });

    expect(result.status).toBe(403);
    expect(onRequestSuccess).not.toHaveBeenCalled();

    const detailArg = usageDb.saveRequestDetail.mock.calls.at(-1)?.[0];
    expect(detailArg?.status).toBe("error");

    const statuses = logged.map((e) => String(e?.status ?? e));
    expect(statuses.some((s) => s.includes("403"))).toBe(true);
    expect(statuses.some((s) => s === "200 OK")).toBe(false);
    expect(usageDb.saveRequestUsage).toHaveBeenCalled();
  });

  it("Responses SSE→JSON normal: success, onRequestSuccess once, detail success", async () => {
    usageDb.saveRequestDetail.mockClear();

    const { result, onRequestSuccess } = await callForced({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Here is the answer." }],
    });

    expect(result.success).toBe(true);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(usageDb.saveRequestDetail.mock.calls.at(-1)?.[0]?.status).toBe("success");
  });
});
