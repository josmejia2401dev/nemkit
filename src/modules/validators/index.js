'use strict';

/**
 * @module validators
 * Validador schema-based pre-compilado para alto rendimiento.
 */

const PATTERNS = Object.freeze({
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  URL: /^https?:\/\/.+/,
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  PHONE: /^\+?[\d\s\-()]{7,20}$/,
  ALPHA: /^[a-zA-Z]+$/,
  ALPHANUMERIC: /^[a-zA-Z0-9]+$/,
  NUMERIC: /^\d+$/,
  ISO_DATE: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/,
});

const applySanitization = (value, rules) => {
  if (typeof value === 'string') {
    if (rules.trim) value = value.trim();
    if (rules.lowercase) value = value.toLowerCase();
    if (rules.uppercase) value = value.toUpperCase();
  }
  if (rules.toNumber && typeof value === 'string') {
    const num = Number(value);
    if (!Number.isNaN(num)) value = num;
  }
  if (rules.toBoolean) {
    if (value === 'true' || value === '1') value = true;
    else if (value === 'false' || value === '0') value = false;
  }
  return value;
};

const checkType = (value, type, field, customMsg) => {
  if (!type) return null;
  const fail = (msg) => ({ field, message: customMsg ?? msg });
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return fail(`${field} must be a string`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) return fail(`${field} must be a number`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return fail(`${field} must be a boolean`);
      break;
    case 'email':
      if (typeof value !== 'string' || !PATTERNS.EMAIL.test(value)) return fail(`${field} must be a valid email`);
      break;
    case 'date':
      if (typeof value === 'string' && !PATTERNS.ISO_DATE.test(value)) return fail(`${field} must be a valid ISO date`);
      if (value instanceof Date && isNaN(value.getTime())) return fail(`${field} must be a valid date`);
      break;
    case 'array':
      if (!Array.isArray(value)) return fail(`${field} must be an array`);
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value) || value === null) return fail(`${field} must be an object`);
      break;
  }
  return null;
};

const checkConstraints = (value, rules, field) => {
  const errors = [];
  if (rules.enum && !rules.enum.includes(value)) {
    errors.push({ field, message: rules.message ?? `${field} must be one of: ${rules.enum.join(', ')}` });
    return errors;
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      errors.push({ field, message: rules.message ?? `${field} must be at least ${rules.minLength} characters` });
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      errors.push({ field, message: rules.message ?? `${field} must be at most ${rules.maxLength} characters` });
    }
  }
  if (typeof value === 'number') {
    if (rules.min !== undefined && value < rules.min) {
      errors.push({ field, message: rules.message ?? `${field} must be at least ${rules.min}` });
    }
    if (rules.max !== undefined && value > rules.max) {
      errors.push({ field, message: rules.message ?? `${field} must be at most ${rules.max}` });
    }
  }
  if (rules.pattern && typeof value === 'string') {
    const regex = rules.compiledPattern || (rules.pattern instanceof RegExp ? rules.pattern : new RegExp(rules.pattern));
    if (!regex.test(value)) {
      errors.push({ field, message: rules.message ?? `${field} has invalid format` });
    }
  }
  return errors;
};

const validate = (data, schema) => {
  const errors = [];
  const sanitized = {};

  for (const [field, rules] of Object.entries(schema)) {
    let value = data[field];

    if ((value === undefined || value === null) && rules.default !== undefined) {
      value = typeof rules.default === 'function' ? rules.default() : rules.default;
    }

    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push({ field, message: rules.message ?? `${field} is required` });
      continue;
    }

    if (value === undefined || value === null || value === '') {
      continue;
    }

    value = applySanitization(value, rules);

    const typeErr = checkType(value, rules.type, field, rules.message);
    if (typeErr) {
      errors.push(typeErr);
      continue;
    }

    const constraintErrs = checkConstraints(value, rules, field);
    if (constraintErrs.length) {
      errors.push(...constraintErrs);
      continue;
    }

    if (typeof rules.custom === 'function') {
      const msg = rules.custom(value, field, data);
      if (msg) {
        errors.push({ field, message: msg });
        continue;
      }
    }

    sanitized[field] = value;
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : null,
    sanitized,
  };
};

const validateMiddleware = (compiledSchema, options = {}) => {
  const source = options.source ?? 'body';
  return (req, res, next) => {
    const data = getSource(req, source);
    const result = validate(data, compiledSchema);
    if (!result.valid) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid input data',
        errors: result.errors,
        metadata: { requestId: req.requestId ?? null },
      });
    }
    req.validated = result.sanitized;
    next();
  };
};

const validateData = (data, compiledSchema, req = null) => {
  const result = validate(data, compiledSchema);
  if (!result.valid) {
    return {
      ...result,
      errorResponse: {
        success: false,
        error: 'Validation Error',
        message: 'Invalid input data',
        errors: result.errors,
        metadata: { requestId: req?.requestId ?? null },
      },
    };
  }
  return { ...result, errorResponse: null };
};

/**
 * Pre-compila los patrones regex del schema en memoria al instanciar.
 */
const createValidator = (rawSchema) => {
  const compiledSchema = { ...rawSchema };
  for (const [field, rules] of Object.entries(compiledSchema)) {
    if (rules.pattern) {
      rules.compiledPattern = rules.pattern instanceof RegExp ? rules.pattern : new RegExp(rules.pattern);
    }
  }

  return {
    schema: compiledSchema,
    validate: (data) => validate(data, compiledSchema),
    middleware: (options) => validateMiddleware(compiledSchema, options),
    check: (data, req) => validateData(data, compiledSchema, req),
  };
};

const getSource = (req, source) => {
  switch (source) {
    case 'body': return req.body ?? {};
    case 'query': return req.query ?? {};
    case 'params': return req.params ?? {};
    case 'all': return { ...(req.params ?? {}), ...(req.query ?? {}), ...(req.body ?? {}) };
    default: return req.body ?? {};
  }
};

module.exports = {
  validate,
  validateMiddleware,
  validateData,
  createValidator,
  PATTERNS,
};