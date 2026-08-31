'use strict';

const mongoose = require('mongoose');

/**
 * @module core/MongoClient
 *
 * Singleton Mongoose con retry automático, pool configurado, TLS y health-check.
 */

const READY_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

class MongoClient {
  #ready = false;
  #logger;
  #opts;

  /**
   * @param {Object} options
   * @param {string} options.uri — MongoDB connection string (OBLIGATORIO)
   * @param {Object} [options.logger]
   * @param {number} [options.maxRetries=5]
   * @param {number} [options.retryDelayMs=3000]
   * @param {number} [options.maxPoolSize=10]
   * @param {number} [options.minPoolSize=1]
   * @param {boolean} [options.tls=false] — Habilitar TLS/SSL
   * @param {boolean} [options.tlsAllowInvalidCertificates=false] — Permitir certificados inválidos
   * @param {boolean} [options.useServerApi=false] — Habilitar Stable API (serverApi v1)
   */
  constructor(options = {}) {
    if (!options.uri) throw new Error('MongoClient: uri is required');

    this.#opts = {
      maxRetries: 5,
      retryDelayMs: 3000,
      maxPoolSize: 10,
      minPoolSize: 1,
      tls: false,
      tlsAllowInvalidCertificates: false,
      useServerApi: false,
      ...options,
    };

    this.#logger = options.logger?.child?.({ module: 'mongo' }) ?? console;
    this.#registerEvents();
  }

  #registerEvents() {
    mongoose.connection.on('connected', () => {
      this.#ready = true;
      this.#log('info', 'MongoDB connected');
    });

    mongoose.connection.on('reconnected', () => {
      this.#ready = true;
      this.#log('info', 'MongoDB reconnected');
    });

    mongoose.connection.on('error', (err) => {
      this.#ready = false;
      this.#log('error', 'MongoDB error', { error: err.message });
    });

    mongoose.connection.on('disconnected', () => {
      this.#ready = false;
      this.#log('warn', 'MongoDB disconnected');
    });
  }

  async connect(attempt = 1) {
    const { uri, maxRetries, retryDelayMs, maxPoolSize, minPoolSize, tls, tlsAllowInvalidCertificates, useServerApi } = this.#opts;

    this.#log('info', `Connecting to MongoDB (${attempt}/${maxRetries})...`);

    try {
      const connectionOptions = {
        maxPoolSize,
        minPoolSize,
        serverSelectionTimeoutMS: 20000,
        connectTimeoutMS: 25000,
        socketTimeoutMS: 45000,
        // Node 18.13+ defaults autoSelectFamily to true (Happy Eyeballs:
        // races IPv4/IPv6). In containers and networks that advertise IPv6
        // but don't route it well (Docker, Render), this causes intermittent
        // connection failures with Atlas ("ReplicaSetNoPrimary"). Disabling
        // it forces a stable single-stack connection.
        autoSelectFamily: false,
      };

      // Only set TLS options explicitly when TLS is requested. With a
      // "mongodb+srv://" URI, TLS is implied by the driver, and forcing
      // "tls: false" conflicts with it (causes SSL handshake errors).
      if (tls) {
        connectionOptions.tls = true;
        if (tlsAllowInvalidCertificates) {
          connectionOptions.tlsAllowInvalidCertificates = true;
        }
      }

      // serverApi.strict rejects any command outside the Stable API v1,
      // which can break connections/operations unexpectedly. Keep it opt-in.
      if (useServerApi) {
        connectionOptions.serverApi = {
          version: mongoose.mongo.ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        };
      }

      await mongoose.connect(uri, connectionOptions);
      this.#ready = true;
      this.#log('info', 'MongoDB ready');
      return true;
    } catch (err) {
      this.#ready = false;
      this.#log('error', `Connection failed (${attempt}/${maxRetries})`, { error: err.message });

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        return this.connect(attempt + 1);
      }

      throw err;
    }
  }

  async close() {
    await mongoose.connection.close();
    this.#ready = false;
    this.#log('info', 'MongoDB connection closed');
  }

  isReady() {
    return this.#ready && mongoose.connection.readyState === 1;
  }

  getStats() {
    const state = mongoose.connection.readyState;
    if (state !== 1) {
      return { connected: false, readyState: READY_STATES[state] ?? 'unknown' };
    }
    return { connected: true, readyState: 'connected' };
  }

  #log(level, msg, meta = {}) {
    this.#logger?.[level]?.(msg, meta) ?? console[level === 'error' ? 'error' : 'log'](`[Mongo] ${msg}`);
  }
}

module.exports = { MongoClient };
