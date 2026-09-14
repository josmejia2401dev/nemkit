'use strict';

const { startSample, endSample } = require('../system');

const DEFAULT_SKIP_PATHS = new Set(['/', '/health', '/ready', '/favicon.ico']);

function levelForStatus(statusCode) {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

function createRequestLogger(options = {}) {
  const logger = options.logger ?? console;
  const enabled = options.enabled !== false;
  const logStart = options.logStart !== false;
  const skipPaths = new Set(options.skipPaths ?? DEFAULT_SKIP_PATHS);

  return function requestLogger(req, res, next) {
    if (!enabled || skipPaths.has(req.path)) return next();

    const sample = startSample();
    const bytesIn = Number(req.headers['content-length'] || 0);

    if (logStart) {
      logger.info?.('request.start', {
        event: 'request.start',
        requestId: req.requestId ?? null,
        method: req.method,
        path: req.originalUrl,
        userId: req.user?.id ?? null,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        bytesIn,
        initialMemoryRssMb: sample.initialRssMb,
        timestamp: new Date().toISOString(),
      });
    }

    res.on('finish', () => {
      const metrics = endSample(sample);
      const bytesOut = Number(res.getHeader('content-length') || 0);

      const entry = {
        event: 'request.report',
        requestId: req.requestId ?? null,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        userId: req.user?.id ?? null,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        durationMs: metrics.durationMs,
        responseTimeMs: metrics.responseTimeMs,
        cpuTimeMs: metrics.cpuTimeMs,
        memoryConsumedMb: metrics.memoryConsumedMb,
        maxMemoryMb: metrics.maxMemoryMb,
        totalMemoryConsumedMb: metrics.totalMemoryConsumedMb,
        bytesIn,
        bytesOut,
        timestamp: new Date().toISOString(),
      };

      const level = levelForStatus(res.statusCode);
      logger[level]?.('request.report', entry);
    });

    next();
  };
}

module.exports = { createRequestLogger };
