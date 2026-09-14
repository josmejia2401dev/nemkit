'use strict';

const { MemoryStore } = require('./stores/memory-store');
const { FileStore } = require('./stores/file-store');
const { isMemoryUnderPressure } = require('../system');

const CACHE_MODES = Object.freeze({
  MEMORY: 'MEMORY',
  DEGRADED_DISK: 'DEGRADED_DISK',
});

/**
 * @module cache/TieredCache
 *
 * Cache adaptativo de dos niveles (patrón Strategy + State Machine):
 *   L1 = memoria (rápida, volátil)   →   L2 = storage persistente (JSON/archivo)
 *
 * Estados adaptativos según presión de memoria (cgroups / Docker / Render):
 * - MEMORY: Operación normal L1 + L2.
 * - DEGRADED_DISK: Cuando el contenedor entra en presión (>75% RAM), evacúa L1
 *   inmediatamente para evitar OOM Killer y conmuta a operación directa en disco (L2).
 *   Al recuperarse (<60% RAM), restaura la admisión en L1.
 */
class TieredCache {
  #l1;
  #l2;
  #defaultTtlMs;
  #prefix;
  #tagIndex = new Map(); // tag -> Set<fullKey>

  // Adaptive State Machine
  #adaptive;
  #pressureThresholdPercent;
  #recoveryThresholdPercent;
  #maxRssMb;
  #mode = CACHE_MODES.MEMORY;
  #transitionsCount = 0;
  #lastTransitionAt = null;
  #l1Evacuations = 0;
  #monitorTimer = null;

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
   * @param {boolean} [options.adaptive] — Activa o desactiva conmutación automática por RAM (default: true si L2 existe)
   * @param {number} [options.pressureThresholdPercent=75] — Umbral de RAM para degradar a disco
   * @param {number} [options.recoveryThresholdPercent=60] — Umbral de RAM para recuperar memoria
   * @param {number} [options.maxRssMb] — Límite de RSS explícito en MB
   * @param {number} [options.checkIntervalMs=10000] — Intervalo de chequeo periódico de RAM (0 para deshabilitar)
   */
  constructor(options = {}) {
    this.#l1 = options.l1 ?? new MemoryStore();
    this.#l2 = options.l2 ?? (options.file ? new FileStore(options.file) : null);
    this.#defaultTtlMs = options.defaultTtlMs ?? 60000;
    this.#prefix = options.prefix ?? '';

    this.#adaptive = options.adaptive ?? Boolean(this.#l2);
    this.#pressureThresholdPercent = options.pressureThresholdPercent ?? 75;
    this.#recoveryThresholdPercent = options.recoveryThresholdPercent ?? 60;
    this.#maxRssMb = options.maxRssMb ?? null;

    const checkIntervalMs = options.checkIntervalMs ?? 10000;
    if (this.#adaptive && checkIntervalMs > 0) {
      this.#startMonitor(checkIntervalMs);
    }

    this.#rebuildTagIndex();
  }

  // --- Core API ---

  get(key) {
    const fullKey = this.#key(key);

    if (this.#mode === CACHE_MODES.MEMORY) {
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
    } else {
      // Modo DEGRADED_DISK: buscar directamente en L2 sin repoblar L1
      if (this.#l2) {
        const record = this.#l2.getRecord(fullKey);
        if (record) {
          this.#hits++;
          return record.value;
        }
      }
    }

    this.#misses++;
    return undefined;
  }

