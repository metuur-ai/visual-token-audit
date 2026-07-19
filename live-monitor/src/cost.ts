// ----------------------------------------------------------------------------
// Cost estimation (v2.3)
// ----------------------------------------------------------------------------
// ----- cost estimation (v2.3) ------------------------------------------------
// USD per 1M tokens. cacheRead = 0.1×input, cacheWrite = 1.25×input (API rules).




import { Usage } from "./types.ts";

export const MODEL_PRICING: Array<{ re: RegExp; input: number; output: number }> = [
  { re: /opus/i, input: 15, output: 75 },
  { re: /sonnet/i, input: 3, output: 15 },
  { re: /haiku/i, input: 1, output: 5 },
  { re: /fable/i, input: 3, output: 15 }, // placeholder until pricing published
];
export const DEFAULT_PRICING = { input: 3, output: 15 };

export function priceFor(model: string): { input: number; output: number } {
  for (const p of MODEL_PRICING) if (p.re.test(model)) return p;
  return DEFAULT_PRICING;
}

export function costUSD(model: string, u: Usage): number {
  const p = priceFor(model);
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.input * 0.1 +
      u.cacheWrite * p.input * 1.25) /
    1e6
  );
}
