/**
 * PostgreSQL adapter for the 'postgres' (postgres.js) module with LRU prepared statement management.
 */

import debugFactory from "debug";
import type { Sql } from "postgres";

export type { Sql } from "postgres";

import type {
  ListenError,
  PgAdapterFactory,
  PgClient,
  PgClientQuery,
  PgClientResult,
} from "../interfaces.js";
import {
  createLRUPreparedStatementManager,
  type QueryExecutor,
} from "../lru-prepared-statements.js";

const debug = debugFactory("@graphile/pg-adapters:postgres");

// Dynamic import to avoid requiring 'postgres' when not used
let postgresModule: typeof import("postgres") | null = null;

async function getPostgresModule() {
  if (!postgresModule) {
    try {
      const imported = await import("postgres");
      postgresModule = imported.default || imported;
    } catch (error) {
      throw new Error(
        "The 'postgres' module is required to use the postgres.js adapter. " +
          "Please install it with: npm install postgres",
      );
    }
  }
  return postgresModule;
}

export interface PostgresJsPgClient extends PgClient {
  sql: Sql;
}

export interface PostgresJsAdapterConfig {
  /** PostgreSQL connection string */
  connectionString?: string;
  /** Direct postgres.js Sql instance (alternative to connectionString) */
  sql?: Sql;
  /** Maximum number of connections in the pool */
  maxConnections?: number;
  /** Connection timeout in seconds */
  connectionTimeoutSeconds?: number;
  /** Maximum number of prepared statements (default: 100) */
  maxPreparedStatements?: number;
  /** Force all queries to be queued (useful for testing) */
  alwaysQueue?: boolean;
  /** Additional options to pass to postgres() */
  postgresOptions?: Record<string, any>;
}

// Symbol for client-level queue
const $$clientQueue = Symbol("clientQueue");

interface SqlWithClientQueue extends Sql {
  [$$clientQueue]?: Promise<any> | null;
}

function createPostgresJsPgClient(
  sql: Sql,
  lruManager: ReturnType<typeof createLRUPreparedStatementManager>,
  alwaysQueue: boolean = false,
): PostgresJsPgClient {
  const sqlWithQueue = sql as SqlWithClientQueue;

  // Create executor function for this sql instance
  const executor: QueryExecutor = async (text: string, values?: any[]) => {
    const result = await sql.unsafe(text, values || []);
    return {
      rows: [...result], // Convert postgres.js result to array
      count: result.count,
      rowCount: result.count,
      command: result.command,
    };
  };

  // Helper to add to queue
  async function addToQueue<T>(fn: () => Promise<T>): Promise<T> {
    while (sqlWithQueue[$$clientQueue]) {
      await sqlWithQueue[$$clientQueue];
    }
    return (sqlWithQueue[$$clientQueue] = (async () => {
      try {
        return await fn();
      } finally {
        sqlWithQueue[$$clientQueue] = null;
      }
    })()) as Promise<T>;
  }

  return {
    sql,
    async query<TData>(opts: PgClientQuery): Promise<PgClientResult<TData>> {
      const doQuery = async () => {
        const { text, values = [], name, arrayMode } = opts;

        try {
          return await lruManager.executeQuery<TData>(
            sql, // Use sql instance as client key
            name,
            text,
            values,
            executor,
            arrayMode,
          );
        } catch (error) {
          debug("Query error:", error);
          throw error;
        }
      };

      // Queue if alwaysQueue is set or if there's already a queue
      if (alwaysQueue || sqlWithQueue[$$clientQueue]) {
        return addToQueue(doQuery);
      } else {
        return doQuery();
      }
    },

    async withTransaction<T>(
      callback: (client: PostgresJsPgClient) => Promise<T>,
    ): Promise<T> {
      return (await sql.begin(async (txSql) => {
        const txClient = createPostgresJsPgClient(
          txSql,
          lruManager,
          alwaysQueue,
        );
        return await callback(txClient);
      })) as T;
    },
  };
}

async function createSqlInstance(
  config: PostgresJsAdapterConfig,
): Promise<Sql> {
  const postgres = await getPostgresModule();

  if (config.sql) {
    return config.sql;
  }

  if (!config.connectionString) {
    throw new Error(
      "Either 'connectionString' or 'sql' must be provided for postgres.js adapter",
    );
  }

  const options = {
    max: config.maxConnections,
    connect_timeout: config.connectionTimeoutSeconds,
    // Disable postgres.js prepared statements since we manage our own
    prepare: false,
    ...config.postgresOptions,
  };

  return postgres(config.connectionString, options);
}

// Symbol for storing the queue promise
const $$queue = Symbol("queue");

// Extend the Sql type to include our queue
interface SqlWithQueue extends Sql {
  [$$queue]?: Promise<any> | null;
}

