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
  skipPaths: ['/', '/health', '/ready'],
  rootEndpoint: true,
  appName: 'app',
  appVersion: null,
  environment: process.env.NODE_ENV ?? 'development',
};

/**
 * @param {Object} [options]
 * @param {string} [options.bodyLimit='10mb']
 * @param {number} [options.rateLimitWindowMs=900000]
 * @param {number} [options.rateLimitMax=100]
 * @param {string[]} [options.skipPaths]
 * @param {Object} [options.logger]
 * @param {boolean} [options.rootEndpoint=true] — mounts an informational GET / endpoint
 * @param {string} [options.appName='app'] — shown in the root endpoint
 * @param {string} [options.appVersion] — shown in the root endpoint
 * @param {string} [options.environment] — shown in the root endpoint (defaults to NODE_ENV)
 * @returns {import('express').Application}
 */
const createApp = (options = {}) => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const skipSet = new Set(opts.skipPaths);

  const app = express();

  // Informational root endpoint (health/liveness + build info).
  // Mounted early so it is not affected by rate limiting or auth downstream.
  if (opts.rootEndpoint) {
    app.get('/', (_req, res) => res.json({
      status: 'ok',
      app: opts.appName,
      version: opts.appVersion,
      environment: opts.environment,
      timestamp: new Date().toISOString(),
    }));
  }

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
