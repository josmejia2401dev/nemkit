'use strict';

const { Readable } = require('stream');

/**
 * @module storage/MemoryStorage
 *
 * Almacenamiento de archivos en memoria (RAM).
 * Misma interfaz que DiskStorage.
 *
 * Ideal para:
 * - Archivos temporales
 * - Procesamiento previo a persistir
 * - Testing
 * - Cache de archivos frecuentes
 *
 * Features:
 * - Límite de tamaño total configurable (evita OOM)
 * - Límite por archivo
 * - TTL opcional por entrada
 * - Range support (chunks de lectura)
 */

class MemoryStorage {
  #store = new Map();
  #maxFileSize;
  #maxTotalSize;
  #currentSize = 0;
  #defaultTtlMs;
  #cleanupTimer = null;

  /**
   * @param {Object} [options]
   * @param {number} [options.maxFileSize=52428800] — Máximo por archivo (default: 50MB)
   * @param {number} [options.maxTotalSize=209715200] — Máximo total en memoria (default: 200MB)
   * @param {number} [options.defaultTtlMs=0] — TTL por defecto (0 = sin expiración)
   * @param {number} [options.cleanupIntervalMs=60000] — Intervalo de limpieza de expirados
   */
  constructor(options = {}) {
    this.#maxFileSize = options.maxFileSize ?? 50 * 1024 * 1024;
    this.#maxTotalSize = options.maxTotalSize ?? 200 * 1024 * 1024;
    this.#defaultTtlMs = options.defaultTtlMs ?? 0;

    const cleanupInterval = options.cleanupIntervalMs ?? 60000;
    if (cleanupInterval > 0 && this.#defaultTtlMs > 0) {
      this.#startCleanup(cleanupInterval);
    }
  }

  /**
   * Guarda un archivo en memoria.
   * @param {string} key
   * @param {Buffer|Readable|string} input — Buffer, Stream, o string de contenido
   * @param {Object} [metadata] — { mime, originalName, ttlMs, ... }
   * @returns {Promise<{ key: string, size: number, mime: string, createdAt: string }>}
   */
  async save(key, input, metadata = {}) {
    let buffer;

    if (Buffer.isBuffer(input)) {
      buffer = input;
    } else if (input instanceof Readable || (input && typeof input.pipe === 'function')) {
      buffer = await this.#streamToBuffer(input);
    } else if (typeof input === 'string') {
      buffer = Buffer.from(input, 'utf8');
    } else {
      throw new Error('MemoryStorage: input must be a Buffer, ReadableStream, or string');
    }

    if (buffer.length > this.#maxFileSize) {
      throw new Error(`MemoryStorage: file exceeds max size (${this.#maxFileSize} bytes)`);
    }

    // Si ya existe, liberar espacio del anterior
    if (this.#store.has(key)) {
      this.#currentSize -= this.#store.get(key).buffer.length;
    }

    // Verificar espacio total
    if (this.#currentSize + buffer.length > this.#maxTotalSize) {
      throw new Error(`MemoryStorage: total storage limit exceeded (${this.#maxTotalSize} bytes)`);
    }

    const ttlMs = metadata.ttlMs ?? this.#defaultTtlMs;
    const entry = {
      buffer,
      metadata: {
        key,
        size: buffer.length,
        mime: metadata.mime ?? 'application/octet-stream',
        originalName: metadata.originalName ?? key,
        createdAt: new Date().toISOString(),
        ...metadata,
      },
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : Infinity,
    };

    this.#store.set(key, entry);
    this.#currentSize += buffer.length;

    return entry.metadata;
  }

  /**
   * Obtiene un archivo como ReadableStream.
   * Soporta Range (start/end).
   *
   * @param {string} key
   * @param {Object} [options]
   * @param {number} [options.start]
   * @param {number} [options.end]
   * @returns {{ stream: Readable, metadata: Object, size: number }}
   */
  getStream(key, options = {}) {
    const entry = this.#getEntry(key);
    if (!entry) throw new Error(`MemoryStorage: file not found '${key}'`);

    const start = options.start ?? 0;
    const end = options.end ?? entry.buffer.length - 1;
    const slice = entry.buffer.subarray(start, end + 1);
    const stream = Readable.from(slice);

    return {
      stream,
      metadata: entry.metadata,
      size: entry.buffer.length,
      start,
      end,
    };
  }

  /**
   * Obtiene el archivo completo como Buffer.
   * @param {string} key
   * @returns {{ buffer: Buffer, metadata: Object }|null}
   */
  getBuffer(key) {
    const entry = this.#getEntry(key);
    if (!entry) return null;
    return { buffer: entry.buffer, metadata: entry.metadata };
  }

  /**
   * Obtiene solo metadata.
   * @param {string} key
   * @returns {Object|null}
   */
  getMetadata(key) {
    const entry = this.#getEntry(key);
    return entry?.metadata ?? null;
  }

  /**
   * Verifica si existe (y no está expirado).
   * @param {string} key
   * @returns {boolean}
   */
  exists(key) {
    return this.#getEntry(key) !== null;
  }

  /**
   * Elimina un archivo.
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    const entry = this.#store.get(key);
    if (!entry) return false;
    this.#currentSize -= entry.buffer.length;
    this.#store.delete(key);
    return true;
  }

  /**
   * Lista keys por prefijo.
   * @param {string} [prefix='']
   * @returns {string[]}
   */
  list(prefix = '') {
    const keys = [];
    for (const [key, entry] of this.#store) {
      if (key.startsWith(prefix) && !this.#isExpired(entry)) {
        keys.push(key);
      }
    }
    return keys;
  }

  /**
   * Limpia todo.
   */
  clear() {
    this.#store.clear();
    this.#currentSize = 0;
  }

  /**
   * Stats actuales.
   */
  getStats() {
    return {
      fileCount: this.#store.size,
      currentSize: this.#currentSize,
      maxTotalSize: this.#maxTotalSize,
      usagePercent: +((this.#currentSize / this.#maxTotalSize) * 100).toFixed(2),
    };
  }

  /**
   * Detiene cleanup timer.
   */
  destroy() {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
    this.clear();
  }

  // ═══════════════════════════════════════════════════════
  // Private
  // ═══════════════════════════════════════════════════════

  #getEntry(key) {
    const entry = this.#store.get(key);
    if (!entry) return null;
    if (this.#isExpired(entry)) {
      this.delete(key);
      return null;
    }
    return entry;
  }

  #isExpired(entry) {
    return Date.now() > entry.expiresAt;
  }

  async #streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  #startCleanup(intervalMs) {
    this.#cleanupTimer = setInterval(() => {
      for (const [key, entry] of this.#store) {
        if (this.#isExpired(entry)) this.delete(key);
      }
    }, intervalMs);
    if (this.#cleanupTimer.unref) this.#cleanupTimer.unref();
  }
}

module.exports = { MemoryStorage };
