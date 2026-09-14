'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StorageEngine } = require('./storage-engine');
const { MIME_MAP } = require('./disk-storage');

class ChunkedDiskStorage extends StorageEngine {
  #basePath;
  #chunksDir;
  #maxFileSize;

  /**
   * @param {Object} options
   * @param {string} options.basePath — Directorio raíz donde se ensambla el archivo final
   * @param {string} [options.chunksDir] — Directorio temporal para staging de chunks (default: <basePath>/.chunks)
   * @param {number} [options.maxFileSize=104857600] — Tamaño máximo ensamblado (default: 100MB)
   */
  constructor(options = {}) {
    super();
    if (!options.basePath) throw new Error('ChunkedDiskStorage: basePath is required');
    this.#basePath = path.resolve(options.basePath);
    this.#chunksDir = path.resolve(options.chunksDir ?? path.join(this.#basePath, '.chunks'));
    this.#maxFileSize = options.maxFileSize ?? 100 * 1024 * 1024;
    this.#ensureDir(this.#basePath);
    this.#ensureDir(this.#chunksDir);
  }

  // ─────────────────────────────────────────────
  // StorageEngine contract (no-op / redirect para carga completa de una sola vez)
  // ─────────────────────────────────────────────

  async save(_key, _input, _metadata = {}) {
    throw new Error('ChunkedDiskStorage: use initChunkUpload/saveChunk/completeChunkUpload instead of save()');
  }

  getStream(key, options = {}) {
    const filePath = this.#resolveFinal(key);
    if (!fs.existsSync(filePath)) throw new Error(`ChunkedDiskStorage: file not found '${key}'`);
    const stat = fs.statSync(filePath);
    const streamOpts = {};
    if (options.start !== undefined) streamOpts.start = options.start;
    if (options.end !== undefined) streamOpts.end = options.end;
    return {
      stream: fs.createReadStream(filePath, streamOpts),
      metadata: this.#readMeta(filePath),
      size: stat.size,
      start: streamOpts.start ?? 0,
      end: streamOpts.end ?? stat.size - 1,
    };
  }

  async getBuffer(key) {
    const filePath = this.#resolveFinal(key);
    if (!fs.existsSync(filePath)) throw new Error(`ChunkedDiskStorage: file not found '${key}'`);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, metadata: this.#readMeta(filePath) };
  }

  getMetadata(key) {
    return this.#readMeta(this.#resolveFinal(key));
  }

