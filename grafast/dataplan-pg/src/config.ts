import type { Pool, PoolConfig } from "pg";
import type { Sql } from "postgres";
import type { PGlite } from "@electric-sql/pglite";

export interface BasePgServiceConfig {
  name?: string;
  schemas?: string | string[];
  pgSettingsKey?: string;
  withPgClientKey?: string;
  pgSubscriberKey?: string;
  pubsub?: boolean;
  pgSettings?: Record<string, string | undefined>;
  pgSettingsForIntrospection?: Record<string, string | undefined>;
}

export interface NodePostgresPgServiceConfig extends BasePgServiceConfig {
  adapter?: "node-postgres";
  connectionString?: string;
  pool?: Pool;
  poolConfig?: Omit<PoolConfig, "connectionString">;
  superuserConnectionString?: string;
  superuserPool?: Pool;
  superuserPoolConfig?: Omit<PoolConfig, "connectionString">;
}

export interface PostgresJsPgServiceConfig extends BasePgServiceConfig {
  adapter: "postgres.js";
  connectionString?: string;
  sql?: Sql;
  maxConnections?: number;
  connectionTimeoutSeconds?: number;
  postgresOptions?: Record<string, any>;
}

export interface PGLitePgServiceConfig extends BasePgServiceConfig {
  adapter: "pglite";
  dataDir?: string;
  pglite?: PGlite;
  debug?: boolean;
}

export type PgServiceConfig =
  | NodePostgresPgServiceConfig
  | PostgresJsPgServiceConfig
  | PGLitePgServiceConfig;

export function isNodePostgresConfig(
  config: PgServiceConfig
): config is NodePostgresPgServiceConfig {
  return !config.adapter || config.adapter === "node-postgres";
}

export function isPostgresJsConfig(
  config: PgServiceConfig
): config is PostgresJsPgServiceConfig {
  return config.adapter === "postgres.js";
}

export function isPGLiteConfig(
  config: PgServiceConfig
): config is PGLitePgServiceConfig {
  return config.adapter === "pglite";
}