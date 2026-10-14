import { formatUnits } from "viem";

interface FormatTokenAmountOptions {
  maxFractionDigits?: number;
  useGrouping?: boolean;
}

export const formatTokenAmount = (
  amount: bigint,
  decimals: number,
  {
    maxFractionDigits = decimals,
    useGrouping = true,
  }: FormatTokenAmountOptions = {},
) =>
  formatDecimalString(
    formatUnits(amount, decimals),
    maxFractionDigits,
    useGrouping,
  );

export const formatUsdAmount = (
  amount: bigint,
  decimals: number,
  options?: FormatTokenAmountOptions,
) => `$${formatTokenAmount(amount, decimals, options)}`;

const formatDecimalString = (
  value: string,
  maxFractionDigits: number,
  useGrouping: boolean,
) => {
  const [whole = "0", fraction = ""] = value.split(".");
  const negative = whole.startsWith("-");
  const absoluteWhole = negative ? whole.slice(1) : whole;
  const scale = BigInt(10) ** BigInt(maxFractionDigits);
  const paddedFraction = fraction.padEnd(maxFractionDigits + 1, "0");
  const roundedFraction = BigInt(
    paddedFraction.slice(0, maxFractionDigits) || "0",
  );
  const roundsUp = (paddedFraction[maxFractionDigits] ?? "0") >= "5";
  let roundedWhole = BigInt(absoluteWhole || "0");
  let fractionalValue = roundedFraction + (roundsUp ? BigInt(1) : BigInt(0));

  if (fractionalValue >= scale) {
    roundedWhole += BigInt(1);
    fractionalValue -= scale;
  }

  const wholeDigits = roundedWhole.toString();
  const groupedWhole = useGrouping
    ? wholeDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : wholeDigits;
  const isZero = roundedWhole === BigInt(0) && fractionalValue === BigInt(0);
  const signedWhole = negative && !isZero ? `-${groupedWhole}` : groupedWhole;
  const trimmedFraction = fractionalValue
    .toString()
    .padStart(maxFractionDigits, "0")
    .replace(/0+$/, "");

  return trimmedFraction ? `${signedWhole}.${trimmedFraction}` : signedWhole;
};
