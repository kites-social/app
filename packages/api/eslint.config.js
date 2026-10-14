import baseConfig from "@kites-social/eslint-config/base";

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: ["dist/**"],
  },
  ...baseConfig,
  {
    rules: {
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
];
