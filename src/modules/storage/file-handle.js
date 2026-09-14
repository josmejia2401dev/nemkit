'use strict';

const fs = require('fs');
const { Readable } = require('stream');
const { StorageEngine } = require('./storage-engine');

class FileHandle {
  #mode;
  #buffer;
  #tmpPath;
  #metadata;
  #discarded = false;

  /**
   * @param {Object} params
   * @param {'memory'|'chunked'} params.mode
   * @param {Buffer} [params.buffer] — solo modo memory
   * @param {string} [params.tmpPath] — solo modo chunked
   * @param {Object} params.metadata
   */
  constructor({ mode, buffer, tmpPath, metadata }) {
    this.#mode = mode;
    this.#buffer = buffer ?? null;
    this.#tmpPath = tmpPath ?? null;
    this.#metadata = { ...metadata };

    this.key = metadata.key;
    this.size = metadata.size;
    this.mime = metadata.mime;
    this.originalName = metadata.originalName;
    this.mode = mode;
    this.createdAt = metadata.createdAt;
  }

  /**
   * Readable desde staging. Soporta Range (start/end).
   * @param {Object} [options]
   * @param {number} [options.start]
   * @param {number} [options.end]
   * @returns {import('stream').Readable}
   */
  stream(options = {}) {
    this.#assertNotDiscarded();

    if (this.#mode === 'memory') {
      const start = options.start ?? 0;
      const end = options.end ?? this.#buffer.length - 1;
      return Readable.from(this.#buffer.subarray(start, end + 1));
    }

    const streamOpts = {};
    if (options.start !== undefined) streamOpts.start = options.start;
    if (options.end !== undefined) streamOpts.end = options.end;
    return fs.createReadStream(this.#tmpPath, streamOpts);
  }

  /**
   * Buffer completo desde staging.
   * @returns {Promise<Buffer>}
   */
  async buffer() {
    this.#assertNotDiscarded();
    if (this.#mode === 'memory') return this.#buffer;
    return fs.promises.readFile(this.#tmpPath);
  }

  /**
   * Mueve el archivo desde staging al destino final.
   *
   * @param {StorageEngine|Function} destination
   *   - StorageEngine: guarda via engine.save(key, stream, metadata)
   *   - async (info, readable) => result: para S3, GridFS, etc.
   * @returns {Promise<any>}
   */
  async commitTo(destination) {
    this.#assertNotDiscarded();

    const info = {
      key: this.key,
      size: this.size,
      mime: this.mime,
      originalName: this.originalName,
      mode: this.mode,
      createdAt: this.createdAt,
      ...(this.#tmpPath ? { tmpPath: this.#tmpPath } : {}),
    };

    if (typeof destination === 'function') {
      return destination(info, this.stream());
    }

    if (destination instanceof StorageEngine) {
      return destination.save(this.key, this.stream(), this.#metadata);
    }

    throw new Error('FileHandle.commitTo: destination must be a StorageEngine or async function');
  }

  /**
   * Limpia el staging (RAM o /tmp) sin mover el archivo.
   * @returns {Promise<void>}
   */
  async discard() {
    if (this.#discarded) return;
    this.#discarded = true;

    if (this.#mode === 'chunked' && this.#tmpPath) {
      try { await fs.promises.unlink(this.#tmpPath); } catch { /* ya eliminado */ }
    }

    this.#buffer = null;
  }

  // ─────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────

  #assertNotDiscarded() {
    if (this.#discarded) throw new Error('FileHandle: already discarded — cannot read after discard()');
  }
}

module.exports = { FileHandle };