  set(key, value, options = {}) {
    if (this.#adaptive) {
      this.#evaluateMemoryPressure();
    }

    const ttl = options.ttlMs ?? this.#defaultTtlMs;
    const tags = options.tags ?? [];
    const fullKey = this.#key(key);
    const record = {
      value,
      expiresAt: ttl > 0 ? Date.now() + ttl : Infinity,
      tags,
    };

    if (this.#mode === CACHE_MODES.MEMORY) {
      this.#l1.setRecord(fullKey, record);
    }
    if (this.#l2) this.#l2.setRecord(fullKey, record);
    this.#indexTags(fullKey, tags);
    return this;
  }

  has(key) {
    const fullKey = this.#key(key);
    if (this.#mode === CACHE_MODES.MEMORY && this.#l1.has(fullKey)) return true;
    return this.#l2 ? this.#l2.has(fullKey) : false;
  }

  del(key) {
    const fullKey = this.#key(key);
    const a = this.#mode === CACHE_MODES.MEMORY ? this.#l1.del(fullKey) : false;
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
      const a = this.#mode === CACHE_MODES.MEMORY ? this.#l1.del(fullKey) : false;
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
    const seen = new Set([
      ...(this.#mode === CACHE_MODES.MEMORY ? this.#l1.keys() : []),
      ...(this.#l2 ? this.#l2.keys() : []),
    ]);
    let count = 0;
    for (const fullKey of seen) {
      if (regex.test(fullKey)) {
        const a = this.#mode === CACHE_MODES.MEMORY ? this.#l1.del(fullKey) : false;
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
      mode: this.#mode,
      memoryPressure: this.#mode === CACHE_MODES.DEGRADED_DISK,
      adaptiveEnabled: this.#adaptive,
      pressureTransitions: this.#transitionsCount,
      lastTransitionAt: this.#lastTransitionAt,
      l1Evacuations: this.#l1Evacuations,
      l1Size: this.#l1.keys().length,
      l2Size: this.#l2 ? this.#l2.keys().length : 0,
      tiers: this.#l2 ? 2 : 1,
    };
  }

  /**
   * Lista entradas sin exponer sus valores.
   * @param {Object} [options]
   * @param {number} [options.page=1]
   * @param {number} [options.limit=50]
   * @param {string} [options.search='']
   */
  listEntries({ page = 1, limit = 50, search = '' } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const normalizedSearch = String(search).toLowerCase();
    const fullKeys = [...new Set([
      ...(this.#mode === CACHE_MODES.MEMORY ? this.#l1.keys() : []),
      ...(this.#l2 ? this.#l2.keys() : []),
    ])]
      .filter((key) => this.#stripPrefix(key).toLowerCase().includes(normalizedSearch))
      .sort();
    const start = (safePage - 1) * safeLimit;
    const entries = fullKeys.slice(start, start + safeLimit).map((fullKey) => {
      const l1Record = this.#mode === CACHE_MODES.MEMORY ? this.#l1.getRecord(fullKey) : null;
      const l2Record = this.#l2?.getRecord(fullKey);
      const record = l1Record ?? l2Record;
      return this.#entryMetadata(fullKey, record, Boolean(l1Record), Boolean(l2Record));
    });

    return {
      entries,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: fullKeys.length,
        totalPages: Math.ceil(fullKeys.length / safeLimit),
      },
    };
  }

  /** Devuelve una entrada administrativa incluyendo su valor. */
  getEntry(key) {
    const fullKey = this.#key(key);
    const l1Record = this.#mode === CACHE_MODES.MEMORY ? this.#l1.getRecord(fullKey) : null;
    const l2Record = this.#l2?.getRecord(fullKey);
    const record = l1Record ?? l2Record;
    if (!record) return null;
    return {
      ...this.#entryMetadata(fullKey, record, Boolean(l1Record), Boolean(l2Record)),
      value: record.value,
    };
  }

  resetStats() { this.#hits = 0; this.#misses = 0; }

  /** Fuerza el volcado a disco si aplica. */
  flush() {
    if (this.#l2 && typeof this.#l2.flush === 'function') this.#l2.flush();
  }

  destroy() {
    if (this.#monitorTimer) {
      clearInterval(this.#monitorTimer);
      this.#monitorTimer = null;
    }
    this.#l1.destroy();
    if (this.#l2) this.#l2.destroy();
    this.#tagIndex.clear();
  }

  // --- Adaptive State Management ---

  #evaluateMemoryPressure() {
    if (!this.#adaptive || !this.#l2) return;

    if (this.#mode === CACHE_MODES.MEMORY) {
      const underPressure = isMemoryUnderPressure({
        thresholdPercent: this.#pressureThresholdPercent,
        maxRssMb: this.#maxRssMb,
      });

      if (underPressure) {
        this.#mode = CACHE_MODES.DEGRADED_DISK;
        this.#l1.clear();
        this.#l1Evacuations++;
        this.#transitionsCount++;
        this.#lastTransitionAt = new Date().toISOString();
      }
    } else if (this.#mode === CACHE_MODES.DEGRADED_DISK) {
      const stillUnderPressure = isMemoryUnderPressure({
        thresholdPercent: this.#recoveryThresholdPercent,
        maxRssMb: this.#maxRssMb ? this.#maxRssMb * 0.8 : null,
      });

      if (!stillUnderPressure) {
        this.#mode = CACHE_MODES.MEMORY;
        this.#transitionsCount++;
        this.#lastTransitionAt = new Date().toISOString();
      }
    }
  }

  #startMonitor(intervalMs) {
    this.#monitorTimer = setInterval(() => {
      this.#evaluateMemoryPressure();
    }, intervalMs);
    if (this.#monitorTimer.unref) {
      this.#monitorTimer.unref();
    }
  }

  // --- Private Helpers ---

  #key(key) {
    return this.#prefix ? `${this.#prefix}:${key}` : key;
  }

  #stripPrefix(fullKey) {
    return this.#prefix && fullKey.startsWith(`${this.#prefix}:`)
      ? fullKey.slice(this.#prefix.length + 1)
      : fullKey;
  }

  #entryMetadata(fullKey, record, inMemory, onDisk) {
    const serialized = JSON.stringify(record?.value ?? null);
    return {
      key: this.#stripPrefix(fullKey),
      expiresAt: record?.expiresAt ?? null,
      sizeBytes: Buffer.byteLength(serialized, 'utf8'),
      availableInMemory: inMemory,
      availableOnDisk: onDisk,
    };
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

module.exports = { TieredCache, CACHE_MODES };
