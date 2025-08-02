import "graphile-config";
import "../../src/index.js";

import { createWithPgClient } from "@dataplan/pg";

export const withPgClient = createWithPgClient({
  connectionString: "postgres:///graphilecrystaltest",
});

declare module "../../src/interfaces.js" {
  interface GrafastBenchSetupResult {
    withPgClient: ReturnType<typeof createWithPgClient>;
  }
}

const preset: GraphileConfig.Preset = {
  bench: {
    schema: `${__dirname}/../../../dataplan-pg/scripts/exampleSchemaExport.mjs`,
    operations: `${__dirname}/../../../dataplan-pg/__tests__/queries/*/*.test.graphql`,
    // operations: `${__dirname}/../../../dataplan-pg/__tests__/queries/interfaces-relational/nested-more-fragments.test.graphql`,
    setup() {
      const withPgClient = createWithPgClient({
        connectionString: "postgres:///graphilecrystaltest",
      });
      return { withPgClient };
    },
    teardown(setupResult) {
      setupResult.withPgClient.release?.();
    },
    contextFactory(_operation, setupResult) {
      const { withPgClient } = setupResult;
      return {
        withPgClient,
      };
    },
  },
};

export default preset;
