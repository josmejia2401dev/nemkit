'use strict';

/**
 * @module cache/MemoryCache
 * In-memory cache de alto rendimiento con TTL, evicción (LRU/LFU),
 * tags, stale-while-revalidate e invalidación por patrones.
 */

const EVICTION_POLICIES = Object.freeze({
  LRU: 'LRU',
  LFU: 'LFU',
});

class CacheEntry {
  /**
   * @param {string} key
   * @param {*} value
   * @param {number} ttlMs
   * @param {string[]} [tags=[]] Etiquetas para invalidación por grupo
   */
  constructor(key, value, ttlMs, tags = []) {
    this.key = key;
    this.value = value;
    this.createdAt = Date.now();
    this.expiresAt = ttlMs > 0 ? this.createdAt + ttlMs : Infinity;
    this.lastAccessedAt = this.createdAt;
    this.accessCount = 0;
    this.tags = Array.isArray(tags) ? tags : [];
  }

  isExpired() {
    return Date.now() > this.expiresAt;
  }

  touch() {
    this.lastAccessedAt = Date.now();
    this.accessCount++;
  }
}

class MemoryCache {
  #store = new Map();
  #tagIndex = new Map();
  #maxSize;
  #defaultTtlMs;
  #policy;
  #prefix;
  #staleWhileRevalidateMs;
  #cleanupInterval;
  #cleanupTimer = null;

  // Stats
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  /**
   * @param {Object} [options]
   * @param {number} [options.maxSize=1000]
   * @param {number} [options.defaultTtlMs=60000]
   * @param {string} [options.policy='LRU']
   * @param {string} [options.prefix='']
   * @param {number} [options.staleWhileRevalidateMs=0]
   * @param {number} [options.cleanupIntervalMs=30000]
   */
  constructor(options = {}) {
    this.#maxSize = options.maxSize ?? 1000;
    this.#defaultTtlMs = options.defaultTtlMs ?? 60000;
    this.#policy = options.policy ?? EVICTION_POLICIES.LRU;
    this.#prefix = options.prefix ?? '';
    this.#staleWhileRevalidateMs = options.staleWhileRevalidateMs ?? 0;
    this.#cleanupInterval = options.cleanupIntervalMs ?? 30000;
    if (this.#cleanupInterval > 0) {
      this.#startCleanup();
    }
  }

  get(key) {
    const entry = this.#store.get(this.#key(key));
    if (!entry) {
      this.#misses++;
      return undefined;
    }
    if (entry.isExpired()) {
      this.#remove(this.#key(key));
      this.#misses++;
      return undefined;
    }
    entry.touch();
    this.#hits++;
    return entry.value;
  }

  set(key, value, options = {}) {
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    const tags = options.tags ?? [];
    const fullKey = this.#key(key);

    if (this.#store.has(fullKey)) {
      this.#unindexTags(this.#store.get(fullKey));
    } else if (this.#store.size >= this.#maxSize) {
      this.#evict();
    }

    const entry = new CacheEntry(fullKey, value, ttl, tags);
    this.#store.set(fullKey, entry);
    this.#indexTags(entry);
    return this;
  }

  has(key) {
    const entry = this.#store.get(this.#key(key));
    if (!entry) return false;
    if (entry.isExpired()) {
      this.#remove(this.#key(key));
      return false;
    }
    return true;
  }

  del(key) {
    return this.#remove(this.#key(key));
  }

  clear() {
    this.#store.clear();
    this.#tagIndex.clear();
  }

  get size() {
    return this.#store.size;
  }

  keys() {
    const out = [];
    for (const [fullKey, entry] of this.#store) {
      if (entry.isExpired()) {
        this.#remove(fullKey);
        continue;
      }
      out.push(this.#stripPrefix(fullKey));
    }
    return out;
  }

  async getOrSet(key, fetchFn, options = {}) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await fetchFn();
    this.set(key, value, options);
    return value;
  }

  async getStale(key, fetchFn, options = {}) {
    const entry = this.#store.get(this.#key(key));
    if (!entry) {
      const value = await fetchFn();
      this.set(key, value, options);
      return value;
    }
    if (!entry.isExpired()) {
      entry.touch();
      this.#hits++;
      return entry.value;
    }
    const staleDeadline = entry.expiresAt + this.#staleWhileRevalidateMs;
    if (this.#staleWhileRevalidateMs > 0 && Date.now() <= staleDeadline) {
      this.#hits++;
      fetchFn().then((val) => this.set(key, val, options)).catch(() => {});
      return entry.value;
    }
    this.#remove(this.#key(key));
    const value = await fetchFn();
    this.set(key, value, options);
    return value;
  }

