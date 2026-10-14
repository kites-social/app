import { type MarketBotAdapter } from "../types";
import { hyperliquidOutcomesBot } from "./hyperliquid-outcomes";
import { hyperliquidPerpsBot } from "./hyperliquid-perps";
import { perplBot } from "./perpl";
import { polymarketBot } from "./polymarket";

export const marketBots: readonly MarketBotAdapter[] = [
  polymarketBot,
  hyperliquidOutcomesBot,
  hyperliquidPerpsBot,
  perplBot,
];
