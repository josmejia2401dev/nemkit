'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const { StorageEngine } = require('./storage-engine');

const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.json': 'application/json',
  '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css',
  '.js': 'application/javascript', '.xml': 'application/xml',
  '.zip': 'application/zip', '.gz': 'application/gzip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
};

class DiskStorage extends StorageEngine {
  #basePath;
  #maxFileSize;

  /**
   * @param {Object} options
   * @param {string} options.basePath
   * @param {number} [options.maxFileSize=52428800]
   */
  constructor(options = {}) {
    super();
    if (!options.basePath) throw new Error('DiskStorage: basePath is required');
    this.#basePath = path.resolve(options.basePath);
    this.#maxFileSize = options.maxFileSize ?? 50 * 1024 * 1024;
    this.#ensureDir(this.#basePath);
  }

  async save(key, input, metadata = {}) {
    const filePath = this.#resolve(key);
    this.#ensureDir(path.dirname(filePath));

    let size;

    if (Buffer.isBuffer(input)) {
      if (input.length > this.#maxFileSize) {
        throw new Error(`DiskStorage: file exceeds max size (${this.#maxFileSize} bytes)`);
      }
      await fs.promises.writeFile(filePath, input);
      size = input.length;

    } else if (input instanceof Readable || (input && typeof input.pipe === 'function')) {
      size = await this.#writeStream(filePath, input);

    } else if (typeof input === 'string') {
      const stat = await fs.promises.stat(input);
      if (stat.size > this.#maxFileSize) {
        throw new Error(`DiskStorage: file exceeds max size (${this.#maxFileSize} bytes)`);
      }
      await fs.promises.copyFile(input, filePath);
      size = stat.size;

    } else {
      throw new Error('DiskStorage: input must be a Buffer, ReadableStream, or file path string');
    }

    const meta = {
      key,
      size,
      mime: metadata.mime ?? this.#detectMimeByExt(key),
      originalName: metadata.originalName ?? path.basename(key),
      createdAt: new Date().toISOString(),
      ...metadata,
    };
    await fs.promises.writeFile(filePath + '.meta.json', JSON.stringify(meta), 'utf8');

    return { ...meta, path: filePath };
  }

  getStream(key, options = {}) {
    const filePath = this.#resolve(key);
    if (!fs.existsSync(filePath)) throw new Error(`DiskStorage: file not found '${key}'`);

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
    const filePath = this.#resolve(key);
    if (!fs.existsSync(filePath)) throw new Error(`DiskStorage: file not found '${key}'`);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, metadata: this.#readMeta(filePath) };
  }

  getMetadata(key) {
    return this.#readMeta(this.#resolve(key));
  }

  exists(key) {
    return fs.existsSync(this.#resolve(key));
  }

  async delete(key) {
    const filePath = this.#resolve(key);
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
      });
  }

  // ─────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────

  #resolve(key) {
    const resolved = path.resolve(this.#basePath, key);
    if (!resolved.startsWith(this.#basePath)) {
      throw new Error('DiskStorage: directory traversal detected');
    }
    return resolved;
  }

  #ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  async #writeStream(filePath, readable) {
    let size = 0;
    const writable = fs.createWriteStream(filePath);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        this.push(chunk);
        cb();
      },
    });
    await pipeline(readable, counter, writable);
    if (size > this.#maxFileSize) {
      await fs.promises.unlink(filePath);
      throw new Error(`DiskStorage: file exceeds max size (${this.#maxFileSize} bytes)`);
    }
    return size;
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

module.exports = { DiskStorage, MIME_MAP };