  invalidatePattern(pattern) {
    const regex = new RegExp('^' + this.#key(pattern).replace(/\*/g, '.*') + '$');
    let count = 0;
    for (const key of this.#store.keys()) {
      if (regex.test(key)) {
        this.#remove(key);
        count++;
      }
    }
    return count;
  }

  listEntries({ page = 1, limit = 50, search = '' } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const normalizedSearch = String(search).toLowerCase();
    const keys = this.keys().filter((key) => key.toLowerCase().includes(normalizedSearch));
    const start = (safePage - 1) * safeLimit;
    return {
      entries: keys.slice(start, start + safeLimit).map((key) => ({
        key,
        value: this.get(key),
        sizeBytes: Buffer.byteLength(JSON.stringify(this.get(key) ?? null), 'utf8'),
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: keys.length,
        totalPages: Math.ceil(keys.length / safeLimit),
      },
    };
  }

  getEntry(key) {
    if (!this.has(key)) return null;
    const value = this.get(key);
    return {
      key,
      value,
      sizeBytes: Buffer.byteLength(JSON.stringify(value ?? null), 'utf8'),
    };
  }

  invalidateTag(tag) {
    const keys = this.#tagIndex.get(tag);
    if (!keys) return 0;
    let count = 0;
    for (const fullKey of [...keys]) {
      if (this.#store.delete(fullKey)) count++;
      this.#dropKeyFromAllTags(fullKey);
    }
    this.#tagIndex.delete(tag);
    return count;
  }

  invalidateTags(tags = []) {
    let count = 0;
    for (const tag of tags) count += this.invalidateTag(tag);
    return count;
  }

  getStats() {
    return {
      size: this.#store.size,
      maxSize: this.#maxSize,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      hitRate: this.#hits + this.#misses > 0
        ? +(this.#hits / (this.#hits + this.#misses)).toFixed(4)
        : 0,
      policy: this.#policy,
    };
  }

  resetStats() {
    this.#hits = 0;
    this.#misses = 0;
    this.#evictions = 0;
  }

  destroy() {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
    this.#store.clear();
    this.#tagIndex.clear();
  }

  #key(key) {
    return this.#prefix ? `${this.#prefix}:${key}` : key;
  }

  #stripPrefix(fullKey) {
    return this.#prefix && fullKey.startsWith(`${this.#prefix}:`)
      ? fullKey.slice(this.#prefix.length + 1)
      : fullKey;
  }

  #remove(fullKey) {
    const entry = this.#store.get(fullKey);
    if (!entry) return false;
    this.#unindexTags(entry);
    return this.#store.delete(fullKey);
  }

  #indexTags(entry) {
    for (const tag of entry.tags) {
      let set = this.#tagIndex.get(tag);
      if (!set) { set = new Set(); this.#tagIndex.set(tag, set); }
      set.add(entry.key);
    }
  }

  #unindexTags(entry) {
    for (const tag of entry.tags) {
      const set = this.#tagIndex.get(tag);
      if (!set) continue;
      set.delete(entry.key);
      if (set.size === 0) this.#tagIndex.delete(tag);
    }
  }

  #dropKeyFromAllTags(fullKey) {
    for (const [tag, set] of this.#tagIndex) {
      if (set.delete(fullKey) && set.size === 0) this.#tagIndex.delete(tag);
    }
  }

  #evict() {
    if (this.#store.size === 0) return;
    let victim = null;
    if (this.#policy === EVICTION_POLICIES.LFU) {
      let minCount = Infinity;
      for (const entry of this.#store.values()) {
        if (entry.accessCount < minCount) {
          minCount = entry.accessCount;
          victim = entry;
        }
      }
    } else {
      let oldest = Infinity;
      for (const entry of this.#store.values()) {
        if (entry.lastAccessedAt < oldest) {
          oldest = entry.lastAccessedAt;
          victim = entry;
        }
      }
    }
    if (victim) {
      this.#remove(victim.key);
      this.#evictions++;
    }
  }

  #startCleanup() {
    this.#cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.#store) {
        if (now > entry.expiresAt) {
          this.#remove(key);
        }
      }
    }, this.#cleanupInterval);
    if (this.#cleanupTimer.unref) {
      this.#cleanupTimer.unref();
    }
  }
}

/**
 * Factory para crear una instancia de MemoryCache.
 * @param {Object} [options]
 * @returns {MemoryCache}
 */
const createCache = (options = {}) => new MemoryCache(options);

module.exports = {
  MemoryCache,
  createCache,
  EVICTION_POLICIES,
};