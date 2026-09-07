'use strict';

/**
 * @module cache/stores/CacheStore
 *
 * Contrato (Strategy) que deben cumplir todos los backends de cache.
 * Permite intercambiar memoria/archivo/otros sin cambiar el consumidor.
 *
 * Un "record" es la forma serializable de una entrada:
 *   { value: any, expiresAt: number, tags: string[] }
 *   - expiresAt: epoch ms (Infinity = sin expiración)
 *
 * Las subclases deben implementar todos los métodos.
 */
class CacheStore {
  /** @returns {{value:any,expiresAt:number,tags:string[]}|undefined} */
  getRecord(_key) { throw new Error('CacheStore.getRecord not implemented'); }

  /** @param {string} key @param {{value:any,expiresAt:number,tags:string[]}} record */
  setRecord(_key, _record) { throw new Error('CacheStore.setRecord not implemented'); }

  /** @returns {boolean} */
  has(_key) { throw new Error('CacheStore.has not implemented'); }

  /** @returns {boolean} */
  del(_key) { throw new Error('CacheStore.del not implemented'); }

  clear() { throw new Error('CacheStore.clear not implemented'); }

  /** @returns {string[]} keys activas */
  keys() { throw new Error('CacheStore.keys not implemented'); }

  /** Libera recursos (timers, file handles). Opcional. */
  destroy() { /* no-op por defecto */ }
}

const now = () => Date.now();
const isExpired = (record) => record.expiresAt !== Infinity && now() > record.expiresAt;

module.exports = { CacheStore, isExpired };
