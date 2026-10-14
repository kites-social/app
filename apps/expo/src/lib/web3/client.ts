import { monadTestnet, polygon } from "viem/chains";

import { getAppPublicClient } from "./chains";

export { monadTestnet, polygon };

export const monadTestnetPublicClient = getAppPublicClient(monadTestnet.id);
export const polygonPublicClient = getAppPublicClient(polygon.id);
