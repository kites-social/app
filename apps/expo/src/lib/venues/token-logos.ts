import { type ImageSourcePropType } from "react-native";

const MON =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../assets/tokens/MON_logo.svg") as ImageSourcePropType;
const AUSD =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../assets/tokens/AUSD_logo.svg") as ImageSourcePropType;
const HYPE =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../assets/tokens/HYPE_logo.png") as ImageSourcePropType;

export const TOKEN_LOGOS: Record<string, ImageSourcePropType> = {
  BTC: {
    uri: "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400",
  },
  ETH: {
    uri: "https://coin-images.coingecko.com/coins/images/279/large/ethereum.png?1696501628",
  },
  LIT: {
    uri: "https://coin-images.coingecko.com/coins/images/71121/large/lighter.png?1765888098",
  },
  NEAR: {
    uri: "https://coin-images.coingecko.com/coins/images/10365/large/near.jpg?1696510367",
  },
  PUMP: {
    uri: "https://coin-images.coingecko.com/coins/images/67164/large/pump.jpg?1751949376",
  },
  SOL: {
    uri: "https://coin-images.coingecko.com/coins/images/4128/large/solana.png?1718769756",
  },
  ZEC: {
    uri: "https://coin-images.coingecko.com/coins/images/486/large/Brandmark-Yellow_%281%29.png?1785810558",
  },
  MON,
  HYPE,
  USDC: {
    uri: "https://coin-images.coingecko.com/coins/images/6319/large/USDC.png?1769615602",
  },
  USDT: {
    uri: "https://coin-images.coingecko.com/coins/images/325/large/Tether.png?1696501661",
  },
  AUSD,
};

export function getTokenLogo(symbol: string) {
  const baseSymbol = symbol
    .trim()
    .toUpperCase()
    .replace(/[-_/](USD|USDT|USDC|PERP|PERPETUAL)$/, "")
    .replace(/[^A-Z0-9]/g, "");
  return TOKEN_LOGOS[baseSymbol];
}
