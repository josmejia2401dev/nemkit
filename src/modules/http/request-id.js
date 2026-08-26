'use strict';

const { UniqueNumberUtil } = require('../helpers/unique-number.util');

const HEADER = 'X-Request-ID';
const HEADER_KEY = 'x-request-id';

/**
 * Middleware que genera o reutiliza un request ID (ULID).
 * Si el cliente lo envía en X-Request-ID, lo respeta.
 * Si no, genera uno nuevo.
 */
const requestIdMiddleware = (req, res, next) => {
  const requestId = req.headers[HEADER_KEY] || UniqueNumberUtil.ulid();

  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader(HEADER, requestId);

  next();
};

module.exports = { requestIdMiddleware };
