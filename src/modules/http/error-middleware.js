'use strict';

const { AppError, HttpError, DomainError, ValidationError } = require('./errors');
const { RequestContext } = require('../observability/request-context');

/**
 * @module http/error-middleware
 *
 * Middleware global de manejo de errores para Express.
 *
 * Clasifica errores automáticamente:
 * - HttpError        → status code del error (4xx/5xx)
 * - DomainError      → 422
 * - ValidationError  → 400 + array de errores
 * - MongoDB errors   → 409 (duplicate), 504 (timeout), 500 (generic)
 * - JWT errors       → 401
 * - SyntaxError      → 400 (JSON malformado)
 * - Unexpected       → 500
 *
 * En development incluye stack trace. En production mensaje genérico seguro.
 * Soporta callback onError para métricas, alertas, etc.
 * Usa RequestContext para obtener requestId automáticamente si req.requestId no está disponible.
 */

/**
 * @param {Object} [options]
 * @param {Object} [options.logger] — Logger con .warn(), .error(), .child()
 * @param {string} [options.environment='production'] — 'development' | 'production'
 * @param {Function} [options.onError] — Callback: (err, req, statusCode) => void (métricas, alerting)
 * @param {boolean} [options.logFullStack=false] — En production, loguear el stack completo internamente
 * @returns {Function} Express error middleware (err, req, res, next)
 */
const createErrorMiddleware = (options = {}) => {
  const { logger, environment = 'production', onError, logFullStack = false } = options;
  const isDev = environment === 'development';

  return (err, req, res, _next) => {
    if (res.headersSent) return;

    // requestId: primero de req, luego de RequestContext (AsyncLocalStorage)
    const requestId = req.requestId ?? RequestContext.getRequestId();

    const log = logger?.child?.({ requestId }) ?? console;

    const { statusCode, errorType, message, errors } = classifyError(err, isDev);

    // Logging — siempre incluir stack en logs internos
    const logMeta = {
      path: req.path,
      method: req.method,
      stack: err.stack ?? null,
    };

    if (statusCode >= 500) {
      log.error?.(`[${statusCode}] ${errorType}: ${err.message}`, logMeta);
    } else {
      log.warn?.(`[${statusCode}] ${errorType}: ${err.message}`, logMeta);
    }

    // Callback externo (métricas, alertas, Sentry, etc.)
    if (typeof onError === 'function') {
      try { onError(err, req, statusCode); } catch { /* onError must never break */ }
    }

    // Response
    const body = {
      success: false,
      error: errorType,
      message,
      errors: errors ?? null,
      metadata: { requestId },
    };

    return res.status(statusCode).json(body);
  };
};

/**
 * Clasifica un error y determina status code, tipo y mensaje.
 * @param {Error} err
 * @param {boolean} isDev
 * @returns {{ statusCode: number, errorType: string, message: string, errors: Array|null }}
 */
const classifyError = (err, isDev) => {
  // Errores de la app (isOperational = true)
  if (err instanceof HttpError) {
    return {
      statusCode: err.statusCode,
      errorType: 'HTTP Error',
      message: err.message,
      errors: null,
    };
  }

  if (err instanceof DomainError) {
    return {
      statusCode: 422,
      errorType: 'Domain Error',
      message: err.message,
      errors: null,
    };
  }

  if (err instanceof ValidationError) {
    return {
      statusCode: 400,
      errorType: 'Validation Error',
      message: err.message,
      errors: err.errors,
    };
  }

  // JSON parse error (body malformado)
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return {
      statusCode: 400,
      errorType: 'Parse Error',
      message: 'Invalid JSON in request body',
      errors: null,
    };
  }

  // Mongoose: ValidationError (schema validation failed)
  if (err.name === 'ValidationError' && err.errors && !(err instanceof ValidationError)) {
    return {
      statusCode: 400,
      errorType: 'Validation Error',
      message: 'Data validation failed',
      errors: null,
    };
  }

  // Mongoose: CastError (wrong type for a field)
  if (err.name === 'CastError') {
    return {
      statusCode: 400,
      errorType: 'Validation Error',
      message: 'Invalid data type provided',
      errors: null,
    };
  }

  // MongoDB: duplicate key (code 11000)
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'field';
    const value = err.keyValue?.[field] ?? '';
    return {
      statusCode: 409,
      errorType: 'Duplicate Key',
      message: `Value '${value}' already exists for field '${field}'`,
      errors: null,
    };
  }

  // MongoDB: timeout
  if (err.name === 'MongoTimeoutError' || err.name === 'MongoServerSelectionError') {
    return {
      statusCode: 504,
      errorType: 'Database Timeout',
      message: 'Database connection timed out',
      errors: null,
    };
  }

  // MongoDB: generic
  if (err.name?.startsWith('Mongo')) {
    return {
      statusCode: 500,
      errorType: 'Database Error',
      message: isDev ? err.message : 'Internal database error',
      errors: null,
    };
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return {
      statusCode: 401,
      errorType: 'Auth Error',
      message: 'Invalid token',
      errors: null,
    };
  }

  if (err.name === 'TokenExpiredError') {
    return {
      statusCode: 401,
      errorType: 'Auth Error',
      message: 'Token expired',
      errors: null,
    };
  }

  // Errores con statusCode custom (thrown manualmente)
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 600) {
    return {
      statusCode: err.statusCode,
      errorType: err.name ?? 'Error',
      message: err.message,
      errors: null,
    };
  }

  // Error inesperado (no operacional)
  return {
    statusCode: 500,
    errorType: 'Internal Server Error',
    message: isDev ? err.message : 'An unexpected error occurred',
    errors: null,
  };
};

module.exports = { createErrorMiddleware, classifyError };
