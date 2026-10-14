import baseConfig from "@kites-social/eslint-config/base";
import nextjsConfig from "@kites-social/eslint-config/nextjs";
import reactConfig from "@kites-social/eslint-config/react";

export default [
  {
    ignores: [".next/**"],
  },
  ...baseConfig,
  ...reactConfig,
  ...nextjsConfig,
];
