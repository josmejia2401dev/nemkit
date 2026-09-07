'use strict';

const { CacheStore, isExpired } = require('./cache-store');

/**
 * @module cache/stores/MemoryStore
 *
 * Backend de cache en memoria (Map). Rápido, volátil (se pierde al reiniciar).
 * Almacena records { value, expiresAt, tags }.
 */
class MemoryStore extends CacheStore {
  #map = new Map();

  getRecord(key) {
    const record = this.#map.get(key);
    if (!record) return undefined;
    if (isExpired(record)) { this.#map.delete(key); return undefined; }
    return record;
  }

  setRecord(key, record) {
    this.#map.set(key, record);
  }

  has(key) {
    return this.getRecord(key) !== undefined;
  }

  del(key) {
    return this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }

  keys() {
    const out = [];
    for (const [key, record] of this.#map) {
      if (isExpired(record)) { this.#map.delete(key); continue; }
      out.push(key);
    }
    return out;
  }

  destroy() {
    this.#map.clear();
  }
}

module.exports = { MemoryStore };
