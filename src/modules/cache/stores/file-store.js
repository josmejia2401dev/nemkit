'use strict';

const fs = require('fs');
const path = require('path');
const { CacheStore, isExpired } = require('./cache-store');

/**
 * @module cache/stores/FileStore
 *
 * Backend de cache persistente en un archivo JSON key-value:
 *   { "<key>": { "value": any, "expiresAt": number, "tags": string[] }, ... }
 *
 * - Carga el archivo al construir (descarta entradas expiradas).
 * - Mantiene una copia en memoria y escribe a disco de forma DEBOUNCED
 *   (writeDelayMs) para no golpear el disco en cada set.
 * - Infinity se serializa como null y se restaura como Infinity al leer.
 */
class FileStore extends CacheStore {
  #filePath;
  #map = new Map();
  #writeDelayMs;
  #writeTimer = null;
  #dirty = false;

  /**
   * @param {Object} options
   * @param {string} options.path — Ruta del archivo JSON de cache
   * @param {number} [options.writeDelayMs=250] — Debounce de escritura a disco (0 = síncrono)
   */
  constructor(options = {}) {
    super();
    if (!options.path) throw new Error('FileStore: options.path is required');
    this.#filePath = path.resolve(options.path);
    this.#writeDelayMs = options.writeDelayMs ?? 250;
    this.#loadFromDisk();
  }

  getRecord(key) {
    const record = this.#map.get(key);
    if (!record) return undefined;
    if (isExpired(record)) { this.#map.delete(key); this.#scheduleWrite(); return undefined; }
    return record;
  }

  setRecord(key, record) {
    this.#map.set(key, record);
    this.#scheduleWrite();
  }

  has(key) {
    return this.getRecord(key) !== undefined;
  }

  del(key) {
    const existed = this.#map.delete(key);
    if (existed) this.#scheduleWrite();
    return existed;
  }

  clear() {
    this.#map.clear();
    this.#scheduleWrite();
  }

  keys() {
    const out = [];
    let changed = false;
    for (const [key, record] of this.#map) {
      if (isExpired(record)) { this.#map.delete(key); changed = true; continue; }
      out.push(key);
    }
    if (changed) this.#scheduleWrite();
    return out;
  }

  /** Fuerza el volcado pendiente a disco (útil antes de shutdown). */
  flush() {
    if (this.#writeTimer) { clearTimeout(this.#writeTimer); this.#writeTimer = null; }
    if (this.#dirty) this.#writeToDisk();
  }

  destroy() {
    this.flush();
    this.#map.clear();
  }

  // --- Private ---

  #loadFromDisk() {
    try {
      if (!fs.existsSync(this.#filePath)) return;
      const raw = fs.readFileSync(this.#filePath, 'utf8');
      if (!raw.trim()) return;
      const obj = JSON.parse(raw);
      for (const [key, rec] of Object.entries(obj)) {
        const record = {
          value: rec.value,
          expiresAt: rec.expiresAt == null ? Infinity : rec.expiresAt,
          tags: Array.isArray(rec.tags) ? rec.tags : [],
        };
        if (!isExpired(record)) this.#map.set(key, record);
      }
    } catch {
      // Archivo corrupto o ilegible: empezamos con cache vacío en lugar de romper.
      this.#map.clear();
    }
  }

  #scheduleWrite() {
    this.#dirty = true;
    if (this.#writeDelayMs <= 0) { this.#writeToDisk(); return; }
    if (this.#writeTimer) return; // ya hay un flush programado
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.#writeToDisk();
    }, this.#writeDelayMs);
    if (this.#writeTimer.unref) this.#writeTimer.unref();
  }

  #writeToDisk() {
    try {
      fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
      const obj = {};
      for (const [key, record] of this.#map) {
        obj[key] = {
          value: record.value,
          expiresAt: record.expiresAt === Infinity ? null : record.expiresAt,
          tags: record.tags,
        };
      }
      // Escritura atómica: escribe a tmp y renombra.
      const tmp = `${this.#filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      fs.renameSync(tmp, this.#filePath);
      this.#dirty = false;
    } catch {
      // No romper la app si el disco falla; el cache en memoria sigue sirviendo.
    }
  }
}

module.exports = { FileStore };
