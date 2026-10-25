/** Rough per-million-token USD rates. Editable placeholders, not billing data: override with ORCA_RATES. */
export type Rates = Record<string, { inPerM: number; outPerM: number }>;

export const DEFAULT_RATES: Rates = {
  'claude-code': { inPerM: 3, outPerM: 15 },
  codex: { inPerM: 1.25, outPerM: 10 },
  opencode: { inPerM: 3, outPerM: 15 },
  aider: { inPerM: 3, outPerM: 15 },
  goose: { inPerM: 3, outPerM: 15 },
};

export function loadRates(env: string | undefined = process.env.ORCA_RATES): Rates {
  if (!env) return DEFAULT_RATES;
  try { return { ...DEFAULT_RATES, ...JSON.parse(env) }; } catch { return DEFAULT_RATES; }
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Estimate from what Orca can see: the prompt sent and the output printed (about 4 chars per token).
 * It cannot see files the agent read or hidden reasoning, so treat it as a lower bound.
 */
export function estimateCost(agent: string, prompt: string, output: string, rates: Rates = DEFAULT_RATES) {
  const r = rates[agent] ?? { inPerM: 0, outPerM: 0 };
  const inTokens = estimateTokens(prompt);
  const outTokens = estimateTokens(output);
  const usd = (inTokens * r.inPerM + outTokens * r.outPerM) / 1_000_000;
  return { inTokens, outTokens, usd };
}

export const formatUsd = (n: number) => (n < 0.01 ? `<$0.01` : `$${n.toFixed(2)}`);
