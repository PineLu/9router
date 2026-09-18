// Silent-refusal ("content_policy_blocked") detection.
//
// Some upstreams answer HTTP 200 but the model declined the request — e.g.
// CodeBuddy-cn's Tencent filter returns finish_reason=content_filter plus an
// apology text, and Gemini-family upstreams return SAFETY/RECITATION/etc.
// Serving that as a good answer poisons combo routing (result.ok === true),
// so chatCore converts it into a 403 error and lets combo/account fallback
// move to the next model. Shared by the non-stream handlers and the streaming
// completion callback; kept in its own module so both directions import it
// without creating a handler ↔ handler cycle.
import { OPENAI_FINISH, GEMINI_FINISH } from "../../translator/schema/finishReasons.js";

// Gemini finishReasons that mean "blocked", never a real answer.
const GEMINI_BLOCKED = new Set([
  GEMINI_FINISH.SAFETY,
  GEMINI_FINISH.RECITATION,
  GEMINI_FINISH.BLOCKLIST,
  GEMINI_FINISH.PROHIBITED_CONTENT,
]);

// Text fallback for providers that refuse with finish_reason=stop. Match
// refusal semantics, not policy vocabulary alone: legitimate short answers
// often discuss "content policy", "sensitive content", or moderation.
const REFUSAL_TEXT_PATTERNS = [
  // Ambiguous phrases such as "I can't help but notice..." or "I cannot
  // provide an exact estimate without logs" are normal answers, not policy
  // refusals. Require the refusal to target the request/task, or explicit
  // policy/safety language.
  /\b(?:i\s+)?(?:cannot|can['’]t|am unable to|won['’]t|will not)\s+(?:help|assist|comply)\s+(?:with\s+)?(?:this|that|your|the)\s+(?:request|prompt|task)\b/i,
  /\b(?:i\s+)?(?:cannot|can['’]t|am unable to|won['’]t|will not)\s+(?:help|assist|comply)\s+(?:with\s+)?(?:this|that)\b/i,
  /\bsorry\b.{0,60}\b(?:cannot|can['’]t|unable|won['’]t|will not)\b.{0,60}\b(?:request|prompt|task|policy|safety|guidelines?)\b/i,

  // Explicit statement that THIS request/prompt/content violates a rule.
  /\b(?:this|that|your|the)\s+(?:request|prompt|content)\b.{0,50}\bviolates?\b.{0,40}\b(?:policy|policies|guidelines|rules)\b/i,
  /\b(?:policy|safety|guidelines?)\b.{0,40}\b(?:prevents?|prohibits?|does not allow)\b.{0,40}\b(?:help|assist|comply|provide|answer|continue)\b/i,

  // Chinese: require either an explicit request/content target or an explicit
  // safety/policy reason. Generic "我无法判断/回答..." is not a refusal.
  /抱歉.{0,30}(?:无法|不能|不便|拒绝).{0,30}(?:这个|该|您的|你的)?(?:请求|要求|内容)/,
  /抱歉.{0,40}(?:敏感|违规|政策|安全).{0,40}(?:无法|不能|拒绝).{0,20}(?:帮助|提供|协助|处理)/,
  /(?:我|本助手|模型).{0,10}(?:无法|不能).{0,30}(?:帮助|协助|处理).{0,20}(?:这个|该|您的|你的)?(?:请求|要求)/,
  /(?:这个|该|您的|你的)?(?:请求|内容|问题).{0,20}(?:违反|不符合).{0,20}(?:政策|规定|规范|准则)/,
  /(?:基于|由于).{0,20}(?:安全|政策|规定).{0,30}(?:无法|不能|拒绝)/,
];

// Refusal texts are short apologies; cap the text-pattern match so a long
// legitimate answer that mentions policy never trips the detector.
const REFUSAL_TEXT_MAX_LEN = 600;

/**
 * True when a finish/stop reason means "the model refused / was filtered".
 */
export function isContentFilterFinish(reason) {
  if (!reason) return false;
  const r = String(reason);
  return r === OPENAI_FINISH.CONTENT_FILTER || GEMINI_BLOCKED.has(r.toUpperCase());
}

/**
 * True when a (short) assistant text looks like a policy refusal apology.
 */
export function isRefusalText(text) {
  if (typeof text !== "string" || !text) return false;
  if (text.length > REFUSAL_TEXT_MAX_LEN) return false;
  return REFUSAL_TEXT_PATTERNS.some((re) => re.test(text));
}

function messageText(choice) {
  const c = choice?.message?.content;
  if (typeof c === "string") return c;
  return "";
}

function checkOpenAIBody(body) {
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  for (const choice of choices) {
    const finish = choice?.finish_reason;
    if (finish === OPENAI_FINISH.CONTENT_FILTER) return "finish_reason=content_filter";
    // Text fallback only when the model is not making tool calls: a tool_calls
    // turn that mentions policy is a working turn, not a refusal.
    if (finish === OPENAI_FINISH.TOOL_CALLS) continue;
    const text = messageText(choice);
    if (!text || text.length > REFUSAL_TEXT_MAX_LEN) continue;
    if (isRefusalText(text)) return "refusal-text";
  }
  return null;
}

function checkGeminiBody(body) {
  const candidates = body?.candidates || body?.response?.candidates || [];
  for (const cand of candidates) {
    const reason = String(cand?.finishReason || "").toUpperCase();
    if (reason && GEMINI_BLOCKED.has(reason)) return `finishReason=${cand.finishReason}`;
  }
  return null;
}

function responsesTextParts(body) {
  const output = Array.isArray(body?.output) ? body.output : [];
  const parts = [];
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (typeof part?.refusal === "string" && part.refusal) {
        parts.push({ text: part.refusal, refusal: true });
      } else if (typeof part?.text === "string" && part.text) {
        parts.push({ text: part.text, refusal: part?.type === "refusal" });
      }
    }
  }
  return parts;
}

function checkResponsesBody(body) {
  const output = Array.isArray(body?.output) ? body.output : [];
  if (output.length === 0) return null;

  const parts = responsesTextParts(body);
  if (parts.some((part) => part.refusal)) return "response-refusal";

  // A working tool-call response is not a refusal merely because an adjacent
  // text item mentions policy/safety.
  const hasToolCalls = output.some((item) =>
    item?.type === "function_call" || item?.type === "custom_tool_call"
  );
  if (hasToolCalls) return null;

  const text = parts.map((part) => part.text).join("\n");
  if (isRefusalText(text)) return "refusal-text";
  return null;
}

/**
 * Inspect one or more response bodies (raw upstream and/or translated) for a
 * silent refusal. Returns a short reason code, or null when the body looks
 * like a real answer.
 */
export function getContentFilterRefusal(...bodies) {
  for (const body of bodies) {
    if (!body || typeof body !== "object") continue;
    const hit = checkOpenAIBody(body) || checkGeminiBody(body) || checkResponsesBody(body);
    if (hit) return hit;
  }
  return null;
}

/**
 * Short single-line preview of the refusal text for error messages/logs.
 */
export function extractRefusalPreview(...bodies) {
  for (const body of bodies) {
    for (const choice of (Array.isArray(body?.choices) ? body.choices : [])) {
      const text = messageText(choice).replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 120);
    }
    for (const part of responsesTextParts(body)) {
      const text = part.text.replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 120);
    }
  }
  return "";
}
