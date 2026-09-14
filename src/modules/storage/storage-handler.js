'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { FileHandle } = require('./file-handle');
const { MIME_MAP } = require('./disk-storage');

const DEFAULT_MEMORY_LIMIT_BYTES = 500 * 1024;        // 500 KB
const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_TTL_MS = 30 * 60 * 1000;               // 30 min

class StorageHandler {
  #tmpDir;
  #memoryLimit;
  #maxFileSize;
  #ttlMs;

  #memoryStore = new Map();    // key → { buffer, metadata, expiresAt }
  #chunkSessions = new Map();  // uploadId → { key, uploadDir, manifest, expiresAt }
  #assembledFiles = new Map(); // ref → { tmpPath, expiresAt }

  /**
   * @param {Object} [options]
   * @param {string} [options.tmpDir] — Directorio temporal (default: os.tmpdir()/nemkit-storage)
   * @param {number} [options.memoryLimit=512000] — Umbral RAM en bytes
   * @param {number} [options.maxFileSize=104857600] — Límite hard de tamaño
   * @param {number} [options.ttlMs=1800000] — TTL del staging si no se hace commitTo/discard
   */
  constructor(options = {}) {
    this.#tmpDir = path.resolve(options.tmpDir ?? path.join(os.tmpdir(), 'nemkit-storage'));
    this.#memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT_BYTES;
    this.#maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE_BYTES;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#ensureDir(this.#tmpDir);
    this.#ensureDir(path.join(this.#tmpDir, 'chunks'));
  }

  // ─────────────────────────────────────────────
  // Camino A: Recepción directa (Buffer | Readable | path)
  // → Pequeño (<memoryLimit): staging en RAM
  // → Grande (≥memoryLimit): staging en /tmp
  // ─────────────────────────────────────────────

