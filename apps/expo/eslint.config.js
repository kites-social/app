import baseConfig from "@kites-social/eslint-config/base";
import reactConfig from "@kites-social/eslint-config/react";

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: [
      ".expo/**",
      "expo-plugins/**",
      "ios",
      "android",
      "Kites.app",
      "OpenInKitesExtension",
    ],
  },
  ...baseConfig,
  ...reactConfig,
];
