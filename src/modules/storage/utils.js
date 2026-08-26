'use strict';

/**
 * @module storage/utils
 *
 * Helpers para servir archivos por HTTP con soporte Range.
 */

/**
 * Sirve un archivo desde cualquier storage (Disk o Memory) con soporte para:
 * - Content-Type automático
 * - Content-Length
 * - Range requests (streaming parcial para video/audio)
 * - Content-Disposition (inline o attachment)
 *
 * @param {Object} req — Express request
 * @param {Object} res — Express response
 * @param {DiskStorage|MemoryStorage} storage — Instancia de storage
 * @param {string} key — Key del archivo
 * @param {Object} [options]
 * @param {string} [options.disposition='inline'] — 'inline' | 'attachment'
 * @param {string} [options.filename] — Nombre para Content-Disposition
 */
const serveFile = (req, res, storage, key, options = {}) => {
  const disposition = options.disposition ?? 'inline';
  const metadata = storage.getMetadata(key);

  if (!metadata) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }

  const mime = metadata.mime ?? 'application/octet-stream';
  const totalSize = metadata.size;
  const filename = options.filename ?? metadata.originalName ?? key;

  // Range header parsing
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

    if (start >= totalSize || end >= totalSize || start > end) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      return res.sendStatus(416); // Range Not Satisfiable
    }

    const chunkSize = end - start + 1;
    const { stream } = storage.getStream(key, { start, end });

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Content-Type', mime);

    stream.pipe(res);
  } else {
    // Full file
    const { stream } = storage.getStream(key);

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', totalSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);

    stream.pipe(res);
  }
};

/**
 * Convierte un ReadableStream a Buffer.
 * @param {import('stream').Readable} stream
 * @returns {Promise<Buffer>}
 */
const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

module.exports = { serveFile, streamToBuffer };
