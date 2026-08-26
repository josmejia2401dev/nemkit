'use strict';

const { HttpError } = require('../http/errors');

/**
 * @module data/BaseService
 *
 * Capa de servicio genérica que delega al repository.
 * Agrega manejo de errores (404 en operaciones por ID) y
 * expone todos los métodos del MongoRepository de forma consistente.
 *
 * Los servicios de dominio extienden esta clase y agregan lógica de negocio.
 */

class BaseService {
  /**
   * @param {import('./mongo-repository').MongoRepository} repository
   */
  constructor(repository) {
    if (!repository) throw new Error('BaseService: repository is required');
    this.repository = repository;
  }

  // ═══════════════════════════════════════════════════════
  // READ OPERATIONS
  // ═══════════════════════════════════════════════════════

  findById(id, options = {}) {
    return this.repository.findById(id, options);
  }

  findOne(filter = {}, options = {}) {
    return this.repository.findOne(filter, options);
  }

  find(filter = {}, options = {}) {
    return this.repository.find(filter, options);
  }

  filterAndPaginate(filter = {}, options = {}) {
    return this.repository.filterAndPaginate(filter, options);
  }

  countDocuments(filter = {}, options = {}) {
    return this.repository.countDocuments(filter, options);
  }

  exists(filter = {}, options = {}) {
    return this.repository.exists(filter, options);
  }

  distinct(field, filter = {}, options = {}) {
    return this.repository.distinct(field, filter, options);
  }

  // ═══════════════════════════════════════════════════════
  // WRITE OPERATIONS
  // ═══════════════════════════════════════════════════════

  create(data, userId = null) {
    return this.repository.create(data, userId);
  }

  createMany(items, userId = null) {
    return this.repository.createMany(items, userId);
  }

  /**
   * Actualiza por ID. Lanza 404 si no se encuentra.
   */
  async updateById(id, data, userId = null) {
    const updated = await this.repository.updateById(id, data, userId);
    if (!updated) {
      throw HttpError.notFound(this.notFoundMessage ?? 'Record not found');
    }
    return updated;
  }

  updateMany(filter, data, userId = null) {
    return this.repository.updateMany(filter, data, userId);
  }

  upsert(filter, data, userId = null) {
    return this.repository.upsert(filter, data, userId);
  }

  // ═══════════════════════════════════════════════════════
  // DELETE OPERATIONS
  // ═══════════════════════════════════════════════════════

  /**
   * Soft-delete por ID. Lanza 404 si no se encuentra.
   */
  async softDelete(id, userId = null) {
    const deleted = await this.repository.softDelete(id, userId);
    if (!deleted) {
      throw HttpError.notFound(this.notFoundMessage ?? 'Record not found');
    }
    return deleted;
  }

  softDeleteMany(filter, userId = null) {
    return this.repository.softDeleteMany(filter, userId);
  }

  /**
   * Restaura un registro soft-deleted. Lanza 404 si no se encuentra.
   */
  async restore(id, userId = null) {
    const restored = await this.repository.restore(id, userId);
    if (!restored) {
      throw HttpError.notFound(this.notFoundMessage ?? 'Record not found');
    }
    return restored;
  }

  hardDelete(filter) {
    return this.repository.hardDelete(filter);
  }

  hardDeleteMany(filter) {
    return this.repository.hardDeleteMany(filter);
  }

  // ═══════════════════════════════════════════════════════
  // STATUS OPERATIONS
  // ═══════════════════════════════════════════════════════

  /**
   * Cambia status. Lanza 404 si no se encuentra.
   */
  async changeStatus(id, status, userId = null) {
    const updated = await this.repository.changeStatus(id, status, userId);
    if (!updated) {
      throw HttpError.notFound(this.notFoundMessage ?? 'Record not found');
    }
    return updated;
  }

  async deactivate(id, userId = null) {
    const updated = await this.repository.deactivate(id, userId);
    if (!updated) {
      throw HttpError.notFound(this.notFoundMessage ?? 'Record not found');
    }
    return updated;
  }

  async activate(id, userId = null) {
    const updated = await this.repository.activate(id, userId);
    if (!updated) {
      throw HttpError.notFound(this.notFoundMessage ?? 'Record not found');
    }
    return updated;
  }

  async archive(id, userId = null) {
    const updated = await this.repository.archive(id, userId);
    if (!updated) {
      throw HttpError.notFound(this.notFoundMessage ?? 'Record not found');
    }
    return updated;
  }

  // ═══════════════════════════════════════════════════════
  // ADVANCED
  // ═══════════════════════════════════════════════════════

  aggregate(pipeline) {
    return this.repository.aggregate(pipeline);
  }

  bulkWrite(operations) {
    return this.repository.bulkWrite(operations);
  }

  withTransaction(fn) {
    return this.repository.withTransaction(fn);
  }
}

module.exports = { BaseService };
