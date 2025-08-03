import fetch from "node-fetch";
import { ContractTag, ITagService } from "atq-types";
// --- constants & types ---
export const PAGE = 1000; // The Graph caps page size at 1000
/**
 * Velodrome v2 subgraph on Optimism
 * Subgraph ID: A4Y1A82YhSLTn998BVVELC8eWzhi992k4ZitByvssxqA
 */
export function endpoint(apiKey?: string): string {
  const subgraphId = "A4Y1A82YhSLTn998BVVELC8eWzhi992k4ZitByvssxqA";
  if (!apiKey || apiKey === "dummy") {
    return `https://gateway.thegraph.com/api/[api-key]/subgraphs/id/${subgraphId}`;
  }
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
}

// --- types ---
interface Token {
  id: string;
  name: string;
  symbol: string;
}

interface Tick {
  tickIdx: string;
}

interface Pool {
  id: string;
  name: string;
  symbol: string;
  createdTimestamp: number;
  inputTokens: Token[];
  fees: { feeType: string; feePercentage: string }[];
} // Adapted to liquidityPools entity

interface GraphQLData {
  liquidityPools: Pool[];
}

interface GraphQLResponse {
  data?: GraphQLData;
  errors?: { message: string }[];
}

// --- query ---
const PAIR_QUERY = `
  query GetPools($lastTimestamp: Int) {
    liquidityPools(
      first: 1000,
      orderBy: createdTimestamp,
      orderDirection: asc,
      where: { createdTimestamp_gt: $lastTimestamp }
    ) {
      id
      name
      symbol
      createdTimestamp
      inputTokens { id name symbol }
      fees { feeType feePercentage }
    }
  }
`;

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
};

function containsHtmlOrMarkdown(text: string): boolean {
  return /<[^>]+>/.test(text);
}

function isError(e: unknown): e is Error {
  return (
    typeof e === "object" &&
    e !== null &&
    "message" in e &&
    typeof (e as Error).message === "string"
  );
}

function truncateString(text: string, maxLength: number) {
  if (text.length > maxLength) {
    return text.substring(0, maxLength - 3) + "...";
  }
  return text;
}

// --- utils ---
/** Decode 32-byte hex (with/without 0x) → printable ASCII, strip junk */
export function cleanSymbol(raw: string): string {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    raw = Buffer.from(hex, "hex")
      .toString("utf8")
      .replace(/\u0000/g, "");
  }
  const txt = raw.replace(/[^\u0002-\u007f]/g, "").trim(); // printable ASCII
  return txt.length >= 2 && txt.length <= 32 ? txt : "";
}
/**
 * Transform pools into ContractTag objects, applying policy and field validation.
 */
