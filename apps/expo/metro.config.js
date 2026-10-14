// Learn more: https://docs.expo.dev/guides/monorepos/
// const { getDefaultConfig } = require("@expo/metro-config"); // replaced by:
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

// Create the default Metro config
const config = getSentryExpoConfig(projectRoot);

if (config.resolver) {
  // 1. Watch all files within the monorepo
  config.watchFolders = [workspaceRoot];
  // 2. Let Metro know where to resolve packages and in what order
  config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, "node_modules"),
    path.resolve(workspaceRoot, "node_modules"),
  ];
  // 3. Force Metro to resolve (sub)dependencies only from the `nodeModulesPaths`
  config.resolver.disableHierarchicalLookup = true;

  config.resolver.unstable_enablePackageExports = true;

  // Mera ships as ESM with only an `exports` map (no `main`/`react-native`),
  // and it is imported through subpaths. Keep its entry points explicit for
  // the Expo/RN bundler.
  const meraRoot = path.resolve(
    workspaceRoot,
    "node_modules/@category-labs/mera/dist",
  );
  const meraEntries = {
    "@category-labs/mera": path.join(meraRoot, "index.js"),
    "@category-labs/mera/viem": path.join(meraRoot, "viem.js"),
    "@category-labs/mera/react-native-webauthn-client": path.join(
      meraRoot,
      "react-native-webauthn-client.js",
    ),
  };
  // Keep the Lingui provider and Trans on the same runtime context when
  // package exports select different ESM/CJS entry points through dependencies.
  const linguiEntries = {
    "@lingui/react": path.resolve(
      workspaceRoot,
      "node_modules/@lingui/react/dist/index.mjs",
    ),
    "@lingui/core": path.resolve(
      workspaceRoot,
      "node_modules/@lingui/core/dist/index.mjs",
    ),
  };
  const defaultResolveRequest = config.resolver.resolveRequest;
  // Mera pins @noble/curves/@noble/hashes/@scure/base to 2.x, while viem pins
  // 1.x and pnpm hoists that to the workspace root. Redirect imports that
  // originate inside Mera to its own nested copies, so it gets the 2.x API
  // (e.g. `sign(..., { format: "recovered" })` returning bytes) instead of
  // viem's 1.x.
  const meraPackageRoot = path.resolve(
    workspaceRoot,
    "node_modules/@category-labs/mera",
  );
  const meraLocalNodeModules = path.join(meraPackageRoot, "node_modules");
  const MERA_LOCAL_DEPS = ["@noble/curves", "@noble/hashes", "@scure/base"];
  const isMeraDependency = (name) =>
    MERA_LOCAL_DEPS.some((dep) => name === dep || name.startsWith(`${dep}/`));
  const isInsideMera = (origin) =>
    typeof origin === "string" &&
    origin.includes(`${path.sep}@category-labs${path.sep}mera${path.sep}`);
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const mapped = meraEntries[moduleName] ?? linguiEntries[moduleName];
    if (mapped) {
      return context.resolveRequest(context, mapped, platform);
    }
    if (isInsideMera(context.originModulePath) && isMeraDependency(moduleName)) {
      return context.resolveRequest(
        context,
        path.join(meraLocalNodeModules, moduleName),
        platform,
      );
    }
    return defaultResolveRequest
      ? defaultResolveRequest(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };
}

// inline requires for better performance
config.transformer.getTransformOptions = async () => ({
  transform: {
    inlineRequires: true,
  },
});

module.exports = config;
