'use strict';

const { MemoryCache, EVICTION_POLICIES } = require('./memory-cache');
const { FileStore } = require('./stores/file-store');
const { ExclusiveCache, CACHE_MODES } = require('./exclusive-cache');

// --- Factorías (Factory Functions) ---

/**
 * Crea una instancia de caché pura en memoria (RAM).
 * @param {Object} [options]
 * @returns {MemoryCache}
 */
const createMemoryCache = (options = {}) => new MemoryCache(options);

/**
 * Crea una instancia de caché pura en disco.
 * @param {Object} options
 * @param {string} options.path Ruta del archivo JSON (Ej: './cache.json')
 * @returns {FileStore}
 */
const createFileCache = (options = {}) => new FileStore(options);

/**
 * Crea la caché conmutable (Inicia en Disco por defecto, pasa a Memoria por parámetro)[cite: 1].
 * @param {Object} [options]
 * @returns {ExclusiveCache}
 */
const createExclusiveCache = (options = {}) => new ExclusiveCache(options);

module.exports = {
  // Clases principales
  MemoryCache,
  FileStore,
  ExclusiveCache,

  // Factorías de creación rápida
  createMemoryCache,
  createFileCache,
  createExclusiveCache,

  // Constantes de configuración
  EVICTION_POLICIES,
  CACHE_MODES,
};