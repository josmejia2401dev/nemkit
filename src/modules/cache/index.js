'use strict';

/**
 * @module cache
 *
 * In-memory cache de alto rendimiento con:
 * - TTL por entrada (time-to-live)
 * - Estrategias de evicción: LRU (Least Recently Used) y LFU (Least Frequently Used)
 * - Límite de tamaño configurable (maxSize)
 * - Stale-while-revalidate (sirve dato expirado mientras refresca en background)
 * - Namespace/prefix para segmentación lógica
 * - Invalidación por patrón (wildcard)
 * - Estadísticas (hits, misses, evictions)
 * - getOrSet (cache-aside pattern)
 * - Limpieza periódica automática de entradas expiradas
 */

const EVICTION_POLICIES = Object.freeze({
  LRU: 'LRU',
  LFU: 'LFU',
});

class CacheEntry {
  constructor(key, value, ttlMs) {
    this.key = key;
    this.value = value;
    this.createdAt = Date.now();
    this.expiresAt = ttlMs > 0 ? this.createdAt + ttlMs : Infinity;
    this.lastAccessedAt = this.createdAt;
    this.accessCount = 0;
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
   * @param {number} [options.maxSize=1000] — Máximo de entradas en cache
   * @param {number} [options.defaultTtlMs=60000] — TTL por defecto en ms (0 = sin expiración)
   * @param {string} [options.policy='LRU'] — Estrategia de evicción: 'LRU' | 'LFU'
   * @param {string} [options.prefix=''] — Prefijo para namespacing de keys
   * @param {number} [options.staleWhileRevalidateMs=0] — Ventana extra para servir stale (0 = deshabilitado)
   * @param {number} [options.cleanupIntervalMs=30000] — Intervalo de limpieza automática (0 = deshabilitado)
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

  // --- Core API ---

  /**
   * Obtiene un valor del cache.
   * @param {string} key
   * @returns {*|undefined} — Valor o undefined si no existe/expirado
   */
  get(key) {
    const entry = this.#store.get(this.#key(key));

    if (!entry) {
      this.#misses++;
      return undefined;
    }

    if (entry.isExpired()) {
      this.#store.delete(this.#key(key));
      this.#misses++;
      return undefined;
    }

    entry.touch();
    this.#hits++;
    return entry.value;
  }

  /**
   * Almacena un valor en cache.
   * @param {string} key
   * @param {*} value
   * @param {Object} [options]
   * @param {number} [options.ttlMs] — TTL específico para esta entrada
   * @returns {this}
   */
  set(key, value, options = {}) {
    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    const fullKey = this.#key(key);

    // Si ya existe, actualizamos sin contar como nueva entrada
    if (this.#store.has(fullKey)) {
      const entry = new CacheEntry(fullKey, value, ttl);
      this.#store.set(fullKey, entry);
      return this;
    }

    // Evict si estamos al límite
    if (this.#store.size >= this.#maxSize) {
      this.#evict();
    }

    this.#store.set(fullKey, new CacheEntry(fullKey, value, ttl));
    return this;
  }

  /**
   * Verifica si una key existe y no está expirada.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this.#store.get(this.#key(key));
    if (!entry) return false;
    if (entry.isExpired()) { this.#store.delete(this.#key(key)); return false; }
    return true;
  }

  /**
   * Elimina una entrada del cache.
   * @param {string} key
   * @returns {boolean}
   */
  del(key) {
    return this.#store.delete(this.#key(key));
  }

  /**
   * Limpia todo el cache.
   */
  clear() {
    this.#store.clear();
  }

  /**
   * Cantidad de entradas activas (sin contar expiradas).
   * @returns {number}
   */
  get size() {
    return this.#store.size;
  }

  // --- Patterns ---

  /**
   * Cache-aside: obtiene del cache o ejecuta fetchFn y almacena el resultado.
   * @param {string} key
   * @param {Function} fetchFn — async () => value
   * @param {Object} [options]
   * @param {number} [options.ttlMs]
   * @returns {Promise<*>}
   */
  async getOrSet(key, fetchFn, options = {}) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const value = await fetchFn();
    this.set(key, value, options);
    return value;
  }