  exists(key) {
    return fs.existsSync(this.#resolveFinal(key));
  }

  async delete(key) {
    const filePath = this.#resolveFinal(key);
    if (!fs.existsSync(filePath)) return false;
    await fs.promises.unlink(filePath);
    try { await fs.promises.unlink(filePath + '.meta.json'); } catch { /* no meta */ }
    return true;
  }

  async list(prefix = '') {
    const dir = path.join(this.#basePath, prefix);
    if (!fs.existsSync(dir)) return [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && !e.name.endsWith('.meta.json'))
      .map((e) => {
        const relative = path.relative(this.#basePath, path.join(e.parentPath ?? e.path, e.name));
        return relative.replace(/\\/g, '/');
      })
      .filter((rel) => !rel.startsWith('.chunks/'));
  }

  // ─────────────────────────────────────────────
  // Chunk Upload API
  // ─────────────────────────────────────────────

  /**
   * Inicia una sesión de subida por chunks.
   * @param {string} key — Ruta destino relativa del archivo ensamblado
   * @param {Object} [options]
   * @param {number} [options.totalChunks=0]
   * @param {number} [options.totalSize]
   * @param {string} [options.mime]
   * @param {string} [options.originalName]
   * @param {Object} [options.metadata]
   * @returns {Promise<{ uploadId: string, key: string, totalChunks: number }>}
   */
  async initChunkUpload(key, options = {}) {
    const uploadId = crypto.randomUUID();
    const uploadDir = this.#resolveUploadDir(uploadId);
    await fs.promises.mkdir(uploadDir, { recursive: true });

    const manifest = {
      uploadId,
      key,
      totalChunks: Math.max(0, Number(options.totalChunks) || 0),
      totalSize: options.totalSize ? Number(options.totalSize) : null,
      mime: options.mime ?? this.#detectMimeByExt(key),
      originalName: options.originalName ?? path.basename(key),
      createdAt: new Date().toISOString(),
      metadata: options.metadata ?? {},
    };

    await fs.promises.writeFile(
      path.join(uploadDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    return { uploadId, key, totalChunks: manifest.totalChunks };
  }

  /**
   * Guarda un chunk individual en disco.
   * @param {string} uploadId
   * @param {number} chunkIndex — Índice base 0
   * @param {Buffer|import('stream').Readable} input
   * @returns {Promise<{ uploadId: string, chunkIndex: number, size: number, received: boolean }>}
   */
  async saveChunk(uploadId, chunkIndex, input) {
    const uploadDir = this.#resolveUploadDir(uploadId);
    if (!fs.existsSync(uploadDir)) {
      throw new Error(`ChunkedDiskStorage: upload session '${uploadId}' not found`);
    }

    const safeIndex = parseInt(chunkIndex, 10);
    if (Number.isNaN(safeIndex) || safeIndex < 0) {
      throw new Error('ChunkedDiskStorage: chunkIndex must be a non-negative integer');
    }

    const chunkPath = path.join(uploadDir, `part-${String(safeIndex).padStart(6, '0')}.part`);
    let size = 0;

    if (Buffer.isBuffer(input)) {
      await fs.promises.writeFile(chunkPath, input);
      size = input.length;
    } else if (input && typeof input.pipe === 'function') {
      const { pipeline } = require('stream/promises');
      const writable = fs.createWriteStream(chunkPath);
      await pipeline(input, writable);
      size = (await fs.promises.stat(chunkPath)).size;
    } else {
      throw new Error('ChunkedDiskStorage: chunk input must be a Buffer or ReadableStream');
    }

    return { uploadId, chunkIndex: safeIndex, size, received: true };
  }

  /**
   * Consulta los chunks recibidos para una sesión (útil para reanudación).
   * @param {string} uploadId
   * @returns {Promise<{ uploadId: string, key: string, totalChunks: number, receivedChunks: number[], isComplete: boolean }>}
   */
  async getChunkUploadStatus(uploadId) {
    const uploadDir = this.#resolveUploadDir(uploadId);
    if (!fs.existsSync(uploadDir)) {
      throw new Error(`ChunkedDiskStorage: upload session '${uploadId}' not found`);
    }

    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(uploadDir, 'manifest.json'), 'utf8')
    );

    const files = await fs.promises.readdir(uploadDir);
    const receivedChunks = files
      .filter((f) => /^part-\d+\.part$/.test(f))
      .map((f) => parseInt(f.replace(/^part-/, '').replace(/\.part$/, ''), 10))
      .sort((a, b) => a - b);

    const isComplete =
      manifest.totalChunks > 0 && receivedChunks.length === manifest.totalChunks;

    return { uploadId, key: manifest.key, totalChunks: manifest.totalChunks, receivedChunks, isComplete };
  }

  /**
   * Ensambla todos los chunks en el archivo final sin cargar el contenido completo en RAM.
   *
   * @param {string} uploadId
   * @param {Object} [options]
   * @param {Function} [options.onComplete] — Hook async ejecutado tras ensamblar: async (fileInfo) => void
   *   Útil para reenviar a S3, MongoDB GridFS, etc., antes de confirmar al cliente.
   * @returns {Promise<{ key: string, size: number, mime: string, path: string, createdAt: string }>}
   */
  async completeChunkUpload(uploadId, options = {}) {
    const uploadDir = this.#resolveUploadDir(uploadId);
    if (!fs.existsSync(uploadDir)) {
      throw new Error(`ChunkedDiskStorage: upload session '${uploadId}' not found`);
    }

    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(uploadDir, 'manifest.json'), 'utf8')
    );
    const status = await this.getChunkUploadStatus(uploadId);

    if (manifest.totalChunks > 0 && status.receivedChunks.length !== manifest.totalChunks) {
      throw new Error(
        `ChunkedDiskStorage: missing chunks (${status.receivedChunks.length}/${manifest.totalChunks} received)`
      );
    }

    for (let i = 0; i < status.receivedChunks.length; i++) {
      if (status.receivedChunks[i] !== i) {
        throw new Error(`ChunkedDiskStorage: missing chunk sequence at index ${i}`);
      }
    }

    const filePath = this.#resolveFinal(manifest.key);
    this.#ensureDir(path.dirname(filePath));

    const writeStream = fs.createWriteStream(filePath);
    for (const idx of status.receivedChunks) {
      const chunkPath = path.join(uploadDir, `part-${String(idx).padStart(6, '0')}.part`);
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

    const stat = await fs.promises.stat(filePath);
    if (stat.size > this.#maxFileSize) {
      await fs.promises.unlink(filePath);
      await this.abortChunkUpload(uploadId);
      throw new Error(`ChunkedDiskStorage: assembled file exceeds max size (${this.#maxFileSize} bytes)`);
    }

    const meta = {
      key: manifest.key,
      size: stat.size,
      mime: manifest.mime,
      originalName: manifest.originalName,
      createdAt: new Date().toISOString(),
      ...manifest.metadata,
    };
    await fs.promises.writeFile(filePath + '.meta.json', JSON.stringify(meta), 'utf8');
    await fs.promises.rm(uploadDir, { recursive: true, force: true });

    const fileInfo = { ...meta, path: filePath };

    if (typeof options.onComplete === 'function') {
      await options.onComplete(fileInfo);
    }

    return fileInfo;
  }

  /**
   * Cancela y elimina los fragmentos temporales de una sesión.
   * @param {string} uploadId
   * @returns {Promise<{ uploadId: string, aborted: boolean }>}
   */
  async abortChunkUpload(uploadId) {
    const uploadDir = this.#resolveUploadDir(uploadId);
    if (fs.existsSync(uploadDir)) {
      await fs.promises.rm(uploadDir, { recursive: true, force: true });
    }
    return { uploadId, aborted: true };
  }

  /**
   * Elimina sesiones huérfanas más antiguas que maxAgeMs.
   * @param {number} [maxAgeMs=86400000] — Default: 24 horas
   * @returns {Promise<number>} — Cantidad de sesiones purgadas
   */
  async cleanupStaleChunks(maxAgeMs = 24 * 60 * 60 * 1000) {
    if (!fs.existsSync(this.#chunksDir)) return 0;
    const entries = await fs.promises.readdir(this.#chunksDir, { withFileTypes: true });
    const now = Date.now();
    let purged = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullDir = path.join(this.#chunksDir, entry.name);
      try {
        const stat = await fs.promises.stat(fullDir);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.promises.rm(fullDir, { recursive: true, force: true });
          purged++;
        }
      } catch { /* eliminado concurrentemente */ }
    }
    return purged;
  }

  // ─────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────

  #resolveFinal(key) {
    const resolved = path.resolve(this.#basePath, key);
    if (!resolved.startsWith(this.#basePath)) {
      throw new Error('ChunkedDiskStorage: directory traversal detected');
    }
    return resolved;
  }

  #resolveUploadDir(uploadId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(uploadId)) {
      throw new Error('ChunkedDiskStorage: invalid uploadId format');
    }
    return path.join(this.#chunksDir, uploadId);
  }

  #ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  #readMeta(filePath) {
    const metaPath = filePath + '.meta.json';
    if (!fs.existsSync(metaPath)) return null;
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
  }

  #detectMimeByExt(key) {
    return MIME_MAP[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
  }
}

module.exports = { ChunkedDiskStorage };
