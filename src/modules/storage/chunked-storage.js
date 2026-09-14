'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { StorageEngine } = require('./storage-engine');
const { MIME_MAP } = require('./disk-storage');

class ChunkedDiskStorage extends StorageEngine {
  #basePath;
  #chunksDir;
  #maxFileSize;

  constructor(options = {}) {
    super();
    if (!options.basePath) throw new Error('ChunkedDiskStorage: basePath is required');
    this.#basePath = path.resolve(options.basePath);
    this.#chunksDir = path.resolve(options.chunksDir ?? path.join(this.#basePath, '.chunks'));
    this.#maxFileSize = options.maxFileSize ?? 100 * 1024 * 1024;
    this.#ensureDir(this.#basePath);
    this.#ensureDir(this.#chunksDir);
  }

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
      const writable = fs.createWriteStream(chunkPath);
      await pipeline(input, writable);
      size = (await fs.promises.stat(chunkPath)).size;
    } else {
      throw new Error('ChunkedDiskStorage: chunk input must be a Buffer or ReadableStream');
    }
    return { uploadId, chunkIndex: safeIndex, size, received: true };
  }

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
   * Ensamblado optimizado usando pipeline sin saturación de memoria.
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

    const filePath = this.#resolveFinal(manifest.key);
    this.#ensureDir(path.dirname(filePath));
    const writeStream = fs.createWriteStream(filePath);

    for (const idx of status.receivedChunks) {
      const chunkPath = path.join(uploadDir, `part-${String(idx).padStart(6, '0')}.part`);
      const readStream = fs.createReadStream(chunkPath);
      await pipeline(readStream, writeStream, { end: false });
    }
    writeStream.end();

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

  async abortChunkUpload(uploadId) {
    const uploadDir = this.#resolveUploadDir(uploadId);
    if (fs.existsSync(uploadDir)) {
      await fs.promises.rm(uploadDir, { recursive: true, force: true });
    }
    return { uploadId, aborted: true };
  }

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