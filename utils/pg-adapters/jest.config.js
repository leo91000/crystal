const baseConfig = require("../../jest.config.base.js");

module.exports = {
  ...baseConfig(__dirname),
  displayName: "@graphile/pg-adapters",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  snapshotSerializers: [],
  setupFiles: [],
};
