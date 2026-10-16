import type { SessionLine, Usage } from "./types.ts";

// Capacity belongs to the request that reported it. Never pair a historical
// peak with another model's latest window, or infer occupancy from capacity.
export function codexContext(lines: SessionLine[]) {
  let latest: { tokens: number; window: number | null; model?: string; ts: string } | null = null;
  let peak: typeof latest = null;
  for (const line of lines) {
    if (line.sidechain || line.contextTokens === undefined) continue;
    latest = { tokens: line.contextTokens, window: line.contextWindow ?? null, model: line.model, ts: line.ts };
    if (!peak || latest.tokens > peak.tokens) peak = latest;
  }
  return { latest, peak };
}

export interface CodexRates { input: number; cachedInput: number; output: number }

// Explicit, exact model rates only. Local rollouts cannot tell us subscription
// charges, service-tier prices or whether today's public rate applied then.
export function codexApiEstimate(usageByModel: Record<string, Usage> = {}, raw = process.env.CODEX_API_PRICING_JSON) {
  let configured: Record<string, CodexRates> = {};
  try { configured = JSON.parse(raw ?? "{}"); } catch { /* Unconfigured is unknown, never free. */ }
  const byModel = Object.entries(usageByModel).map(([model, usage]) => {
    const rate = configured && Object.hasOwn(configured, model) ? configured[model] : undefined;
    const valid = rate && [rate.input, rate.cachedInput, rate.output].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0);
    const totalUSD = valid && usage.cacheWrite === 0
      ? (usage.input * rate.input + usage.cacheRead * rate.cachedInput + usage.output * rate.output) / 1e6 : null;
    return { model, usage, totalUSD, rates: valid ? rate : null };
  });
  return {
    label: "API-equivalent estimate", rateSource: "CODEX_API_PRICING_JSON", billing: "unknown",
    totalUSD: byModel.length && byModel.every(m => m.totalUSD !== null)
      ? byModel.reduce((sum, m) => sum + m.totalUSD!, 0) : null,
    knownUSD: byModel.reduce((sum, m) => sum + (m.totalUSD ?? 0), 0),
    byModel,
  };
}
