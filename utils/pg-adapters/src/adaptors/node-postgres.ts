/**
 * PostgreSQL adapter for the 'pg' (node-postgres) module.
 */

import LRU from "@graphile/lru";
import debugFactory from "debug";
import type {
  Pool,
  PoolClient,
  PoolConfig,
  QueryArrayConfig,
  QueryConfig,
} from "pg";

export type { Pool, PoolConfig } from "pg";

import type {
  ListenError,
  PgAdapterFactory,
  PgClient,
  PgClientQuery,
  PgClientResult,
  PgPool,
} from "../interfaces.js";

const debug = debugFactory("@graphile/pg-adapters:node-postgres");

// Dynamic import to avoid requiring 'pg' when not used
let pgModule: typeof import("pg") | null = null;

async function getPgModule() {
  if (!pgModule) {
    try {
      pgModule = await import("pg");
    } catch (error) {
      throw new Error(
        "The 'pg' module is required to use the node-postgres adapter. " +
          "Please install it with: npm install pg @types/pg",
      );
    }
  }
  return pgModule;
}

// Set `PG_PREPARED_STATEMENT_CACHE_SIZE=0` to disable prepared statements
const cacheSizeFromEnv = process.env.PG_PREPARED_STATEMENT_CACHE_SIZE
  ? parseInt(process.env.PG_PREPARED_STATEMENT_CACHE_SIZE, 10)
  : null;

/**
 * If 0, prepared statements are disabled. Otherwise how many prepared
 * statements should we keep around at any one time?
 */
const PREPARED_STATEMENT_CACHE_SIZE =
  !!cacheSizeFromEnv || cacheSizeFromEnv === 0 ? cacheSizeFromEnv : 100;

export interface NodePostgresPgClient extends PgClient {
  rawClient: PoolClient;
}

export interface NodePostgresAdapterConfig {
  /** PostgreSQL connection string */
  connectionString?: string;
  /** Direct pg.Pool instance (alternative to connectionString) */
  pool?: Pool;
  /** Pool configuration options */
  poolConfig?: Omit<PoolConfig, "connectionString">;
  /** Maximum number of connections in the pool */
  maxConnections?: number;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
  /** Query timeout in milliseconds */
  queryTimeoutMs?: number;
}

function createNodePostgresPgClient(
  pgClient: PoolClient,
  txLevel: number,
  alwaysQueue: boolean,
  alreadyInTransaction: boolean,
): NodePostgresPgClient {
  let queue: Promise<void> | null = null;
  const addToQueue = <T>(callback: () => Promise<T>): Promise<T> => {
    const result = queue ? queue.then(callback) : callback();

    const clearIfSame = () => {
      // Clear queue unless it has moved on
      if (queue === newQueue) {
        queue = null;
      }
    };
    const newQueue = result.then(clearIfSame, clearIfSame);
    queue = newQueue;

    return result;
  };

  return {
    rawClient: pgClient,
    withTransaction(callback) {
      // Transactions always queue; creating queue if need be
      return addToQueue(async () => {
        if (txLevel === 0 && !alreadyInTransaction) {
          await pgClient.query({ text: "begin" });
        } else {
          await pgClient.query({
            text: `savepoint tx${txLevel === 0 ? "" : txLevel}`,
          });
        }
        try {
          const newClient = createNodePostgresPgClient(
            pgClient,
            txLevel + 1,
            alwaysQueue,
            alreadyInTransaction,
          );
          const innerResult = await callback(newClient);
          if (txLevel === 0 && !alreadyInTransaction) {
            await pgClient.query({ text: "commit" });
          } else {
            await pgClient.query({
              text: `release savepoint tx${txLevel === 0 ? "" : txLevel}`,
            });
          }
          return innerResult;
        } catch (e) {
          try {
            if (txLevel === 0 && !alreadyInTransaction) {
              await pgClient.query({ text: "rollback" });
            } else {
              await pgClient.query({
                text: `rollback to savepoint tx${txLevel === 0 ? "" : txLevel}`,
              });
            }
          } catch (_e2) {
            console.error(`Error occurred whilst rolling back: ${e}`);
          }
          throw e;
        }
      });
    },
    query<TData>(opts: PgClientQuery): Promise<PgClientResult<TData>> {
      // Queries only need to queue if there's a queue already
      if (queue || alwaysQueue) {
        return addToQueue(doIt);
      } else {
        return doIt();
      }
      function doIt() {
        const { text, name, values, arrayMode } = opts;
        const queryObj: QueryConfig | QueryArrayConfig = arrayMode
          ? {
              text,
              values,
              rowMode: "array",
            }
          : {
              text,
              values,
            };

        if (PREPARED_STATEMENT_CACHE_SIZE > 0 && name != null) {
          // Hacking into pgClient internals - this is dangerous, but it's the only way I know to get a prepared statement LRU
          const connection = (pgClient as any).connection;
          if (connection && connection.parsedStatements) {
            if (!connection._graphilePreparedStatementCache) {
              connection._graphilePreparedStatementCache = new LRU({
                maxLength: PREPARED_STATEMENT_CACHE_SIZE,
                dispose(key) {
                  if (connection.parsedStatements[key]) {
                    pgClient
                      .query(`deallocate ${pgClient.escapeIdentifier(key)}`)
                      .then(() => {
                        delete connection.parsedStatements[key];
                      })
                      .catch((e) => {
                        console.error("Error releasing prepared query", e);
                      });
                  }
                },
              });
            }
            if (!connection._graphilePreparedStatementCache.get(name)) {
              // We're relying on dispose to clear out the old ones.
              connection._graphilePreparedStatementCache.set(name, true);
            }
            queryObj.name = name;
          }
        }

        return pgClient.query<any>(queryObj);
      }
    },
  };
}