  /**
   * Stale-while-revalidate: sirve el dato aunque esté expirado (si está dentro
   * de la ventana stale) y dispara la actualización en background.
   *
   * @param {string} key
   * @param {Function} fetchFn — async () => value
   * @param {Object} [options]
   * @param {number} [options.ttlMs]
   * @returns {Promise<*|undefined>}
   */
  async getStale(key, fetchFn, options = {}) {
    const entry = this.#store.get(this.#key(key));

    // No existe
    if (!entry) {
      const value = await fetchFn();
      this.set(key, value, options);
      return value;
    }

    // Fresco
    if (!entry.isExpired()) {
      entry.touch();
      this.#hits++;
      return entry.value;
    }

    // Expirado pero dentro de ventana stale
    const staleDeadline = entry.expiresAt + this.#staleWhileRevalidateMs;
    if (this.#staleWhileRevalidateMs > 0 && Date.now() <= staleDeadline) {
      this.#hits++;
      // Revalidar en background (fire-and-forget)
      fetchFn().then((val) => this.set(key, val, options)).catch(() => { /* silent */ });
      return entry.value;
    }

    // Completamente expirado — refresh síncrono
    this.#store.delete(this.#key(key));
    const value = await fetchFn();
    this.set(key, value, options);
    return value;
  }

  /**
   * Invalida todas las keys que matcheen un patrón glob simple (* wildcard).
   * @param {string} pattern — Ej: 'users:*', '*:list'
   * @returns {number} — Cantidad de entradas eliminadas
   */
  invalidatePattern(pattern) {
    const regex = new RegExp('^' + this.#key(pattern).replace(/\*/g, '.*') + '$');
    let count = 0;
    for (const key of this.#store.keys()) {
      if (regex.test(key)) {
        this.#store.delete(key);
        count++;
      }
    }
    return count;
  }

  // --- Stats ---

  /**
   * Retorna estadísticas del cache.
   */
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

  /**
   * Resetea los contadores de stats.
   */
  resetStats() {
    this.#hits = 0;
    this.#misses = 0;
    this.#evictions = 0;
  }

  // --- Lifecycle ---

  /**
   * Detiene el timer de limpieza. Llamar al hacer shutdown.
   */
  destroy() {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
    this.#store.clear();
  }

  // --- Private ---

  #key(key) {
    return this.#prefix ? `${this.#prefix}:${key}` : key;
  }

  #evict() {
    if (this.#store.size === 0) return;

    let victim = null;

    if (this.#policy === EVICTION_POLICIES.LFU) {
      // Evict la entrada con menor accessCount
      let minCount = Infinity;
      for (const entry of this.#store.values()) {
        if (entry.accessCount < minCount) {
          minCount = entry.accessCount;
          victim = entry;
        }
      }
    } else {
      // LRU — evict la entrada con lastAccessedAt más antiguo
      let oldest = Infinity;
      for (const entry of this.#store.values()) {
        if (entry.lastAccessedAt < oldest) {
          oldest = entry.lastAccessedAt;
          victim = entry;
        }
      }
    }

    if (victim) {
      this.#store.delete(victim.key);
      this.#evictions++;
    }
  }

  #startCleanup() {
    this.#cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.#store) {
        if (now > entry.expiresAt) {
          this.#store.delete(key);
        }
      }
    }, this.#cleanupInterval);

    // No bloquear el event loop al shutdown
    if (this.#cleanupTimer.unref) {
      this.#cleanupTimer.unref();
    }
  }
}

/**
 * Factory para crear una instancia de MemoryCache con opciones.
 * @param {Object} [options] — Mismas opciones que el constructor de MemoryCache
 * @returns {MemoryCache}
 */
const createCache = (options = {}) => new MemoryCache(options);

module.exports = { MemoryCache, createCache, EVICTION_POLICIES };