  /**
   * Recibe un archivo completo y devuelve un FileHandle desde staging.
   * @param {Buffer|import('stream').Readable|string} input
   * @param {Object} [options]
   * @param {string} [options.key]
   * @param {string} [options.mime]
   * @param {string} [options.originalName]
   * @returns {Promise<FileHandle>}
   */
  async receive(input, options = {}) {
    const buffer = await this.#toBuffer(input);

    if (buffer.length > this.#maxFileSize) {
      throw new Error(`StorageHandler: file exceeds max size (${this.#maxFileSize} bytes)`);
    }

    const key = options.key ?? crypto.randomUUID();
    const metadata = {
      key,
      size: buffer.length,
      mime: options.mime ?? this.#detectMimeByExt(options.originalName ?? key),
      originalName: options.originalName ?? key,
      createdAt: new Date().toISOString(),
    };

    if (buffer.length < this.#memoryLimit) {
      this.#memoryStore.set(key, { buffer, metadata, expiresAt: Date.now() + this.#ttlMs });
      return new FileHandle({ mode: 'memory', buffer, metadata });
    }

    const tmpPath = path.join(this.#tmpDir, `${key}.tmp`);
    await fs.promises.writeFile(tmpPath, buffer);
    this.#assembledFiles.set(key, { tmpPath, expiresAt: Date.now() + this.#ttlMs });

    return new FileHandle({ mode: 'chunked', tmpPath, metadata });
  }

  // ─────────────────────────────────────────────
  // Camino B: Multipart / Chunk upload
  // → Cada chunk se guarda en /tmp/chunks/<uploadId>/
  // → complete() ensambla en /tmp/<uploadId>.assembled → FileHandle
  // ─────────────────────────────────────────────

  /**
   * Inicia una sesión de subida fragmentada.
   * @param {Object} [options]
   * @param {string} [options.key]
   * @param {string} [options.originalName]
   * @param {string} [options.mime]
   * @param {number} [options.totalChunks]
   * @param {number} [options.totalSize]
   * @returns {Promise<{ uploadId: string, key: string, totalChunks: number }>}
   */
  async initChunkUpload(options = {}) {
    const uploadId = crypto.randomUUID();
    const key = options.key ?? options.originalName ?? uploadId;
    const uploadDir = path.join(this.#tmpDir, 'chunks', uploadId);
    await fs.promises.mkdir(uploadDir, { recursive: true });

    const manifest = {
      uploadId,
      key,
      totalChunks: Math.max(0, Number(options.totalChunks) || 0),
      totalSize: options.totalSize ? Number(options.totalSize) : null,
      mime: options.mime ?? this.#detectMimeByExt(key),
      originalName: options.originalName ?? key,
      createdAt: new Date().toISOString(),
    };

    await fs.promises.writeFile(
      path.join(uploadDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    this.#chunkSessions.set(uploadId, {
      key,
      uploadDir,
      manifest,
      expiresAt: Date.now() + this.#ttlMs,
    });

    return { uploadId, key, totalChunks: manifest.totalChunks };
  }

  /**
   * Guarda un chunk individual en /tmp.
   * @param {string} uploadId
   * @param {number} chunkIndex — Base 0
   * @param {Buffer|import('stream').Readable} input
   * @returns {Promise<{ uploadId: string, chunkIndex: number, size: number, received: boolean }>}
   */
  async receiveChunk(uploadId, chunkIndex, input) {
    const session = this.#chunkSessions.get(uploadId);
    if (!session) throw new Error(`StorageHandler: chunk session '${uploadId}' not found`);

    const safeIndex = parseInt(chunkIndex, 10);
    if (Number.isNaN(safeIndex) || safeIndex < 0) {
      throw new Error('StorageHandler: chunkIndex must be a non-negative integer');
    }

    const chunkPath = path.join(session.uploadDir, `part-${String(safeIndex).padStart(6, '0')}.part`);
    let size = 0;

    if (Buffer.isBuffer(input)) {
      await fs.promises.writeFile(chunkPath, input);
      size = input.length;
    } else if (input && typeof input.pipe === 'function') {
      const writable = fs.createWriteStream(chunkPath);
      await pipeline(input, writable);
      size = (await fs.promises.stat(chunkPath)).size;
    } else {
      throw new Error('StorageHandler: chunk input must be a Buffer or Readable');
    }

    session.expiresAt = Date.now() + this.#ttlMs;

    return { uploadId, chunkIndex: safeIndex, size, received: true };
  }

  /**
   * Estado actual de una sesión de chunks (útil para reanudación).
   * @param {string} uploadId
   * @returns {Promise<{ uploadId: string, key: string, totalChunks: number, receivedChunks: number[], isComplete: boolean }>}
   */
  async getChunkStatus(uploadId) {
    const session = this.#chunkSessions.get(uploadId);
    if (!session) throw new Error(`StorageHandler: chunk session '${uploadId}' not found`);

    const files = await fs.promises.readdir(session.uploadDir);
    const receivedChunks = files
      .filter((f) => /^part-\d+\.part$/.test(f))
      .map((f) => parseInt(f.replace(/^part-/, '').replace(/\.part$/, ''), 10))
      .sort((a, b) => a - b);

    return {
      uploadId,
      key: session.key,
      totalChunks: session.manifest.totalChunks,
      receivedChunks,
      isComplete: session.manifest.totalChunks > 0 && receivedChunks.length === session.manifest.totalChunks,
    };
  }

  /**
   * Ensambla los chunks en /tmp sin cargar todo en RAM.
   * Devuelve un FileHandle listo para .stream(), .buffer() o .commitTo().
   * @param {string} uploadId
   * @returns {Promise<FileHandle>}
   */
  async complete(uploadId) {
    const session = this.#chunkSessions.get(uploadId);
    if (!session) throw new Error(`StorageHandler: chunk session '${uploadId}' not found`);

    const status = await this.getChunkStatus(uploadId);
    const { totalChunks, manifest } = session;

    if (manifest.totalChunks > 0 && status.receivedChunks.length !== manifest.totalChunks) {
      throw new Error(
        `StorageHandler: missing chunks (${status.receivedChunks.length}/${manifest.totalChunks} received)`
      );
    }

    for (let i = 0; i < status.receivedChunks.length; i++) {
      if (status.receivedChunks[i] !== i) {
        throw new Error(`StorageHandler: missing chunk at sequence index ${i}`);
      }
    }

    const tmpPath = path.join(this.#tmpDir, `${uploadId}.assembled`);
    const writeStream = fs.createWriteStream(tmpPath);

    for (const idx of status.receivedChunks) {
      const chunkPath = path.join(session.uploadDir, `part-${String(idx).padStart(6, '0')}.part`);
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath);
        readStream.on('error', reject);
        readStream.on('end', resolve);
        readStream.pipe(writeStream, { end: false });
      });
    }

    writeStream.end();
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const stat = await fs.promises.stat(tmpPath);

    if (stat.size > this.#maxFileSize) {
      await fs.promises.unlink(tmpPath);
      await fs.promises.rm(session.uploadDir, { recursive: true, force: true });
      this.#chunkSessions.delete(uploadId);
      throw new Error(`StorageHandler: assembled file exceeds max size (${this.#maxFileSize} bytes)`);
    }

    await fs.promises.rm(session.uploadDir, { recursive: true, force: true });
    this.#chunkSessions.delete(uploadId);

    const metadata = {
      key: session.key,
      size: stat.size,
      mime: manifest.mime,
      originalName: manifest.originalName,
      createdAt: new Date().toISOString(),
    };

    this.#assembledFiles.set(uploadId, { tmpPath, expiresAt: Date.now() + this.#ttlMs });

    return new FileHandle({ mode: 'chunked', tmpPath, metadata });
  }