const $$queue = Symbol("tag");
declare module "pg" {
  interface PoolClient {
    [$$queue]?: Promise<any> | null;
  }
}

async function makeNodePostgresWithPgClient_inner<T>(
  pgClient: PoolClient,
  pgSettings: Record<string, string | undefined> | null,
  callback: (client: NodePostgresPgClient) => T | Promise<T>,
  alwaysQueue: boolean,
  alreadyInTransaction: boolean,
) {
  /** Transaction level; 0 = no transaction; 1 = begin; 2,... = savepoint */
  const pgSettingsEntries: Array<[string, string]> = [];
  if (pgSettings != null) {
    for (const [key, value] of Object.entries(pgSettings)) {
      if (value == null) continue;
      pgSettingsEntries.push([key, "" + value]);
    }
  }

  // PERF: under what situations is this actually required? We added it to
  // force test queries that were sharing the same client to run in series
  // rather than parallel (probably for the filter plugin test suite?) but it
  // adds a tiny bit of overhead and most likely is only needed for people
  // using makeWithPgClientViaPgClientAlreadyInTransaction.
  while (pgClient[$$queue]) {
    await pgClient[$$queue];
  }

  return (pgClient[$$queue] = (async () => {
    try {
      // If there's pgSettings; create a transaction and set them, otherwise no transaction needed
      if (pgSettingsEntries.length > 0) {
        await pgClient.query({
          text: alreadyInTransaction ? "savepoint tx" : "begin",
        });
        try {
          await pgClient.query({
            text: "select set_config(el->>0, el->>1, true) from json_array_elements($1::json) el",
            values: [JSON.stringify(pgSettingsEntries)],
          });
          const client = createNodePostgresPgClient(
            pgClient,
            1,
            alwaysQueue,
            alreadyInTransaction,
          );
          const result = await callback(client);
          await pgClient.query({
            text: alreadyInTransaction ? "release savepoint tx" : "commit",
          });
          return result;
        } catch (e) {
          await pgClient.query({
            text: alreadyInTransaction
              ? "rollback to savepoint tx"
              : "rollback",
          });
          throw e;
        }
      } else {
        const client = createNodePostgresPgClient(
          pgClient,
          0,
          alwaysQueue,
          alreadyInTransaction,
        );
        return await callback(client);
      }
    } finally {
      pgClient[$$queue] = null;
    }
  })());
}

/**
 * Returns a `PgPool` for the given `Pool` instance.
 */