// Transform pools into ContractTag objects, applying policy and field validation.
function transformPoolsToTags(chainId: string, pools: Pool[]): ContractTag[] {
  // First, filter and log invalid entries
  const validPools: Pool[] = [];
  const rejectedNames: string[] = [];

  pools.forEach((pool) => {
    if (!pool.inputTokens || pool.inputTokens.length < 2) return;
    const token0 = pool.inputTokens[0];
    const token1 = pool.inputTokens[1];
    const token0Invalid = containsHtmlOrMarkdown(token0.name) || containsHtmlOrMarkdown(token0.symbol);
    const token1Invalid = containsHtmlOrMarkdown(token1.name) || containsHtmlOrMarkdown(token1.symbol);

    if (token0Invalid || token1Invalid) {
      if (token0Invalid) {
        rejectedNames.push(token0.name + ", Symbol: " + token0.symbol);
      }
      if (token1Invalid) {
        rejectedNames.push(token1.name + ", Symbol: " + token1.symbol);
      }
    } else {
      validPools.push(pool);
    }
  });

  // Log all rejected names
  if (rejectedNames.length > 0) {
    console.log(
      "Rejected token names due to HTML/Markdown content:",
      rejectedNames
    );
  }

  // Helper: infer stable/volatile from pool name or tokens
  function inferPoolType(pool: Pool): "stable" | "volatile" {
    const stableSymbols = ["USDC", "USDT", "DAI", "LUSD", "alUSD", "FRAX", "sUSD", "MAI", "TUSD", "USD+", "EUROC", "USDP", "USDbC"];
    if (!pool.inputTokens || pool.inputTokens.length < 2) return "volatile";
    const t0 = pool.inputTokens[0].symbol.toUpperCase();
    const t1 = pool.inputTokens[1].symbol.toUpperCase();
    if (stableSymbols.includes(t0) && stableSymbols.includes(t1)) return "stable";
    return "volatile";
  }
  // Helper: get fee pct string
  function getFeePct(pool: Pool): string {
    const feeObj = pool.fees && pool.fees[0];
    if (!feeObj) return "";
    // If it's a percent (e.g. 0.3), show as 0.3%
    return feeObj.feePercentage.endsWith("%") ? feeObj.feePercentage : (parseFloat(feeObj.feePercentage).toFixed(2) + "%");
  }
  return validPools.map((pool) => {
    const token0 = pool.inputTokens[0];
    const token1 = pool.inputTokens[1];
    const poolType = inferPoolType(pool);
    const tagName = `${pool.symbol} Pool`;
    return {
      "Contract Address": `eip155:${chainId}:${pool.id}`,
      "Public Name Tag": tagName,
      "Project Name": "Velodrome",
      "UI/Website Link": "https://velodrome.finance",
      "Public Note": `The liquidity pool contract on Velodrome v2 for the ${token0.symbol} / ${token1.symbol} pool.`
    };
  });
}


// --- main logic ---
interface GraphResponse<T> {
  data: T;
  errors?: unknown;
}

async function fetchPools(apiKey: string, lastTimestamp: number): Promise<Pool[]> {
  const resp = await fetch(endpoint(apiKey), {
    method: "POST",
    headers,
    body: JSON.stringify({ query: PAIR_QUERY, variables: { lastTimestamp } }),
  });
  if (!resp.ok) {
    throw new Error(`HTTP error: ${resp.status}`);
  }
  const json = (await resp.json()) as GraphQLResponse;
  if (json.errors) {
    json.errors.forEach((error) => {
      console.error(`GraphQL error: ${error.message}`);
    });
    throw new Error("GraphQL errors occurred: see logs for details.");
  }
  if (!json.data || !json.data.liquidityPools) {
    throw new Error("No pools data found.");
  }
  return json.data.liquidityPools;
} 


class TagService implements ITagService {
  returnTags = async (
    chainId: string,
    apiKey: string
  ): Promise<ContractTag[]> => {
    if (Number(chainId) !== 10)
      throw new Error(`Unsupported Chain ID: ${chainId}.`);
    if (!apiKey) throw new Error("API key is required");
    let lastTimestamp: number = 0;
    let allTags: ContractTag[] = [];
    let isMore = true;
    let counter = 0;
    const seenAddr = new Set<string>();
    while (isMore) {
      let pools: Pool[];
      try {
        pools = await fetchPools(apiKey, lastTimestamp);
        const tagsForPools = transformPoolsToTags(chainId, pools).filter(tag => {
          if (seenAddr.has(tag["Contract Address"])) return false;
          seenAddr.add(tag["Contract Address"]);
          return true;
        });
        allTags.push(...tagsForPools);
        counter++;
        console.log(`Retrieved first ${counter * 1000} entries...`);
        isMore = pools.length === 1000;
        if (isMore) {
          lastTimestamp = Number(pools[pools.length - 1].createdTimestamp);
        }
      } catch (error) {
        if (isError(error)) {
          console.error(`An error occurred: ${error.message}`);
          throw new Error(`Failed fetching data: ${error}`);
        } else {
          console.error("An unknown error occurred.");
          throw new Error("An unknown error occurred during fetch operation.");
        }
      }
    }
    return allTags;
  };
}

const tagService = new TagService();
export const returnTags = tagService.returnTags;
