export type WindowKey = "m5" | "h1" | "h6" | "h24";

export type Token = {
  id: string;
  chain: string;
  address: string;
  pair: string;
  symbol: string;
  name: string;
  image?: string;
  header?: string;
  price: number;
  change: Record<WindowKey, number>;
  volume: number;
  liquidity: number;
  marketCap: number;
  url: string;
  dex: string;
  created?: number;
  buys24: number;
  sells24: number;
  description?: string;
};

export type Major = { symbol: string; price: number; change: number };

export type RugReport = {
  label: "Good" | "Risky" | "Bad" | "Unknown";
  score: number | null;
  locked: number | null;
  holders: { address: string; pct: number }[];
  totalHolders: number | null;
};

type DexPair = {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  volume?: Partial<Record<WindowKey, number>>;
  priceChange?: Partial<Record<WindowKey, number>>;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; header?: string };
  txns?: { h24?: { buys?: number; sells?: number } };
};

type FeedMeta = {
  chainId?: string;
  tokenAddress?: string;
  description?: string;
  header?: string;
};

const CHAINS = ["solana", "bsc", "base", "ethereum"] as const;

function num(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toToken(pair: DexPair, meta?: FeedMeta): Token | null {
  const price = num(pair.priceUsd);
  if (!pair.baseToken?.address || price <= 0) return null;
  return {
    id: `${pair.chainId}:${pair.baseToken.address}`,
    chain: pair.chainId,
    address: pair.baseToken.address,
    pair: pair.pairAddress,
    symbol: pair.baseToken.symbol || "?",
    name: pair.baseToken.name || pair.baseToken.symbol || "Unknown",
    image: pair.info?.imageUrl,
    header: pair.info?.header || meta?.header,
    price,
    change: {
      m5: num(pair.priceChange?.m5),
      h1: num(pair.priceChange?.h1),
      h6: num(pair.priceChange?.h6),
      h24: num(pair.priceChange?.h24),
    },
    volume: num(pair.volume?.h24),
    liquidity: num(pair.liquidity?.usd),
    marketCap: num(pair.marketCap) || num(pair.fdv),
    url: pair.url,
    dex: pair.dexId,
    created: pair.pairCreatedAt,
    buys24: pair.txns?.h24?.buys ?? 0,
    sells24: pair.txns?.h24?.sells ?? 0,
    description: meta?.description,
  };
}

function bestByToken(pairs: DexPair[]) {
  const map = new Map<string, DexPair>();
  for (const pair of pairs) {
    const address = pair.baseToken?.address;
    if (!address) continue;
    const key = `${pair.chainId}:${address}`;
    const prev = map.get(key);
    if (!prev || num(pair.liquidity?.usd) > num(prev.liquidity?.usd)) map.set(key, pair);
  }
  return [...map.values()];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export async function loadTrending(): Promise<Token[]> {
  const [boosts, profiles] = await Promise.all([
    getJson<FeedMeta[]>("https://api.dexscreener.com/token-boosts/top/v1"),
    getJson<FeedMeta[]>("https://api.dexscreener.com/token-profiles/latest/v1"),
  ]);
  const meta = new Map<string, FeedMeta>();
  for (const item of [...boosts, ...profiles]) {
    if (!item.chainId || !item.tokenAddress) continue;
    const key = `${item.chainId}:${item.tokenAddress}`;
    const prev = meta.get(key);
    meta.set(key, {
      ...prev,
      ...item,
      description: item.description || prev?.description,
      header: item.header || prev?.header,
    });
  }

  const byChain = new Map<string, string[]>();
  for (const item of meta.values()) {
    if (!item.chainId || !item.tokenAddress) continue;
    if (!CHAINS.includes(item.chainId as (typeof CHAINS)[number])) continue;
    const list = byChain.get(item.chainId) ?? [];
    if (!list.includes(item.tokenAddress) && list.length < 30) list.push(item.tokenAddress);
    byChain.set(item.chainId, list);
  }

  const batches = await Promise.all(
    [...byChain.entries()].map(async ([chain, addresses]) => {
      try {
        return await getJson<DexPair[]>(
          `https://api.dexscreener.com/tokens/v1/${chain}/${addresses.join(",")}`,
        );
      } catch {
        return [];
      }
    }),
  );

  const tokens = bestByToken(batches.flat())
    .map((pair) => toToken(pair, meta.get(`${pair.chainId}:${pair.baseToken.address}`)))
    .filter((token): token is Token => token !== null);

  tokens.sort((a, b) => b.volume - a.volume);
  return tokens.slice(0, 48);
}

export async function searchTokens(query: string): Promise<Token[]> {
  const data = await getJson<{ pairs?: DexPair[] }>(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
  );
  return bestByToken(data.pairs ?? [])
    .map((pair) => toToken(pair))
    .filter((token): token is Token => token !== null)
    .slice(0, 8);
}

export async function loadMajors(): Promise<Major[]> {
  const products = [
    ["SOL", "SOL-USD"],
    ["ETH", "ETH-USD"],
    ["BTC", "BTC-USD"],
  ] as const;
  const rows = await Promise.all(
    products.map(async ([symbol, product]) => {
      try {
        const stats = await getJson<{ last?: string; open?: string }>(
          `https://api.exchange.coinbase.com/products/${product}/stats`,
        );
        const price = num(stats.last);
        const open = num(stats.open);
        return { symbol, price, change: open ? ((price - open) / open) * 100 : 0 };
      } catch {
        return { symbol, price: 0, change: 0 };
      }
    }),
  );
  return rows.filter((row) => row.price > 0);
}

export type Perp = {
  symbol: string;
  name: string;
  group: "chain" | "stock";
  price: number;
  change: number;
};

const CHAIN_PERPS = [
  ["BTC", "Bitcoin", "BTC-USD"],
  ["SOL", "Solana", "SOL-USD"],
  ["ETH", "Ethereum", "ETH-USD"],
  ["BNB", "BNB", "BNB-USD"],
] as const;

export async function loadPerps(): Promise<Perp[]> {
  const chains = await Promise.all(
    CHAIN_PERPS.map(async ([symbol, name, product]) => {
      try {
        const stats = await getJson<{ last?: string; open?: string }>(
          `https://api.exchange.coinbase.com/products/${product}/stats`,
        );
        const price = num(stats.last);
        const open = num(stats.open);
        return { symbol, name, group: "chain" as const, price, change: open ? ((price - open) / open) * 100 : 0 };
      } catch {
        return { symbol, name, group: "chain" as const, price: 0, change: 0 };
      }
    }),
  );
  return chains.filter((row) => row.price > 0);
}

export function searchTraders(query: string) {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  if (q.length < 1) return [];
  return TRADERS.filter((person) => person.handle.toLowerCase().includes(q));
}

export async function loadRug(address: string): Promise<RugReport> {
  const empty = { holders: [] as { address: string; pct: number }[], totalHolders: null as number | null };
  try {
    const data = await getJson<{
      score?: number;
      score_normalised?: number;
      totalHolders?: number;
      topHolders?: { address?: string; pct?: number }[];
      markets?: { lp?: { lpLockedPct?: number } }[];
      risks?: { level?: string }[];
    }>(`https://api.rugcheck.xyz/v1/tokens/${address}/report`);
    const score = num(data.score_normalised ?? data.score);
    const danger = (data.risks ?? []).some((risk) => risk.level === "danger" || risk.level === "warn");
    const lockedRaw = data.markets?.find((market) => typeof market.lp?.lpLockedPct === "number")?.lp?.lpLockedPct;
    const locked = typeof lockedRaw === "number" ? lockedRaw : null;
    let label: RugReport["label"] = "Good";
    if (danger || score > 4000 || (data.score_normalised ?? 0) > 60) label = "Bad";
    else if (score > 400 || (locked !== null && locked < 40)) label = "Risky";
    const holders = (data.topHolders ?? [])
      .filter((row) => row.address && typeof row.pct === "number")
      .slice(0, 8)
      .map((row) => ({ address: row.address as string, pct: row.pct as number }));
    return {
      label,
      score: Number.isFinite(score) ? score : null,
      locked,
      holders,
      totalHolders: typeof data.totalHolders === "number" ? data.totalHolders : null,
    };
  } catch {
    return { label: "Unknown", score: null, locked: null, ...empty };
  }
}

export function changeOf(token: Token, windowKey: WindowKey) {
  return token.change[windowKey];
}

export function pathPoints(token: Token, windowKey: WindowKey = "h24") {
  const now = token.price;
  const back = (change: number) => {
    const denom = 1 + change / 100;
    return denom > 0.05 ? now / denom : now;
  };
  const all = [
    { label: "24h", v: back(token.change.h24) },
    { label: "6h", v: back(token.change.h6) },
    { label: "1h", v: back(token.change.h1) },
    { label: "5m", v: back(token.change.m5) },
    { label: "Now", v: now },
  ];
  const start = windowKey === "m5" ? 3 : windowKey === "h1" ? 2 : windowKey === "h6" ? 1 : 0;
  return all.slice(start);
}

export const TRADERS = [
  { handle: "faceofsol", pnl: 531373.41, window: "1W" },
  { handle: "bronbroncore", pnl: 371228.81, window: "1W" },
  { handle: "wirelyss", pnl: 281634.48, window: "1W" },
  { handle: "swaagsol", pnl: 261197.07, window: "1W" },
  { handle: "ansemconzimp", pnl: 230335.04, window: "1W" },
  { handle: "chairman", pnl: 224749.26, window: "1W" },
  { handle: "cefuli", pnl: 213858.03, window: "1W" },
  { handle: "itsbingo", pnl: 191516.82, window: "1W" },
  { handle: "MemeHubCo", pnl: 152321.8, window: "1W" },
  { handle: "chosen_aeon", pnl: 137973.2, window: "1W" },
  { handle: "fxcxc", pnl: 121880.8, window: "24H" },
  { handle: "HimReaper", pnl: 79974.5, window: "24H" },
  { handle: "ansem", pnl: 98420, window: "1W" },
  { handle: "0xMert_", pnl: 74210, window: "1W" },
  { handle: "blknoiz06", pnl: 61840, window: "1W" },
  { handle: "inversebrah", pnl: 55120, window: "1W" },
  { handle: "CryptoGodJohn", pnl: 48990, window: "1W" },
  { handle: "solanafloor", pnl: 41230, window: "1W" },
  { handle: "MustStopMurad", pnl: 38760, window: "1W" },
  { handle: "TheCryptoDog", pnl: 35410, window: "1W" },
  { handle: "HsakaTrades", pnl: 32180, window: "1W" },
  { handle: "DegenSpartan", pnl: 29840, window: "1W" },
  { handle: "cobie", pnl: 27650, window: "1W" },
  { handle: "gainzy222", pnl: 24110, window: "1W" },
  { handle: "CryptoKaleo", pnl: 21870, window: "1W" },
  { handle: "AltcoinGordon", pnl: 19340, window: "1W" },
  { handle: "CryptoWizardd", pnl: 17620, window: "1W" },
  { handle: "solanapoet", pnl: 15480, window: "1W" },
  { handle: "pumpfun", pnl: 0, window: "1W" },
  { handle: "fomofamily", pnl: 0, window: "1W" },
] as const;
