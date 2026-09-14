'use strict';

const { MemoryCache } = require('./memory-cache');
const { FileStore } = require('./stores/file-store');

const CACHE_MODES = Object.freeze({
  DISK: 'DISK',
  MEMORY: 'MEMORY',
});

class ExclusiveCache {
  #currentStore;
  #mode;
  #options;

  constructor(options = {}) {
    this.#options = options;
    // Por requerimiento: arranca en DISK obligatoriamente
    this.#mode = CACHE_MODES.DISK;
    this.#initStore();
  }

  #initStore() {
    if (this.#mode === CACHE_MODES.DISK) {
      const filePath = this.#options.filePath || './cache.json';
      this.#currentStore = new FileStore({ path: filePath });
    } else {
      this.#currentStore = new MemoryCache(this.#options);
    }
  }

  /**
   * Cambia el motor de caché a Memoria o Disco.
   * Cierra/destruye el motor anterior para garantizar exclusión mutua.
   */
  switchMode(newMode) {
    if (this.#mode === newMode || !CACHE_MODES[newMode]) return;

    // Destruye el motor actual (limpia intervalos o guarda pendientes en disco)
    if (this.#currentStore && typeof this.#currentStore.destroy === 'function') {
      this.#currentStore.destroy();
    }

    this.#mode = newMode;
    this.#initStore();
  }

  get currentMode() {
    return this.#mode;
  }

  // Métodos puente unificados (Proxy)
  get(key) {
    if (this.#mode === CACHE_MODES.DISK) {
      return this.#currentStore.getRecord(key)?.value;
    }
    return this.#currentStore.get(key);
  }

  set(key, value, options = {}) {
    if (this.#mode === CACHE_MODES.DISK) {
      const ttl = options.ttlMs ?? 60000;
      this.#currentStore.setRecord(key, {
        value,
        expiresAt: ttl > 0 ? Date.now() + ttl : Infinity,
        tags: options.tags ?? [],
      });
    } else {
      this.#currentStore.set(key, value, options);
    }
    return this;
  }

  del(key) {
    return this.#mode === CACHE_MODES.DISK
      ? this.#currentStore.del(key)
      : this.#currentStore.del(key);
  }

  clear() {
    this.#currentStore.clear();
  }

  destroy() {
    if (this.#currentStore && typeof this.#currentStore.destroy === 'function') {
      this.#currentStore.destroy();
    }
  }
}

module.exports = { ExclusiveCache, CACHE_MODES };