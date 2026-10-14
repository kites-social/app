import { MIN_TRADING_DURATION_DAYS } from "~/lib/web3";
import { type MarketProposalDraft } from "./state";

type MarketProposalInput = Pick<
  MarketProposalDraft,
  | "question"
  | "resolutionCriteria"
  | "resolutionDate"
  | "contribution"
  | "yesProbabilityBps"
>;

const SECONDS_PER_DAY = 24 * 60 * 60;
const SECONDS_PER_MINUTE = 60;
const DEFAULT_RESOLUTION_DAYS = 30;
export const DEV_MARKET_MIN_TRADING_DURATION_MINUTES = 3;
export const DEV_MARKET_TRADING_DURATION_MINUTES = 5;

const minimumTradingDurationSeconds = __DEV__
  ? DEV_MARKET_MIN_TRADING_DURATION_MINUTES * SECONDS_PER_MINUTE
  : MIN_TRADING_DURATION_DAYS * SECONDS_PER_DAY;

export const getMinimumResolutionDate = (now = Date.now()) =>
  new Date(now + minimumTradingDurationSeconds * 1_000);

export const getDevelopmentResolutionDate = (now = Date.now()) =>
  new Date(
    now + DEV_MARKET_TRADING_DURATION_MINUTES * SECONDS_PER_MINUTE * 1_000,
  );

export const getDefaultResolutionDate = (now = Date.now()) =>
  new Date(now + DEFAULT_RESOLUTION_DAYS * SECONDS_PER_DAY * 1_000);

export const isResolutionDateValid = (
  resolutionDate: Date,
  now = Date.now(),
) => {
  const resolutionTime = resolutionDate.getTime();
  if (!Number.isFinite(resolutionTime)) return false;

  const resolutionTimestamp = Math.floor(resolutionTime / 1_000);
  const minimumTimestamp =
    Math.floor(now / 1_000) + minimumTradingDurationSeconds;

  return (
    Number.isSafeInteger(resolutionTimestamp) &&
    resolutionTimestamp >= minimumTimestamp
  );
};

export const normalizeMarketContribution = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "0";
  if (trimmed.startsWith(".")) return `0${trimmed}`;
  if (trimmed.endsWith(".")) return trimmed.slice(0, -1) || "0";
  return trimmed;
};

export const isMarketProposalValid = (proposal: MarketProposalInput) => {
  const contribution = normalizeMarketContribution(proposal.contribution);

  return (
    proposal.question.trim().length > 0 &&
    proposal.question.trim().length <= 256 &&
    proposal.resolutionCriteria.trim().length > 0 &&
    proposal.resolutionCriteria.trim().length <= 2_000 &&
    isResolutionDateValid(proposal.resolutionDate) &&
    contribution.length <= 32 &&
    /^\d+(?:\.\d{1,6})?$/.test(contribution) &&
    Number.isInteger(proposal.yesProbabilityBps) &&
    proposal.yesProbabilityBps >= 0 &&
    proposal.yesProbabilityBps <= 10_000
  );
};

export const toCreateMarketInput = (proposal: MarketProposalInput) => {
  if (!isMarketProposalValid(proposal)) {
    throw new Error("Complete the market terms before creating the market.");
  }

  return {
    question: proposal.question.trim(),
    resolutionCriteria: proposal.resolutionCriteria.trim(),
    tradingEnd: Math.floor(proposal.resolutionDate.getTime() / 1_000),
    contribution: normalizeMarketContribution(proposal.contribution),
    yesProbabilityBps: proposal.yesProbabilityBps,
  };
};
