import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const enginePaths = [
  process.env.PRISMA_SCHEMA_ENGINE_BINARY,
  process.env.PRISMA_QUERY_ENGINE_LIBRARY,
].filter((path) => path !== undefined);

const missingPaths = enginePaths.filter((path) => !existsSync(path));
if (missingPaths.length > 0) {
  const require = createRequire(import.meta.url);
  const enginesPackage = require.resolve("@prisma/engines/package.json");
  const postinstall = join(dirname(enginesPackage), "scripts/postinstall.js");
  const downloadEnv = { ...process.env };
  delete downloadEnv.PRISMA_SCHEMA_ENGINE_BINARY;
  delete downloadEnv.PRISMA_QUERY_ENGINE_LIBRARY;
  const result = spawnSync(process.execPath, [postinstall], {
    stdio: "inherit",
    env: {
      ...downloadEnv,
      PRISMA_CLI_BINARY_TARGETS:
        process.env.PRISMA_CLI_BINARY_TARGETS ?? "debian-openssl-3.0.x",
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else {
    const stillMissing = enginePaths.filter((path) => !existsSync(path));
    if (stillMissing.length > 0) {
      console.error(
        `Prisma engine download did not create: ${stillMissing.join(", ")}`,
      );
      process.exitCode = 1;
    }
  }
}