/**
 * Creates a PostgreSQL adapter using the 'postgres' (postgres.js) module with LRU prepared statement management.
 */
export const createPostgresJsAdapter: PgAdapterFactory<
  PostgresJsAdapterConfig,
  PostgresJsPgClient
> = (config: PostgresJsAdapterConfig) => {
  const maxPreparedStatements = config.maxPreparedStatements || 100;
  const lruManager = createLRUPreparedStatementManager(
    maxPreparedStatements,
    "postgres",
  );

  let sql: SqlWithQueue | null = null;
  let sqlPromise: Promise<SqlWithQueue> | null = null;

  const getSql = async (): Promise<SqlWithQueue> => {
    if (sql) return sql;
    if (sqlPromise) return sqlPromise;

    sqlPromise = createSqlInstance(config) as Promise<SqlWithQueue>;
    sql = await sqlPromise;
    sqlPromise = null;
    return sql;
  };

  return {
    async withPgClient<T>(
      pgSettings: Record<string, string | undefined> | null,
      callback: (client: PostgresJsPgClient) => T | Promise<T>,
    ): Promise<T> {
      const sqlInstance = await getSql();

      // Wait for any pending operations to complete
      while (sqlInstance[$$queue]) {
        await sqlInstance[$$queue];
      }

      // Apply pgSettings if provided
      if (pgSettings && Object.keys(pgSettings).length > 0) {
        return (sqlInstance[$$queue] = (async () => {
          try {
            return (await sqlInstance.begin(async (txSql) => {
              // Set session variables using a single query
              const pgSettingsEntries: Array<[string, string]> = [];
              for (const [key, value] of Object.entries(pgSettings)) {
                if (value != null) {
                  pgSettingsEntries.push([key, String(value)]);
                }
              }

              if (pgSettingsEntries.length > 0) {
                await txSql.unsafe(
                  "SELECT set_config(el->>0, el->>1, true) FROM json_array_elements($1::json) el",
                  [JSON.stringify(pgSettingsEntries)],
                );
              }

              const client = createPostgresJsPgClient(
                txSql,
                lruManager,
                config.alwaysQueue,
              );
              return await callback(client);
            })) as T;
          } finally {
            sqlInstance[$$queue] = null;
          }
        })()) as Promise<T>;
      } else {
        const client = createPostgresJsPgClient(
          sqlInstance,
          lruManager,
          config.alwaysQueue,
        );
        return await callback(client);
      }
    },

    async listen(
      channel: string,
      onnotify: (payload: string | null) => void,
      onError?: (error: ListenError) => void,
    ): Promise<{ unlisten: () => Promise<void> }> {
      const sqlInstance = await getSql();
      let isListening = true;
      let listenConnection: any = null;

      try {
        // postgres.js listen returns a promise that resolves with connection info
        listenConnection = await sqlInstance.listen(
          channel,
          (payload: string) => {
            if (isListening) {
              onnotify(payload || null);
            }
          },
          () => {
            // This callback is called when the connection is ready
            debug(`Listening on channel "${channel}"`);
          },
        );

        // Return unlisten function
        return {
          unlisten: async () => {
            isListening = false;
            if (listenConnection) {
              try {
                // postgres.js v3+ uses connection.unlisten()
                if (typeof listenConnection.unlisten === "function") {
                  await listenConnection.unlisten();
                } else if (typeof listenConnection === "function") {
                  // postgres.js v2 returns the unlisten function directly
                  await listenConnection();
                }
              } catch (err: any) {
                debug(`Error during unlisten: ${err.message}`);
              }
            }
          },
        };
      } catch (err: any) {
        const listenError: ListenError = Object.assign(
          new Error(`Failed to LISTEN on channel "${channel}": ${err.message}`),
          {
            channel,
            originalError: err,
          },
        );

        if (onError) {
          onError(listenError);
        }

        throw listenError;
      }
    },

    getPoolSize() {
      // Return the maximum pool size from configuration
      return config.maxConnections ?? config.postgresOptions?.max ?? 10; // postgres.js default is 10
    },

    async release() {
      if (sql) {
        // Wait for any pending operations to complete
        while (sql[$$queue]) {
          await sql[$$queue];
        }

        // Clean up all prepared statements before closing
        const executor: QueryExecutor = async (
          text: string,
          values?: any[],
        ) => {
          const result = await sql!.unsafe(text, values || []);
          return {
            rows: [...result],
            count: result.count,
            rowCount: result.count,
            command: result.command,
          };
        };
        await lruManager.cleanupConnection(sql, executor);
      }

      if (sql && !config.sql) {
        // Only end the connection if we created it
        await sql.end();
        sql = null;
      }
    },
  };
};
