'use strict';

const { JwtManager } = require('./jwt-manager');
const { createAuthMiddleware, extractBearerToken } = require('./auth-middleware');
const { createCorsMiddleware } = require('./cors');
const { hashPassword, comparePassword, randomToken, sha256 } = require('./crypto');
const { RateLimiter, createRateLimiter } = require('./rate-limiter');

module.exports = {
  JwtManager,
  createAuthMiddleware,
  extractBearerToken,
  createCorsMiddleware,
  hashPassword,
  comparePassword,
  randomToken,
  sha256,
  RateLimiter,
  createRateLimiter,
};
