// Shared bits for the crawlers that call Anthropic: which model they use, and
// a per-run usage/cost record so spend is visible per function instead of
// only as one lump on the Anthropic bill.

// Haiku 4.5 by default - the crawlers only extract structured rows from search
// results, and it is half Sonnet 5's per-token price. Set the CRAWLER_MODEL
// secret (e.g. to claude-sonnet-5) to roll back without a redeploy.
const DEFAULT_MODEL = 'claude-haiku-4-5';

export function crawlerModel(): string {
  return Deno.env.get('CRAWLER_MODEL') || DEFAULT_MODEL;
}

// $ per million tokens (input, output), and $ per web search.
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5': [2, 10],
};
const PRICE_PER_SEARCH = 0.01;

// Adds one response's usage to debug.usage and logs it. Never throws - usage
// logging must not be able to fail a crawl.
export function noteUsage(fn: string, debug: Record<string, unknown>, result: any): void {
  try {
    const u = result?.usage ?? {};
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const output = u.output_tokens ?? 0;
    const searches = u.server_tool_use?.web_search_requests ?? 0;
    const fetches = u.server_tool_use?.web_fetch_requests ?? 0;
    const model = result?.model ?? crawlerModel();
    const [inPrice, outPrice] = PRICES[model] ?? PRICES[DEFAULT_MODEL];
    const usd = (input * inPrice + output * outPrice) / 1e6 + searches * PRICE_PER_SEARCH;

    const prev = (debug.usage as any) ?? { calls: 0, input_tokens: 0, output_tokens: 0, web_searches: 0, web_fetches: 0, est_usd: 0 };
    debug.usage = {
      model,
      calls: prev.calls + 1,
      input_tokens: prev.input_tokens + input,
      output_tokens: prev.output_tokens + output,
      web_searches: prev.web_searches + searches,
      web_fetches: prev.web_fetches + fetches,
      est_usd: Math.round((prev.est_usd + usd) * 10000) / 10000,
    };
    console.log('anthropic_usage', JSON.stringify({ fn, ...(debug.usage as object), stop_reason: result?.stop_reason }));
  } catch (err) {
    console.error('noteUsage failed:', err);
  }
}
