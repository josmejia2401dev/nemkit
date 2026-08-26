'use strict';

/**
 * @module security/cors
 *
 * Middleware CORS manual con:
 * - Pattern matching de orígenes (wildcard: *.example.com)
 * - Regex cacheado (no se recompila por request)
 * - Expose-Headers para que el browser lea headers custom
 * - Preflight handling (OPTIONS → 204)
 * - Method guard (405 si no permitido)
 * - Private Network Access (Chrome LAN/localhost)
 * - Credentials manejado correctamente (no permite * con credentials)
 */

/**
 * @param {Object} options
 * @param {string[]} options.origins — Orígenes permitidos. Ej: ['http://localhost:4200', '*.example.com']
 * @param {string[]} [options.methods] — Métodos permitidos
 * @param {string[]} [options.allowedHeaders] — Headers que el client puede enviar
 * @param {string[]} [options.exposeHeaders] — Headers que el browser puede leer de la response
 * @param {boolean} [options.credentials=true] — Permitir cookies/auth headers
 * @param {number} [options.maxAge=7200] — Cache del preflight en segundos
 * @param {Object} [options.logger] — Logger para origins bloqueados
 * @returns {Function} Express middleware
 */
const createCorsMiddleware = (options = {}) => {
  const origins = options.origins ?? ['*'];
  const methods = options.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
  const allowedHeaders = options.allowedHeaders ?? [
    'Origin', 'X-Requested-With', 'Content-Type', 'Accept',
    'Authorization', 'X-Request-ID', 'Range',
  ];
  const exposeHeaders = options.exposeHeaders ?? [
    'X-Request-ID', 'Content-Range', 'Content-Length',
  ];
  const credentials = options.credentials !== false;
  const maxAge = String(options.maxAge ?? 7200);
  const logger = options.logger ?? null;

  // Pre-computar
  const methodSet = new Set(methods.map((m) => m.toUpperCase()));
  const methodsStr = methods.join(', ');
  const allowedHeadersStr = allowedHeaders.join(', ');
  const exposeHeadersStr = exposeHeaders.join(', ');
  const matchers = origins.map(buildMatcher);

  return (req, res, next) => {
    // Method guard
    if (!methodSet.has(req.method.toUpperCase())) {
      return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    }

    const origin = req.headers.origin;

    if (origin) {
      const allowed = matchOrigin(origin, matchers);

      if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', allowed);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', methodsStr);
        res.setHeader('Access-Control-Allow-Headers', allowedHeadersStr);
        res.setHeader('Access-Control-Expose-Headers', exposeHeadersStr);
        res.setHeader('Access-Control-Max-Age', maxAge);

        if (credentials) {
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }

        // Private Network Access (Chrome)
        if (req.headers['access-control-request-private-network']) {
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
      } else if (logger) {
        logger.warn?.('CORS origin blocked', { origin, path: req.path, ip: req.ip });
      }
    }

    // Preflight
    if (req.method.toUpperCase() === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  };
};

// ═══════════════════════════════════════════════════════
// MATCHER (regex cacheado)
// ═══════════════════════════════════════════════════════

/**
 * Construye un matcher para un patrón de origin.
 * Se ejecuta una sola vez al crear el middleware.
 */
const buildMatcher = (pattern) => {
  if (pattern === '*') {
    return { type: 'wildcard' };
  }

  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$');
    return { type: 'regex', regex };
  }

  return { type: 'exact', value: pattern };
};

/**
 * Evalúa un origin contra los matchers pre-compilados.
 * @returns {string|null} — El origin permitido o null
 */
const matchOrigin = (origin, matchers) => {
  for (const matcher of matchers) {
    switch (matcher.type) {
      case 'wildcard':
        return origin; // Devuelve el origin, no '*' (compatible con credentials)
      case 'regex':
        if (matcher.regex.test(origin)) return origin;
        break;
      case 'exact':
        if (matcher.value === origin) return origin;
        break;
    }
  }
  return null;
};

module.exports = { createCorsMiddleware };
