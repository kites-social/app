import { Effect } from "effect";

const program = Effect.gen(function* () {
  yield* Effect.logInfo("Starting market bot");

  const { run } = yield* Effect.tryPromise({
    try: () => import("./worker"),
    catch: (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return error.message.includes("did not initialize yet")
        ? new Error("Prisma Client is missing. Run `pnpm db:generate` first.", {
            cause: error,
          })
        : error;
    },
  });

  yield* run;
});

Effect.runPromise(program).catch((error: unknown) => {
  console.error("Market bot exited", error);
  process.exitCode = 1;
});
