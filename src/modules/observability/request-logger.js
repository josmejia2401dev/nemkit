'use strict';

const { startRequestSample, endRequestSample } = require('./resource-metrics');

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

    const sample = startRequestSample();

    if (logStart) {
      logger.info?.('request.start', {
        event: 'request.start',
        method: req.method,
        path: req.originalUrl,
        requestId: req.requestId ?? null,
        userId: req.user?.id ?? null,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        timestamp: new Date().toISOString(),
      });
    }

    res.on('finish', () => {
      const metrics = endRequestSample(sample);
      const entry = {
        event: 'request.report',
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        requestId: req.requestId ?? null,
        userId: req.user?.id ?? null,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        responseTimeMs: metrics.responseTimeMs,
        cpuTimeMs: metrics.cpuTimeMs,
        memoryConsumedMb: metrics.memoryConsumedMb,
        totalMemoryConsumedMb: metrics.totalMemoryConsumedMb,
        timestamp: new Date().toISOString(),
      };

      const level = levelForStatus(res.statusCode);
      logger[level]?.('request.report', entry);
    });

    next();
  };
}

module.exports = { createRequestLogger };
