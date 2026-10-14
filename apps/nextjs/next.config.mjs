import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../");

/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation.
 * This is especially useful for Docker builds and Linting.
 */
!process.env.SKIP_ENV_VALIDATION && (await import("./src/env.mjs"));

/** @type {import("next").NextConfig} */
export default {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
  pageExtensions: ["ts", "tsx", "js", "jsx", "md", "mdx"],
  /** Enables hot reloading for local packages without a build step */
  transpilePackages: ["@kites-social/api", "@kites-social/db"],
  /** We already do typechecking as a separate task in CI */
  typescript: { ignoreBuildErrors: !!process.env.CI },
};
