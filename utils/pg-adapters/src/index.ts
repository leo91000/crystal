/**
 * @graphile/pg-adapters - PostgreSQL adapters for Graphile projects
 *
 * This package provides database-agnostic PostgreSQL adapters that can be used
 * across different Graphile projects like PostGraphile and graphile-worker.
 */

// Export core interfaces
export type {
  PgClient,
  PgClientQuery,
  PgClientResult,
  PgPool,
  PgAdapterFactory,
  ExtractPgClient,
  ExtractAdapterConfig,
} from "./interfaces.js";

// Note: Adapter implementations are available via subpath imports only:
// - @graphile/pg-adapters/node-postgres
// - @graphile/pg-adapters/postgres
// - @graphile/pg-adapters/pglite
//
// This ensures tree-shaking works properly and optional dependencies
// are only loaded when the specific adapter is imported.
