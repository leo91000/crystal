import { createNodePostgresAdapter } from "@graphile/pg-adapters/node-postgres";
import { createPostgresJsAdapter } from "@graphile/pg-adapters/postgres";
import { createPGLiteAdapter } from "@graphile/pg-adapters/pglite";
import type { PgPool } from "@graphile/pg-adapters";

import type {
  PgServiceConfig,
  NodePostgresPgServiceConfig,
  PostgresJsPgServiceConfig,
  PGLitePgServiceConfig,
} from "./config.js";
import { isNodePostgresConfig, isPostgresJsConfig, isPGLiteConfig } from "./config.js";
import { PgSubscriber } from "./pgSubscriber.js";
import type { PgClient } from "./executor.js";

export function makePgService(
  config: PgServiceConfig
): GraphileConfig.PgServiceConfiguration {
  const {
    name = "main",
    schemas,
    withPgClientKey = name === "main" ? "withPgClient" : `${name}_withPgClient`,
    pgSettingsKey = name === "main" ? "pgSettings" : `${name}_pgSettings`,
    pgSubscriberKey = name === "main" ? "pgSubscriber" : `${name}_pgSubscriber`,
    pubsub = true,
    pgSettings,
    pgSettingsForIntrospection,
  } = config;

  if (pgSettings !== undefined && typeof pgSettingsKey !== "string") {
    throw new Error(
      `makePgService called with pgSettings but no pgSettingsKey - please indicate where the settings should be stored, e.g. 'pgSettingsKey: "pgSettings"' (must be unique across sources)`
    );
  }

  const releasers: (() => void | PromiseLike<void>)[] = [];
  let pgPool: PgPool<PgClient>;
  let superuserPgPool: PgPool<PgClient> | undefined;

  if (isNodePostgresConfig(config)) {
    const { pool, poolConfig, connectionString, superuserPool, superuserPoolConfig, superuserConnectionString } = config;
    
    pgPool = createNodePostgresAdapter({
      pool,
      poolConfig,
      connectionString,
      maxConnections: poolConfig?.max,
    });
    releasers.push(() => pgPool.release?.());

    if (superuserPool || superuserConnectionString) {
      superuserPgPool = createNodePostgresAdapter({
        pool: superuserPool,
        poolConfig: superuserPoolConfig,
        connectionString: superuserConnectionString,
        maxConnections: superuserPoolConfig?.max,
      });
      releasers.push(() => superuserPgPool!.release?.());
    }
  } else if (isPostgresJsConfig(config)) {
    const { sql, connectionString, maxConnections, connectionTimeoutSeconds, postgresOptions } = config;
    
    pgPool = createPostgresJsAdapter({
      sql,
      connectionString,
      maxConnections,
      connectionTimeoutSeconds,
      postgresOptions,
    });
    releasers.push(() => pgPool.release?.());
  } else if (isPGLiteConfig(config)) {
    const { pglite, dataDir } = config;
    
    pgPool = createPGLiteAdapter({
      pglite,
      dataDir,
    });
    releasers.push(() => pgPool.release?.());
  } else {
    throw new Error(`Unknown adapter type in config: ${JSON.stringify(config)}`);
  }

  let pgSubscriber: PgSubscriber | null = null;
  if (pubsub && pgPool.listen) {
    pgSubscriber = new PgSubscriber(pgPool);
    releasers.push(() => pgSubscriber!.release?.());
  }

  const service: GraphileConfig.PgServiceConfiguration = {
    name,
    schemas: Array.isArray(schemas) ? schemas : [schemas ?? "public"],
    withPgClientKey: withPgClientKey as any,
    pgSettingsKey: pgSettingsKey as any,
    pgSubscriberKey: pgSubscriberKey as any,
    pgSettings,
    pgSettingsForIntrospection,
    pgSubscriber,
    pgPool,
    superuserPgPool,
    async release() {
      for (const releaser of [...releasers].reverse()) {
        await releaser();
      }
    },
  };

  return service;
}