import {
  type Address,
  type Hex,
  type TypedData,
  type TypedDataDefinition,
} from "viem";

export type MarketType = "prediction" | "spot" | "perpetual";

export interface Venue {
  id: string;
  name: string;
  marketType: MarketType;
  supportedMarketTypes?: MarketType[];
  onboarding?: VenueOnboardingProvider;
}

export type VenueOnboardingStatus =
  | "action-required"
  | "blocked"
  | "complete"
  | "waiting";

export type VenueOnboardingStepKind = "action" | "deposit" | "information";

export interface VenueOnboardingDetail {
  label: string;
  value: string;
  copyable?: boolean;
}

export interface VenueOnboardingStep {
  id: string;
  title: string;
  description: string;
  kind: VenueOnboardingStepKind;
  status: VenueOnboardingStatus;
  chainId?: number;
  chainName?: string;
  actionLabel?: string;
  details?: VenueOnboardingDetail[];
}

export interface VenueOnboardingActionResult {
  details?: VenueOnboardingDetail[];
  message?: string;
}

export interface VenueOnboardingTransaction {
  chainId: number;
  hash: Hex;
  kind: "approval" | "funding";
  status: "pending" | "submitted" | "confirmed" | "failed";
  title: string;
  detail: string;
}

export interface VenueOnboardingContext {
  walletAddress?: Address;
  depositWalletAddress?: Address;
  signTypedData?: (request: TypedDataDefinition<TypedData>) => Promise<Hex>;
  sendTransaction?: (
    chainId: number,
    transaction: {
      to: Address;
      data: Hex;
      value?: bigint;
    },
  ) => Promise<Hex>;
  onTransaction?: (transaction: VenueOnboardingTransaction) => void;
}

export interface VenueOnboardingProvider {
  getSteps: (context: VenueOnboardingContext) => Promise<VenueOnboardingStep[]>;
  runStep: (
    stepId: string,
    context: VenueOnboardingContext,
  ) => Promise<VenueOnboardingActionResult | void>;
}

export interface PredictionMarketReference {
  marketType: "prediction";
  venue: string;
  url: string;
  marketId: string;
  subMarketId?: string;
}

export interface SpotMarketReference {
  marketType: "spot";
  venue: string;
  url: string;
  marketId: string;
}

export interface PerpetualMarketReference {
  marketType: "perpetual";
  venue: string;
  url: string;
  marketId: string;
}

export type VenueMarketReference =
  | PredictionMarketReference
  | SpotMarketReference
  | PerpetualMarketReference;

export interface PredictionMarketSnapshot {
  slug: string;
  question: string;
  yesVenueSlug?: string;
  noVenueSlug?: string;
  positionSystem?: "ctf" | "protocol-v2";
  imageUrl?: string;
  yesProbability: number | null;
  noProbability: number | null;
  yesAssetId?: string;
  noAssetId?: string;
  isClosed: boolean;
  isResolved: boolean;
  winningOutcome: "yes" | "no" | "void" | null;
}

export interface PredictionEventSnapshot {
  title: string;
  imageUrl?: string;
  hasResolvedMarkets?: boolean;
  markets: PredictionMarketSnapshot[];
}

export interface PredictionTradeIntent {
  eventId: string;
  marketId: string;
  outcome: "yes" | "no";
  side: "buy" | "sell";
  amount: string;
}

export interface PredictionMarketVenue extends Venue {
  marketType: "prediction";
  fetchEvent: (eventId: string) => Promise<PredictionEventSnapshot>;
  executeTrade?: (intent: PredictionTradeIntent) => Promise<void>;
  subscribeToEvent?: (
    eventId: string,
    onUpdate: (event: PredictionEventSnapshot) => void,
    onError?: (error: Error) => void,
    marketSlug?: string,
  ) => () => void;
}

export interface SpotAssetSnapshot {
  symbol: string;
  name: string;
  price: number | null;
  priceChange24h?: number | null;
}

export interface SpotSwapIntent {
  symbol: string;
  side: "buy" | "sell";
  amount: string;
}

export interface SpotMarketVenue extends Venue {
  marketType: "spot";
  fetchAsset: (symbol: string) => Promise<SpotAssetSnapshot | null>;
  executeSwap?: (intent: SpotSwapIntent) => Promise<void>;
  subscribeToAsset?: (
    symbol: string,
    onUpdate: (asset: SpotAssetSnapshot) => void,
  ) => () => void;
}

export interface PerpetualMarketSnapshot {
  symbol: string;
  name: string;
  price: number | null;
  markPrice?: number | null;
  priceChange24h?: number | null;
}

export interface PerpetualTradeIntent {
  symbol: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  amount: string;
  leverage?: number;
}

export interface PerpetualMarketVenue extends Venue {
  marketType: "perpetual";
  fetchMarket: (symbol: string) => Promise<PerpetualMarketSnapshot | null>;
  executeTrade?: (intent: PerpetualTradeIntent) => Promise<void>;
  subscribeToMarket?: (
    symbol: string,
    onUpdate: (market: PerpetualMarketSnapshot) => void,
  ) => () => void;
}
