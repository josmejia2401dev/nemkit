'use strict';

const { MemoryStore } = require('./stores/memory-store');
const { FileStore } = require('./stores/file-store');

/**
 * @module cache/TieredCache
 *
 * Cache de dos niveles (patrón Strategy + fachada):
 *   L1 = memoria (rápida, volátil)   →   L2 = storage persistente (JSON)
 *
 * - get: busca en L1; si falla, busca en L2 y repuebla L1 (read-through).
 * - set: escribe en ambos niveles (write-through).
 * - Invalidación por tag/patrón afecta ambos niveles.
 * - Misma API que MemoryCache: get/set/has/del/getOrSet/invalidateTag/...
 *
 * El TTL se expresa en ms (0 = sin expiración).
 */
class TieredCache {
  #l1;
  #l2;
  #defaultTtlMs;
  #prefix;
  #tagIndex = new Map(); // tag -> Set<fullKey>

  // Stats
  #hits = 0;
  #misses = 0;

  /**
   * @param {Object} [options]
   * @param {import('./stores/cache-store').CacheStore} [options.l1] — Store nivel 1 (default: MemoryStore)
   * @param {import('./stores/cache-store').CacheStore} [options.l2] — Store nivel 2 (persistente)
   * @param {Object} [options.file] — Config para crear un FileStore como L2 si no se pasa l2
   * @param {string}  options.file.path — Ruta del JSON
   * @param {number} [options.defaultTtlMs=60000]
   * @param {string} [options.prefix='']
   */
  constructor(options = {}) {
    this.#l1 = options.l1 ?? new MemoryStore();
    this.#l2 = options.l2 ?? (options.file ? new FileStore(options.file) : null);
    this.#defaultTtlMs = options.defaultTtlMs ?? 60000;
    this.#prefix = options.prefix ?? '';
    this.#rebuildTagIndex();
  }

  // --- Core API ---

  get(key) {
    const fullKey = this.#key(key);

    let record = this.#l1.getRecord(fullKey);
    if (record) { this.#hits++; return record.value; }

    // Miss en L1 → intentar L2 y repoblar L1 (read-through)
    if (this.#l2) {
      record = this.#l2.getRecord(fullKey);
      if (record) {
        this.#l1.setRecord(fullKey, record);
        this.#hits++;
        return record.value;
      }
    }

    this.#misses++;
    return undefined;
  }

  set(key, value, options = {}) {
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    const tags = options.tags ?? [];
    const fullKey = this.#key(key);
    const record = {
      value,
      expiresAt: ttl > 0 ? Date.now() + ttl : Infinity,
      tags,
    };

    this.#l1.setRecord(fullKey, record);
    if (this.#l2) this.#l2.setRecord(fullKey, record);
    this.#indexTags(fullKey, tags);
    return this;
  }

  has(key) {
    const fullKey = this.#key(key);
    if (this.#l1.has(fullKey)) return true;
    return this.#l2 ? this.#l2.has(fullKey) : false;
  }

  del(key) {
    const fullKey = this.#key(key);
    const a = this.#l1.del(fullKey);
    const b = this.#l2 ? this.#l2.del(fullKey) : false;
    this.#dropKeyFromAllTags(fullKey);
    return a || b;
  }

  clear() {
    this.#l1.clear();
    if (this.#l2) this.#l2.clear();
    this.#tagIndex.clear();
  }

  // --- Patterns ---

  async getOrSet(key, fetchFn, options = {}) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await fetchFn();
    this.set(key, value, options);
    return value;
  }

  /**
   * Invalida todas las keys asociadas a un tag en ambos niveles.
   * @param {string} tag
   * @returns {number}
   */
  invalidateTag(tag) {
    const keys = this.#tagIndex.get(tag);
    if (!keys) return 0;
    let count = 0;
    for (const fullKey of [...keys]) {
      const a = this.#l1.del(fullKey);
      const b = this.#l2 ? this.#l2.del(fullKey) : false;
      if (a || b) count++;
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

  /**
   * Invalida por patrón glob simple (* wildcard) en ambos niveles.
   * @param {string} pattern
   * @returns {number}
   */
  invalidatePattern(pattern) {
    const regex = new RegExp('^' + this.#key(pattern).replace(/\*/g, '.*') + '$');
    const seen = new Set([...this.#l1.keys(), ...(this.#l2 ? this.#l2.keys() : [])]);
    let count = 0;
    for (const fullKey of seen) {
      if (regex.test(fullKey)) {
        const a = this.#l1.del(fullKey);
        const b = this.#l2 ? this.#l2.del(fullKey) : false;
        if (a || b) count++;
        this.#dropKeyFromAllTags(fullKey);
      }
    }
    return count;
  }

  // --- Stats & lifecycle ---

  getStats() {
    const total = this.#hits + this.#misses;
    return {
      hits: this.#hits,
      misses: this.#misses,
      hitRate: total > 0 ? +(this.#hits / total).toFixed(4) : 0,
      l1Size: this.#l1.keys().length,
      l2Size: this.#l2 ? this.#l2.keys().length : 0,
      tiers: this.#l2 ? 2 : 1,
    };
  }

  resetStats() { this.#hits = 0; this.#misses = 0; }

  /** Vuelca el L2 a disco si aplica. */
  flush() {
    if (this.#l2 && typeof this.#l2.flush === 'function') this.#l2.flush();
  }

  destroy() {
    this.#l1.destroy();
    if (this.#l2) this.#l2.destroy();
    this.#tagIndex.clear();
  }

  // --- Private ---

  #key(key) {
    return this.#prefix ? `${this.#prefix}:${key}` : key;
  }

  #indexTags(fullKey, tags) {
    for (const tag of tags) {
      let set = this.#tagIndex.get(tag);
      if (!set) { set = new Set(); this.#tagIndex.set(tag, set); }
      set.add(fullKey);
    }
  }

  #dropKeyFromAllTags(fullKey) {
    for (const [tag, set] of this.#tagIndex) {
      if (set.delete(fullKey) && set.size === 0) this.#tagIndex.delete(tag);
    }
  }

  /** Reconstruye el índice de tags a partir de lo persistido en L2 (al arrancar). */
  #rebuildTagIndex() {
    if (!this.#l2) return;
    for (const fullKey of this.#l2.keys()) {
      const record = this.#l2.getRecord(fullKey);
      if (record?.tags?.length) this.#indexTags(fullKey, record.tags);
    }
  }
}

module.exports = { TieredCache };