export function createPgPoolFromPool(
  pool: Pool,
  release: () => void | Promise<void> = () => {},
): PgPool<NodePostgresPgClient> {
  let released = false;
  const releaseOnce = () => {
    if (released) {
      throw new Error("Release called twice on the same PgPool");
    } else {
      released = true;
      release();
    }
  };

  return {
    async withPgClient(pgSettings, callback) {
      const pgClient = await pool.connect();
      try {
        return await makeNodePostgresWithPgClient_inner(
          pgClient,
          pgSettings,
          callback,
          false,
          false,
        );
      } finally {
        // NOTE: have decided not to `RESET ALL` here; otherwise timezone,jit,etc will reset
        pgClient.release();
      }
    },

    async listen(
      channel: string,
      onnotify: (payload: string | null) => void,
      onError?: (error: ListenError) => void,
    ): Promise<{ unlisten: () => Promise<void> }> {
      let listenClient: PoolClient | null = null;
      let isListening = false;
      let reconnectTimer: NodeJS.Timeout | null = null;

      // Escape channel name for SQL
      const escapedChannel = channel.replace(/"/g, '""');

      const cleanup = async () => {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        if (listenClient) {
          // Remove all listeners before releasing
          listenClient.removeAllListeners();

          // Try to unlisten before releasing
          try {
            await listenClient.query(`UNLISTEN "${escapedChannel}"`);
          } catch {
            // Ignore errors during unlisten
          }

          listenClient.release();
          listenClient = null;
        }

        isListening = false;
      };

      const attemptConnect = async (retryCount = 0): Promise<void> => {
        if (!isListening) {
          return;
        }

        try {
          // Get a dedicated connection for LISTEN
          listenClient = await pool.connect();

          // Handle errors on the listen client
          listenClient.on("error", (err) => {
            const listenError: ListenError = Object.assign(
              new Error(`LISTEN error on channel "${channel}": ${err.message}`),
              {
                channel,
                originalError: err,
              },
            );

            if (onError) {
              onError(listenError);
            }

            // Reconnect after error
            if (isListening) {
              const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
              reconnectTimer = setTimeout(() => {
                attemptConnect(retryCount + 1);
              }, delay);
            }
          });

          // Handle notifications
          listenClient.on("notification", (msg) => {
            if (msg.channel === channel) {
              onnotify(msg.payload ?? null);
            }
          });

          // Start listening
          await listenClient.query(`LISTEN "${escapedChannel}"`);
        } catch (err: any) {
          const listenError: ListenError = Object.assign(
            new Error(
              `Failed to LISTEN on channel "${channel}": ${err.message}`,
            ),
            {
              channel,
              originalError: err,
            },
          );

          if (onError) {
            onError(listenError);
          }

          // Retry connection
          if (isListening) {
            const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
            reconnectTimer = setTimeout(() => {
              attemptConnect(retryCount + 1);
            }, delay);
          }
        }
      };

      // Start listening
      isListening = true;
      await attemptConnect();

      // Return unlisten function
      return {
        unlisten: async () => {
          isListening = false;
          await cleanup();
        },
      };
    },

    release: releaseOnce,
  };
}

async function createPool(config: NodePostgresAdapterConfig): Promise<Pool> {
  const pg = await getPgModule();
  const PgPool = pg.Pool ?? (pg as any).default?.Pool;

  if (config.pool) {
    return config.pool;
  } else {
    return new PgPool({
      ...config.poolConfig,
      connectionString: config.connectionString,
      max: config.maxConnections,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      query_timeout: config.queryTimeoutMs,
    });
  }
}

/**
 * Creates a PostgreSQL adapter using the 'pg' (node-postgres) module.
 */
export const createNodePostgresAdapter: PgAdapterFactory<
  NodePostgresAdapterConfig,
  NodePostgresPgClient
> = (config: NodePostgresAdapterConfig) => {
  let pool: Pool | null = null;
  let poolPromise: Promise<Pool> | null = null;

  const getPool = async (): Promise<Pool> => {
    if (pool) return pool;
    if (poolPromise) return poolPromise;

    poolPromise = createPool(config);
    pool = await poolPromise;
    poolPromise = null;
    return pool;
  };

  return {
    async withPgClient(pgSettings, callback) {
      const poolInstance = await getPool();
      const pgPool = createPgPoolFromPool(poolInstance);
      try {
        return await pgPool.withPgClient(pgSettings, callback);
      } finally {
        pgPool.release?.();
      }
    },
    getPoolSize() {
      // Return the maximum pool size from configuration
      return config.maxConnections ?? config.poolConfig?.max ?? 10; // node-postgres default is 10
    },
    async release() {
      if (pool && !config.pool) {
        // Only end the pool if we created it
        await pool.end();
        pool = null;
      }
    },
  };
};
