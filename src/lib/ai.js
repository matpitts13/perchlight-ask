// Workers AI and Vectorize calls, in one place (tests replace the bindings).
// AI Gateway is used when AI_GATEWAY_ID is set (Should; off by default).
import { MODELS, EMBED_MODELS } from "./config.js";
import { genNeurons, embedNeurons } from "./ledger.js";
import { errText } from "./http.js";

export class AIError extends Error {
  constructor(message, quota) {
    super(message);
    this.quota = quota;
  }
}

/** Whether an AI error looks like the daily neuron limit (wording isn't documented, so this is broad). */
export function isQuotaError(err) {
  return /neuron|quota|daily (free )?(allocation|limit)|\b4006\b/i.test(errText(err));
}

function gatewayOpts(env) {
  return env.AI_GATEWAY_ID ? { gateway: { id: String(env.AI_GATEWAY_ID) } } : undefined;
}

/** Embeds texts with the configured model; returns vectors and the neurons it cost (estimated from text length). */
export async function embed(env, cfg, texts) {
  const rates = EMBED_MODELS[cfg.embedModel];
  const inTokens = texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
  let r;
  try {
    r = await env.AI.run(cfg.embedModel, { text: texts }, gatewayOpts(env));
  } catch (err) {
    throw new AIError(errText(err).slice(0, 300), isQuotaError(err));
  }
  const data = r?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new AIError("embedding response had the wrong shape", false);
  const used = r?.usage?.prompt_tokens;
  return { vectors: data, neurons: embedNeurons(rates, Number.isFinite(used) ? used : inTokens) };
}

/**
 * One generation. No tools are ever passed: the model can only produce text.
 * @returns {Promise<{ text: string, neurons: number }>}
 */
export async function generate(env, cfg, messages, maxTokens, estInTokens) {
  const rates = MODELS[cfg.model];
  let r;
  try {
    r = await env.AI.run(cfg.model, { messages, max_tokens: maxTokens, temperature: cfg.answer.temperature }, gatewayOpts(env));
  } catch (err) {
    throw new AIError(errText(err).slice(0, 300), isQuotaError(err));
  }
  const text = typeof r?.response === "string" ? r.response : (r?.choices?.[0]?.message?.content ?? "");
  const u = r?.usage ?? {};
  const inT = Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : estInTokens;
  const outT = Number.isFinite(u.completion_tokens) ? Math.min(u.completion_tokens, maxTokens) : maxTokens;
  return { text: String(text), neurons: genNeurons(rates, inT, outT) };
}

/** Vectorize top-K ids and scores (no metadata needed: text and links come from D1). */
export async function vectorQuery(env, vector, topK) {
  const r = await env.VECTORIZE.query(vector, { topK, returnValues: false, returnMetadata: "none" });
  return (r?.matches ?? []).map((m) => ({ id: String(m.id), score: Number(m.score) || 0 }));
}
