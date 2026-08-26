'use strict';

const jwt = require('jsonwebtoken');
const { UniqueNumberUtil } = require('../helpers/unique-number.util');

/**
 * @module security/JwtManager
 *
 * Gestión de tokens JWT: sign/verify access y refresh.
 * Cada token lleva un JTI (ULID) para revocación individual.
 *
 * @param {Object} options
 * @param {string} options.accessSecret — Secret para access tokens (OBLIGATORIO)
 * @param {string} options.refreshSecret — Secret para refresh tokens (OBLIGATORIO)
 * @param {string} [options.accessExpiresIn='15m'] — Expiración del access token
 * @param {string} [options.refreshExpiresIn='7d'] — Expiración del refresh token
 * @param {string} [options.issuer] — Emisor del token (campo `iss`)
 * @param {string} [options.audience] — Audiencia del token (campo `aud`)
 */
class JwtManager {
  #accessSecret;
  #refreshSecret;
  #accessExpiresIn;
  #refreshExpiresIn;
  #issuer;
  #audience;

  constructor(options = {}) {
    if (!options.accessSecret) throw new Error('JwtManager: accessSecret is required');
    if (!options.refreshSecret) throw new Error('JwtManager: refreshSecret is required');

    this.#accessSecret = options.accessSecret;
    this.#refreshSecret = options.refreshSecret;
    this.#accessExpiresIn = options.accessExpiresIn ?? '15m';
    this.#refreshExpiresIn = options.refreshExpiresIn ?? '7d';
    this.#issuer = options.issuer ?? undefined;
    this.#audience = options.audience ?? undefined;
  }

  /**
   * Firma un access token.
   * @param {Object} payload — Claims del token (id, email, permissions, etc.)
   * @param {string} [jti] — JTI custom (default: ULID generado)
   * @returns {string}
   */
  signAccessToken(payload, jti) {
    const tokenPayload = { ...payload, jti: jti ?? UniqueNumberUtil.ulid() };
    const signOptions = { expiresIn: this.#accessExpiresIn };

    if (this.#issuer) signOptions.issuer = this.#issuer;
    if (this.#audience) signOptions.audience = this.#audience;

    return jwt.sign(tokenPayload, this.#accessSecret, signOptions);
  }

  /**
   * Firma un refresh token.
   * @param {Object} payload — Claims mínimos (id)
   * @param {string} [jti] — JTI custom (default: ULID generado)
   * @returns {string}
   */
  signRefreshToken(payload, jti) {
    const tokenPayload = { ...payload, jti: jti ?? UniqueNumberUtil.ulid() };
    const signOptions = { expiresIn: this.#refreshExpiresIn };

    if (this.#issuer) signOptions.issuer = this.#issuer;
    if (this.#audience) signOptions.audience = this.#audience;

    return jwt.sign(tokenPayload, this.#refreshSecret, signOptions);
  }

  /**
   * Verifica un access token.
   * @param {string} token
   * @returns {Object} decoded payload
   * @throws {JsonWebTokenError|TokenExpiredError}
   */
  verifyAccessToken(token) {
    const verifyOptions = {};
    if (this.#issuer) verifyOptions.issuer = this.#issuer;
    if (this.#audience) verifyOptions.audience = this.#audience;

    return jwt.verify(token, this.#accessSecret, verifyOptions);
  }

  /**
   * Verifica un refresh token.
   * @param {string} token
   * @returns {Object} decoded payload
   * @throws {JsonWebTokenError|TokenExpiredError}
   */
  verifyRefreshToken(token) {
    const verifyOptions = {};
    if (this.#issuer) verifyOptions.issuer = this.#issuer;
    if (this.#audience) verifyOptions.audience = this.#audience;

    return jwt.verify(token, this.#refreshSecret, verifyOptions);
  }

  /**
   * Decodifica un token SIN verificar firma (solo para inspección/debug).
   * NUNCA confiar en el resultado para autorización.
   * @param {string} token
   * @returns {Object|null}
   */
  decode(token) {
    return jwt.decode(token, { complete: true });
  }

  /**
   * Extrae el tiempo restante de un token (en segundos).
   * Útil para calcular TTL de blacklist.
   * @param {string} token
   * @returns {number} — Segundos restantes (0 si ya expiró)
   */
  getRemainingTime(token) {
    const decoded = jwt.decode(token);
    if (!decoded?.exp) return 0;
    const remaining = decoded.exp - Math.floor(Date.now() / 1000);
    return remaining > 0 ? remaining : 0;
  }
}

module.exports = { JwtManager };
