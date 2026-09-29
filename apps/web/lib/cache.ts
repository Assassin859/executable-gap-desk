/** TTL cache where concurrent callers share one in-flight promise; failures are not cached. */
export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = load();
      entries.set(key, { at: now(), value });
      value.catch(() => entries.delete(key));
      return value;
    },
    has(key: string): boolean {
      const hit = entries.get(key);
      return !!hit && now() - hit.at < ttlMs;
    },
  };
}

/** Sliding-window limit per key (e.g. client IP). */
export function createThrottle(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
  };
}
