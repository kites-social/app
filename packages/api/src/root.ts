import { gifsRouter } from "./router/gifs";
import { marketsRouter } from "./router/markets";
import { tradesRouter } from "./router/trades";
import { translateRouter } from "./router/translate";
import { walletRouter } from "./router/wallet";
import { createTRPCRouter } from "./trpc";

export const appRouter = createTRPCRouter({
  translate: translateRouter,
  gifs: gifsRouter,
  wallet: walletRouter,
  markets: marketsRouter,
  trades: tradesRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
