import { existsSync } from "node:fs";

// eslint-disable-next-line import/consistent-type-specifier-style -- EAS can't understand this (???)
import type { ConfigContext, ExpoConfig } from "@expo/config";
import dotenv from "dotenv";

import { version } from "./package.json";

// for development
dotenv.config({
  path: "../../.env",
});

// WebAuthn relying party for the passkey-custodied wallet. Must be a host the
// project controls and must match the web app's relying party.
const walletRpId = process.env.EXPO_PUBLIC_WALLET_RP_ID?.trim();
// In dev-client builds, `mode=developer` makes iOS fetch the association file
// directly instead of waiting on Apple's CDN cache. Production builds must omit
// it, so it is gated on the same flag used for dev-client builds.
const walletAssociatedDomain =
  walletRpId &&
  `webcredentials:${walletRpId}${
    process.env.DEV_CLIENT === "true" ? "?mode=developer" : ""
  }`;

// Firebase config is gitignored and environment-specific. Only wire it in when
// the file actually exists so prebuild works without FCM/push configured.
const configuredGoogleServicesFile =
  process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json";
const googleServicesFile = existsSync(configuredGoogleServicesFile)
  ? configuredGoogleServicesFile
  : undefined;

const defineConfig = (_: ConfigContext): ExpoConfig => ({
  name: "Kites",
  slug: "kites",
  scheme: "kites",
  version,
  owner: process.env.OWNER ?? "mozzius",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  splash: {
    image: "./assets/adaptive-icon.png",
    resizeMode: "contain",
    backgroundColor: "#101512",
  },
  updates: {
    fallbackToCacheTimeout: 0,
    url: "https://u.expo.dev/7e8ff69c-ba23-4bd8-98ce-7b61b05766c4",
  },
  runtimeVersion: {
    policy: "appVersion",
  },
  assetBundlePatterns: ["**/*"],
  ios: {
    icon: "./assets/icon.png",
    supportsTablet: true,
    bundleIdentifier: process.env.APP_ID ?? "social.kites.app",
    ...(walletAssociatedDomain
      ? { associatedDomains: [walletAssociatedDomain] }
      : {}),
    config: {
      usesNonExemptEncryption: false,
    },
    infoPlist: {
      // should be true but dev client builds don't like this
      UIViewControllerBasedStatusBarAppearance:
        process.env.DEV_CLIENT === "true" ? false : true,
      CADisableMinimumFrameDurationOnPhone: true,
      UIBackgroundModes: ["remote-notification"],
      // UIDesignRequiresCompatibility: true,
    },
  },
  android: {
    package: process.env.APP_ID ?? "social.kites.app",
    softwareKeyboardLayoutMode: "pan",
    ...(googleServicesFile ? { googleServicesFile } : {}),
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#101512",
      monochromeImage: "./assets/monochrome-icon.png",
    },
  },
  extra: {
    eas: {
      projectId:
        process.env.EAS_PROJECT_ID ?? "7e8ff69c-ba23-4bd8-98ce-7b61b05766c4",
    },
    revenueCat: {
      ios: process.env.REVENUECAT_API_KEY_IOS,
      android: process.env.REVENUECAT_API_KEY_ANDROID,
    },
    sentry: process.env.KITES_SENTRY_DSN,
    serviceDid: process.env.KITES_SERVICE_DID,
    devEvmAccount: process.env.EXPO_PUBLIC_DEV_EVM_ACCOUNT,
    walletRpId,
    devClient: process.env.DEV_CLIENT === "true",
    kitesDev: process.env.EXPO_KITES_DEV === "true",
  },
  experiments: {
    tsconfigPaths: true,
    typedRoutes: false, // too much string interpolation :(
    reactCompiler: true,
  },
  plugins: [
    "./plugins/withStaticPods.js",
    [
      "react-native-edge-to-edge",
      {
        android: {
          parentTheme: "Material3",
        },
      },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: "15.1",
          useFrameworks: "static",
        },
      },
    ],
    "expo-localization",
    "expo-secure-store",
    "expo-router",
    "@react-native-community/datetimepicker",
    [
      "expo-media-library",
      {
        savePhotosPermission:
          "This app accesses your photos to let you save images to your device.",
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission:
          "This app accesses your photos to let you add images to your posts.",
        cameraPermission:
          "This app accesses your camera to let you add photos from your camera to your posts.",
      },
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/icon-notification.png",
        color: "#333333",
      },
    ],
    [
      "expo-quick-actions",
      {
        androidIcons: {
          shortcut_search: {
            foregroundImage: "./assets/adaptive/search_icon.png",
            backgroundColor: "#121212",
          },
          shortcut_compose: {
            foregroundImage: "./assets/adaptive/compose_icon.png",
            backgroundColor: "#121212",
          },
          shortcut_settings: {
            foregroundImage: "./assets/adaptive/settings_icon.png",
            backgroundColor: "#121212",
          },
          shortcut_about: {
            foregroundImage: "./assets/adaptive/info_icon.png",
            backgroundColor: "#121212",
          },
        },
        iosActions: [
          {
            id: "search",
            title: "Search",
            icon: "search",
            params: { href: "/search" },
          },
          {
            id: "new-post",
            title: "New Post",
            icon: "compose",
            params: { href: "/composer" },
          },
          {
            id: "settings",
            title: "Settings",
            icon: "symbol:gearshape",
            params: { href: "/settings" },
          },
          {
            id: "about",
            title: "About",
            icon: "symbol:info.circle",
            params: { href: "/settings/about" },
          },
        ],
      },
    ],
    ["react-native-safari-extension", { folderName: "OpenInKitesExtension" }],
  ],
});

export default defineConfig;
