'use strict';

/**
 * @module security/rate-limiter
 *
 * Rate limiter en memoria — sin dependencias externas.
 *
 * Features:
 * - Sliding window log (más preciso que fixed window, sin edge-cases de burst)
 * - Headers estándar: RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
 * - Response 429 consistente con el framework
 * - Skip paths configurables
 * - Key function custom (por userId, API key, etc.)
 * - Cleanup automático de entries expirados
 * - Clase + factory
 *
 * Sliding window: almacena timestamps de cada request. Al evaluar, cuenta
 * solo los timestamps dentro de la ventana actual (últimos N ms).
 * Más costoso en memoria que fixed window, pero elimina el burst edge-case.
 */

class RateLimiter {
  #store = new Map();
  #windowMs;
  #max;
  #message;
  #skipPaths;
  #keyFn;
  #cleanupTimer = null;

  /**
   * @param {Object} [options]
   * @param {number} [options.windowMs=900000] — Ventana en ms (default: 15 min)
   * @param {number} [options.max=100] — Máximo de requests por ventana
   * @param {Object} [options.message] — Body de respuesta 429
   * @param {string[]} [options.skipPaths=[]] — Paths que no cuentan
   * @param {Function} [options.keyFn] — (req) => string. Default: req.ip
   * @param {number} [options.cleanupIntervalMs=60000] — Intervalo de limpieza (0 = deshabilitado)
   */
  constructor(options = {}) {
    this.#windowMs = options.windowMs ?? 900000;
    this.#max = options.max ?? 100;
    this.#skipPaths = new Set(options.skipPaths ?? []);
    this.#keyFn = options.keyFn ?? ((req) => req.ip);
    this.#message = options.message ?? {
      success: false,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
      metadata: {},
    };

    const cleanupInterval = options.cleanupIntervalMs ?? 60000;
    if (cleanupInterval > 0) {
      this.#startCleanup(cleanupInterval);
    }
  }

  /**
   * Express middleware.
   * @returns {Function}
   */
  middleware() {
    return (req, res, next) => {
      if (this.#skipPaths.has(req.path)) return next();

      const key = this.#keyFn(req);
      const now = Date.now();
      const windowStart = now - this.#windowMs;

      // Obtener o crear lista de timestamps
      let timestamps = this.#store.get(key);
      if (!timestamps) {
        timestamps = [];
        this.#store.set(key, timestamps);
      }

      // Eliminar timestamps fuera de la ventana (sliding)
      while (timestamps.length > 0 && timestamps[0] <= windowStart) {
        timestamps.shift();
      }

      // Contar requests en la ventana actual
      const count = timestamps.length;
      const remaining = Math.max(0, this.#max - count - 1);

      // Calcular reset: tiempo hasta que el primer request de la ventana expire
      const resetMs = timestamps.length > 0
        ? Math.max(0, timestamps[0] + this.#windowMs - now)
        : this.#windowMs;
      const resetSeconds = Math.ceil(resetMs / 1000);

      // Headers
      res.setHeader('RateLimit-Limit', this.#max);
      res.setHeader('RateLimit-Remaining', Math.max(0, remaining));
      res.setHeader('RateLimit-Reset', resetSeconds);

      // Excedió el límite
      if (count >= this.#max) {
        res.setHeader('Retry-After', resetSeconds);
        return res.status(429).json(this.#message);
      }

      // Registrar este request
      timestamps.push(now);

      next();
    };
  }

  /**
   * Resetea el contador de una key.
   * @param {string} key
   */
  reset(key) {
    this.#store.delete(key);
  }

  /**
   * Limpia todo el store.
   */
  clear() {
    this.#store.clear();
  }

  /**
   * Detiene el timer de cleanup.
   */
  destroy() {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
    this.#store.clear();
  }

  /**
   * Estadísticas actuales.
   */
  getStats() {
    return {
      activeKeys: this.#store.size,
      windowMs: this.#windowMs,
      max: this.#max,
    };
  }

  // --- Private ---

  #startCleanup(intervalMs) {
    this.#cleanupTimer = setInterval(() => {
      const now = Date.now();
      const windowStart = now - this.#windowMs;

      for (const [key, timestamps] of this.#store) {
        // Eliminar timestamps expirados
        while (timestamps.length > 0 && timestamps[0] <= windowStart) {
          timestamps.shift();
        }
        // Si no quedan timestamps, eliminar la key
        if (timestamps.length === 0) {
          this.#store.delete(key);
        }
      }
    }, intervalMs);

    if (this.#cleanupTimer.unref) {
      this.#cleanupTimer.unref();
    }
  }
}

/**
 * Factory.
 * @param {Object} [options]
 * @returns {RateLimiter}
 */
function createRateLimiter(options = {}) {
  return new RateLimiter(options);
}

module.exports = { RateLimiter, createRateLimiter };
