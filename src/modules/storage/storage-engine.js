'use strict';

/**
 * @module storage/StorageEngine
 *
 * Contrato base para todos los motores de almacenamiento de nemkit.
 * Permite intercambiar o componer estrategias de persistencia (RAM, Disco, Chunks, Cloud).
 */
class StorageEngine {
  /**
   * Guarda un archivo completo.
   * @param {string} key
   * @param {Buffer|import('stream').Readable|string} input
   * @param {Object} [metadata]
   * @returns {Promise<{ key: string, size: number, mime: string, path?: string, createdAt: string }>}
   */
  async save(_key, _input, _metadata = {}) {
    throw new Error('StorageEngine.save not implemented');
  }

  /**
   * Obtiene un archivo como ReadableStream con Range support opcional.
   * @param {string} key
   * @param {Object} [options]
   * @returns {{ stream: import('stream').Readable, metadata: Object, size: number }}
   */
  getStream(_key, _options = {}) {
    throw new Error('StorageEngine.getStream not implemented');
  }

  /**
   * Obtiene el contenido completo como Buffer.
   * @param {string} key
   * @returns {Promise<{ buffer: Buffer, metadata: Object }>}
   */
  async getBuffer(_key) {
    throw new Error('StorageEngine.getBuffer not implemented');
  }

  /**
   * Obtiene la metadata sin leer el contenido.
   * @param {string} key
   * @returns {Object|null}
   */
  getMetadata(_key) {
    throw new Error('StorageEngine.getMetadata not implemented');
  }

  /**
   * Verifica existencia del archivo.
   * @param {string} key
   * @returns {boolean}
   */
  exists(_key) {
    throw new Error('StorageEngine.exists not implemented');
  }

  /**
   * Elimina un archivo y su metadata.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async delete(_key) {
    throw new Error('StorageEngine.delete not implemented');
  }

  /**
   * Lista archivos por prefijo.
   * @param {string} [prefix='']
   * @returns {Promise<string[]>}
   */
  async list(_prefix = '') {
    throw new Error('StorageEngine.list not implemented');
  }
}

module.exports = { StorageEngine };
