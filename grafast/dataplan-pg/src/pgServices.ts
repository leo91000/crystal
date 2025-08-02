import type { PgClient, WithPgClient } from "./executor.js";
import type { PgPool } from "@graphile/pg-adapters";

type PromiseOrDirect<T> = T | PromiseLike<T>;

/** @experimental */
export interface PgAdaptor<
  TAdaptor extends
    keyof GraphileConfig.PgAdaptors = keyof GraphileConfig.PgAdaptors,
> {
  createWithPgClient: (
    adaptorSettings: GraphileConfig.PgAdaptors[TAdaptor]["adaptorSettings"],
    variant?: "SUPERUSER" | string | null,
  ) => PromiseOrDirect<
    WithPgClient<GraphileConfig.PgAdaptors[TAdaptor]["client"]>
  >;
  makePgService: (
    options: GraphileConfig.PgAdaptors[TAdaptor]["makePgServiceOptions"],
  ) => GraphileConfig.PgServiceConfiguration;
}

/**
 * Is "thenable".
 */
export function isPromiseLike<T>(
  t: T | Promise<T> | PromiseLike<T>,
): t is PromiseLike<T> {
  return t != null && typeof (t as any).then === "function";
}

const isTest = process.env.NODE_ENV === "test";

interface PgClientBySourceCacheValue {
  withPgClient: WithPgClient<PgClient>;
  retainers: number;
}

const withPgClientDetailsByConfigCache = new Map<
  GraphileConfig.PgServiceConfiguration,
  PgClientBySourceCacheValue
>();

/**
 * Get or build the 'withPgClient' callback function for a given database
 * config, caching it to make future lookups faster.
 */
export function getWithPgClientFromPgService(
  config: GraphileConfig.PgServiceConfiguration,
): WithPgClient<PgClient> {
  const existing = withPgClientDetailsByConfigCache.get(config);
  if (existing) {
    existing.retainers++;
    return existing.withPgClient;
  }

  const { pgPool } = config;
  if (!pgPool) {
    throw new Error(
      `PgServiceConfiguration '${config.name}' is missing pgPool`,
    );
  }

  const withPgClient: WithPgClient<PgClient> = async (pgSettings, callback) => {
    return pgPool.withPgClient(pgSettings, callback);
  };
  
  const cachedValue: PgClientBySourceCacheValue = {
    withPgClient,
    retainers: 1,
  };
  
  let released = false;
  withPgClient.release = () => {
    cachedValue.retainers--;

    // To allow for other promises to resolve and add/remove from the retainers, check after a tick
    const tid = setTimeout(
      () => {
        if (cachedValue.retainers === 0 && !released) {
          released = true;
          withPgClientDetailsByConfigCache.delete(config);
          // Note: we don't call pgPool.release() here because we don't own the pool
        }
      },
      isTest ? 500 : 5000,
    );
    tid.unref?.(); // Don't block process exit
  };
  
  withPgClientDetailsByConfigCache.set(config, cachedValue);
  return withPgClient;
}

export async function withPgClientFromPgService<T>(
  config: GraphileConfig.PgServiceConfiguration,
  pgSettings: Record<string, string | undefined> | null,
  callback: (client: PgClient) => T | Promise<T>,
): Promise<T> {
  const withPgClient = getWithPgClientFromPgService(config);
  try {
    return await withPgClient(pgSettings, callback);
  } finally {
    withPgClient.release!();
  }
}

// We don't cache superuser withPgClients
export async function withSuperuserPgClientFromPgService<T>(
  config: GraphileConfig.PgServiceConfiguration,
  pgSettings: Record<string, string | undefined> | null,
  callback: (client: PgClient) => T | Promise<T>,
): Promise<T> {
  const { superuserPgPool } = config;
  if (!superuserPgPool) {
    throw new Error(
      `PgServiceConfiguration '${config.name}' does not have a superuserPgPool configured`,
    );
  }
  
  return superuserPgPool.withPgClient(pgSettings, callback);
}
