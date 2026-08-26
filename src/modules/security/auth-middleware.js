'use strict';

const { RequestContext } = require('../observability/request-context');

/**
 * @module security/auth-middleware
 *
 * Middleware de autenticación JWT.
 * Extrae el token, verifica firma, checa blacklist e inyecta req.user.
 */

// ═══════════════════════════════════════════════════════
// TOKEN EXTRACTION
// ═══════════════════════════════════════════════════════

const extractBearerToken = (req) => {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
};

// ═══════════════════════════════════════════════════════
// RESPONSE HELPER
// ═══════════════════════════════════════════════════════

const authError = (res, statusCode, message, requestId) => {
  return res.status(statusCode).json({
    success: false,
    error: 'Auth Error',
    message,
    metadata: { requestId },
  });
};

// ═══════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════

/**
 * Crea middleware de autenticación JWT.
 *
 * @param {Object} options
 * @param {import('./jwt-manager').JwtManager} options.jwtManager
 * @param {Function} [options.isBlacklisted] — async (jti) => boolean
 * @param {Object} [options.logger]
 * @returns {Function} Express middleware — inyecta req.user
 */
const createAuthMiddleware = ({ jwtManager, isBlacklisted, logger }) => {
  return async (req, res, next) => {
    const requestId = req.requestId ?? null;
    const log = logger?.child?.({ requestId }) ?? null;

    try {
      // 1. Extraer token
      const token = extractBearerToken(req);
      if (!token) {
        return authError(res, 401, 'Access token required', requestId);
      }

      // 2. Verificar firma y expiración
      let payload;
      try {
        payload = jwtManager.verifyAccessToken(token);
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          log?.warn?.('Token expired', { error: err.message });
          return authError(res, 401, 'Token expired', requestId);
        }
        log?.warn?.('Invalid token', { error: err.message });
        return authError(res, 401, 'Invalid token', requestId);
      }

      // 3. Verificar JTI
      if (!payload.jti) {
        return authError(res, 401, 'Invalid token (missing jti)', requestId);
      }

      // 4. Blacklist check
      if (isBlacklisted) {
        const revoked = await isBlacklisted(payload.jti);
        if (revoked) {
          log?.warn?.('Token revoked', { jti: payload.jti, userId: payload.id });
          return authError(res, 401, 'Token revoked', requestId);
        }
      }

      // 5. Inyectar usuario en request (directo del payload)
      req.user = {
        id: payload.id,
        email: payload.email,
        fullName: payload.fullName,
        roleIds: payload.roleIds ?? [],
        permissions: payload.permissions ?? [],
        roles: payload.roles ?? [],
        jti: payload.jti,
        exp: payload.exp,
      };

      // 6. Propagar a RequestContext
      RequestContext.setUserId(req.user.id);

      return next();
    } catch (err) {
      log?.error?.('Unexpected auth error', { error: err.message });
      return authError(res, 500, 'Internal authentication error', requestId);
    }
  };
};

module.exports = { createAuthMiddleware, extractBearerToken };
