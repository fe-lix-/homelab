import { LRUCache } from 'lru-cache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cache = new LRUCache<string, any>({ max: 500, ttl: 55 * 60 * 1000 });

export function getCached<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function setCached<T>(key: string, value: T, ttlMs?: number): void {
  cache.set(key, value, ttlMs ? { ttl: ttlMs } : undefined);
}
