import next from "eslint-config-next";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "data/**",
      "coverage/**",
      ".trellis/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".cursor/**",
      ".pi/**",
    ],
  },
  ...next,
];

export default config;
