'use strict';

const express = require('express');
const { createRateLimiter } = require('../security/rate-limiter');

/**
 * @module core/createApp
 *
 * Factory que construye una instancia Express pre-configurada con:
 * - Security headers (nativo)
 * - JSON/URL body parsing con límites
 * - HTTP request logging (logger propio)
 * - Rate limiting (propio)
 */

const DEFAULT_OPTIONS = {
  bodyLimit: '10mb',
  rateLimitWindowMs: 900000,
  rateLimitMax: 100,
  skipPaths: ['/health', '/ready'],
};

/**
 * @param {Object} [options]
 * @param {string} [options.bodyLimit='10mb']
 * @param {number} [options.rateLimitWindowMs=900000]
 * @param {number} [options.rateLimitMax=100]
 * @param {string[]} [options.skipPaths]
 * @param {Object} [options.logger]
 * @returns {import('express').Application}
 */
const createApp = (options = {}) => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const skipSet = new Set(opts.skipPaths);

  const app = express();

  // Security headers (nativo, sin helmet)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Download-Options', 'noopen');
    res.removeHeader('X-Powered-By');
    next();
  });

  // Body parsing
  app.use(express.json({ limit: opts.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: opts.bodyLimit }));

  // HTTP request logging
  if (opts.logger) {
    app.use((req, res, next) => {
      if (skipSet.has(req.path)) return next();

      const start = process.hrtime.bigint();

      res.on('finish', () => {
        const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
        opts.logger.http(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
      });

      next();
    });
  }

  // Rate limiting (propio)
  const limiter = createRateLimiter({
    windowMs: opts.rateLimitWindowMs,
    max: opts.rateLimitMax,
    skipPaths: opts.skipPaths,
  });
  app.use(limiter.middleware());

  return app;
};

module.exports = { createApp };
