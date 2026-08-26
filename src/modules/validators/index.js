'use strict';

/**
 * @module validators
 *
 * Validador propio schema-based sin dependencias externas.
 *
 * Features:
 * - Schema declarativo por campo
 * - Tipos: string, number, boolean, email, date, array, object
 * - Restricciones: required, min, max, minLength, maxLength, pattern, enum, custom
 * - Sanitización: trim, lowercase, uppercase, toNumber, toBoolean
 * - Validación por fuente: body, query, params (o combinado)
 * - Mensajes customizables
 * - Middleware Express
 * - Helper funcional para controllers
 * - Factory createValidator para reutilizar schemas
 */

// ═══════════════════════════════════════════════════════
// REGEX PATTERNS
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
// CORE: validate
// ═══════════════════════════════════════════════════════

/**
 * Valida un objeto contra un schema.
 *
 * @param {Object} data — Objeto a validar
 * @param {Object} schema — Definición de reglas por campo
 * @returns {{ valid: boolean, errors: Array|null, sanitized: Object }}
 *
 * Schema example:
 * {
 *   name:  { type: 'string', required: true, trim: true, minLength: 2, maxLength: 100 },
 *   email: { type: 'email', required: true, lowercase: true },
 *   age:   { type: 'number', min: 18, max: 120 },
 *   role:  { type: 'string', enum: ['admin', 'user'], default: 'user' },
 *   bio:   { type: 'string', maxLength: 500, custom: (v) => v.includes('spam') ? 'No spam allowed' : null },
 * }
 */
const validate = (data, schema) => {
  const errors = [];
  const sanitized = {};

  for (const [field, rules] of Object.entries(schema)) {
    let value = data[field];

    // Default value
    if ((value === undefined || value === null) && rules.default !== undefined) {
      value = typeof rules.default === 'function' ? rules.default() : rules.default;
    }

    // Required
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push({ field, message: rules.message ?? `${field} is required` });
      continue;
    }

    // Skip si no es requerido y está vacío
    if (value === undefined || value === null || value === '') {
      continue;
    }

    // Sanitización
    value = applySanitization(value, rules);

    // Tipo
    const typeErr = checkType(value, rules.type, field, rules.message);
    if (typeErr) {
      errors.push(typeErr);
      continue;
    }

    // Restricciones
    const constraintErrs = checkConstraints(value, rules, field);
    if (constraintErrs.length) {
      errors.push(...constraintErrs);
      continue;
    }

    // Custom
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

// ═══════════════════════════════════════════════════════
// SANITIZATION
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
// TYPE CHECK
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
// CONSTRAINTS CHECK
// ═══════════════════════════════════════════════════════

const checkConstraints = (value, rules, field) => {
  const errors = [];

  // Enum
  if (rules.enum && !rules.enum.includes(value)) {
    errors.push({ field, message: rules.message ?? `${field} must be one of: ${rules.enum.join(', ')}` });
    return errors;
  }

  // oneOf — campo debe cumplir al menos uno de los schemas
  if (rules.oneOf && Array.isArray(rules.oneOf)) {
    const matched = rules.oneOf.some((schema) => {
      const result = validate({ [field]: value }, { [field]: schema });
      return result.valid;
    });
    if (!matched) {
      errors.push({ field, message: rules.message ?? `${field} does not match any of the allowed schemas` });
    }
    return errors;
  }

  // String / Array length
  if (typeof value === 'string' || Array.isArray(value)) {
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      errors.push({ field, message: rules.message ?? `${field} must be at least ${rules.minLength} characters` });
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      errors.push({ field, message: rules.message ?? `${field} must be at most ${rules.maxLength} characters` });
    }
  }

  // Array item validation (of)
  if (Array.isArray(value) && rules.of) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const itemField = `${field}[${i}]`;

      // of es un schema de reglas para cada item
      if (typeof rules.of === 'object' && rules.of.type) {
        const typeErr = checkType(item, rules.of.type, itemField, rules.of.message);
        if (typeErr) { errors.push(typeErr); continue; }

        const itemConstraints = checkConstraints(item, rules.of, itemField);
        if (itemConstraints.length) { errors.push(...itemConstraints); }
      }
    }
  }

  // Number range
  if (typeof value === 'number') {
    if (rules.min !== undefined && value < rules.min) {
      errors.push({ field, message: rules.message ?? `${field} must be at least ${rules.min}` });
    }
    if (rules.max !== undefined && value > rules.max) {
      errors.push({ field, message: rules.message ?? `${field} must be at most ${rules.max}` });
    }
  }

  // Regex pattern
  if (rules.pattern && typeof value === 'string') {
    const regex = rules.pattern instanceof RegExp ? rules.pattern : new RegExp(rules.pattern);
    if (!regex.test(value)) {
      errors.push({ field, message: rules.message ?? `${field} has invalid format` });
    }
  }

  return errors;
};

// ═══════════════════════════════════════════════════════
// EXPRESS MIDDLEWARE
// ═══════════════════════════════════════════════════════

/**
 * Middleware Express: valida y responde 400 si hay errores.
 * Inyecta req.validated con datos sanitizados.
 *
 * @param {Object} schema
 * @param {Object} [options]
 * @param {string} [options.source='body'] — 'body' | 'query' | 'params' | 'all'
 * @returns {Function}
 */
const validateMiddleware = (schema, options = {}) => {
  const source = options.source ?? 'body';

  return (req, res, next) => {
    const data = getSource(req, source);
    const result = validate(data, schema);

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

// ═══════════════════════════════════════════════════════
// HELPER FUNCIONAL PARA CONTROLLERS
// ═══════════════════════════════════════════════════════

/**
 * Valida datos y retorna errorResponse (para res.status(400).json()) o null.
 *
 * @param {Object} data
 * @param {Object} schema
 * @param {Object} [req] — Para extraer requestId
 * @returns {{ valid: boolean, errors: Array|null, sanitized: Object, errorResponse: Object|null }}
 */
const validateData = (data, schema, req = null) => {
  const result = validate(data, schema);

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

// ═══════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════

/**
 * Crea un validador pre-configurado con un schema reutilizable.
 *
 * @param {Object} schema
 * @returns {Object}
 *
 * @example
 * const userValidator = createValidator({
 *   name:  { type: 'string', required: true, trim: true, minLength: 2 },
 *   email: { type: 'email', required: true, lowercase: true },
 *   age:   { type: 'number', min: 18 },
 * });
 *
 * // Como middleware
 * router.post('/users', userValidator.middleware(), controller.create);
 *
 * // En controller
 * const { errorResponse, sanitized } = userValidator.check(req.body, req);
 * if (errorResponse) return res.status(400).json(errorResponse);
 */
const createValidator = (schema) => ({
  schema,
  validate: (data) => validate(data, schema),
  middleware: (options) => validateMiddleware(schema, options),
  check: (data, req) => validateData(data, schema, req),
});

// ═══════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════

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
