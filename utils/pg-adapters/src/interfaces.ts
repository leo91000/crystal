/**
 * Core PostgreSQL adapter interfaces for Graphile projects.
 * These interfaces are designed to be database-driver agnostic.
 */

export interface PgClientQuery<T = any> {
  /** The query string */
  text: string;
  /** The values to put in the placeholders */
  values?: Array<T>;
  /** An optimisation, to avoid you having to decode attribute names */
  arrayMode?: boolean;
  /** For prepared statements */
  name?: string;
}

export interface PgClientResult<TData> {
  /**
   * For `SELECT` or `INSERT/UPDATE/DELETE ... RETURNING` this will be the list
   * of rows returned.
   */
  rows: readonly TData[];
  /**
   * For `INSERT/UPDATE/DELETE` without `RETURNING`, this will be the number of
   * rows created/updated/deleted.
   */
  rowCount: number | null;
}

/**
 * Represents a single PostgreSQL connection/transaction.
 * This is what you get inside the withPgClient callback.
 */
export interface PgClient {
  query<TData>(opts: PgClientQuery): Promise<PgClientResult<TData>>;
  withTransaction<T>(callback: (client: this) => Promise<T>): Promise<T>;
}

/**
 * Error that occurs during LISTEN operations
 */
export interface ListenError extends Error {
  /** The channel that failed to listen */
  channel: string;
  /** The original error that caused the failure */
  originalError?: Error;
}

/**
 * Represents a PostgreSQL connection pool that can provide clients.
 * This is the main interface that adapters implement.
 */
export interface PgPool<TPgClient extends PgClient = PgClient> {
  /**
   * Execute a callback with a PostgreSQL client.
   * The client is automatically managed (connection pooling, cleanup, etc.).
   */
  withPgClient<T>(
    pgSettings: Record<string, string | undefined> | null,
    callback: (client: TPgClient) => T | Promise<T>,
  ): Promise<T>;

  /**
   * Listen to a PostgreSQL channel for notifications.
   * Returns an object with an unlisten method to stop listening.
   */
  listen?(
    channel: string,
    onnotify: (payload: string | null) => void,
    onError?: (error: ListenError) => void,
  ): Promise<{ unlisten: () => Promise<void> }>;

  /**
   * Get the total number of connections in the pool.
   * For adapters without a traditional pool (like PGLite), this returns 1.
   */
  getPoolSize?(): number;

  /** Release any resources held by this pool */
  release?(): void | Promise<void>;
}

/**
 * A factory function that creates a PgPool for a specific
 * PostgreSQL driver implementation.
 */
export interface PgAdapterFactory<
  TConfig = any,
  TClient extends PgClient = PgClient,
> {
  (config: TConfig): PgPool<TClient>;
}

/**
 * Type helper to extract the client type from a PgPool.
 */
export type ExtractPgClient<T> = T extends PgPool<infer U> ? U : never;

/**
 * Type helper to extract the config type from an adapter factory.
 */
export type ExtractAdapterConfig<T> =
  T extends PgAdapterFactory<infer U, any> ? U : never;