  /**
   * Cancela la sesión y elimina los chunks temporales.
   * @param {string} uploadId
   * @returns {Promise<{ uploadId: string, aborted: boolean }>}
   */
  async abortChunkUpload(uploadId) {
    const session = this.#chunkSessions.get(uploadId);
    if (session) {
      await fs.promises.rm(session.uploadDir, { recursive: true, force: true });
      this.#chunkSessions.delete(uploadId);
    }
    return { uploadId, aborted: true };
  }

  // ─────────────────────────────────────────────
  // Mantenimiento
  // ─────────────────────────────────────────────

  /**
   * Elimina entradas de staging expiradas (RAM + /tmp).
   * @returns {Promise<number>} — Cantidad de entradas purgadas
   */
  async cleanupExpiredStaging() {
    const now = Date.now();
    let purged = 0;

    for (const [key, entry] of this.#memoryStore) {
      if (now > entry.expiresAt) { this.#memoryStore.delete(key); purged++; }
    }

    for (const [ref, entry] of this.#assembledFiles) {
      if (now > entry.expiresAt) {
        try { await fs.promises.unlink(entry.tmpPath); } catch { /* ok */ }
        this.#assembledFiles.delete(ref);
        purged++;
      }
    }

    for (const [uploadId, session] of this.#chunkSessions) {
      if (now > session.expiresAt) {
        try { await fs.promises.rm(session.uploadDir, { recursive: true, force: true }); } catch { /* ok */ }
        this.#chunkSessions.delete(uploadId);
        purged++;
      }
    }

    return purged;
  }

  /**
   * Estadísticas actuales del handler.
   * @returns {{ memoryFiles: number, memoryUsedBytes: number, activeSessions: number, assembledFiles: number }}
   */
  getStats() {
    let memoryUsedBytes = 0;
    for (const entry of this.#memoryStore.values()) {
      memoryUsedBytes += entry.buffer.length;
    }
    return {
      memoryFiles: this.#memoryStore.size,
      memoryUsedBytes,
      activeSessions: this.#chunkSessions.size,
      assembledFiles: this.#assembledFiles.size,
    };
  }

  // ─────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────

  #ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  async #toBuffer(input) {
    if (Buffer.isBuffer(input)) return input;
    if (typeof input === 'string') return fs.promises.readFile(input);
    if (input && typeof input.pipe === 'function') {
      const chunks = [];
      for await (const chunk of input) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    throw new Error('StorageHandler: input must be a Buffer, Readable, or file path');
  }

  #detectMimeByExt(name = '') {
    return MIME_MAP[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
  }
}

const createStorageHandler = (options) => new StorageHandler(options);

module.exports = { StorageHandler, createStorageHandler };
