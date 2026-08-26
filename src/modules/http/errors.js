'use strict';

class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code ?? 'APP_ERROR';
    this.isOperational = options.isOperational ?? true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class HttpError extends AppError {
  constructor(statusCode, message, options = {}) {
    super(message, { code: options.code ?? 'HTTP_ERROR', isOperational: true });
    this.statusCode = statusCode;
  }
  static badRequest(msg = 'Bad Request') { return new HttpError(400, msg); }
  static unauthorized(msg = 'Unauthorized') { return new HttpError(401, msg); }
  static forbidden(msg = 'Forbidden') { return new HttpError(403, msg); }
  static notFound(msg = 'Not Found') { return new HttpError(404, msg); }
  static conflict(msg = 'Conflict') { return new HttpError(409, msg); }
  static internal(msg = 'Internal Server Error') { return new HttpError(500, msg); }
}

class DomainError extends AppError {
  constructor(message, code = 'DOMAIN_ERROR') {
    super(message, { code, isOperational: true });
    this.statusCode = 422;
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', errors = []) {
    super(message, { code: 'VALIDATION_ERROR', isOperational: true });
    this.statusCode = 400;
    this.errors = errors;
  }
}

module.exports = { AppError, HttpError, DomainError, ValidationError };
