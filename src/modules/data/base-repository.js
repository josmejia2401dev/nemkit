'use strict';

/**
 * @module data/BaseRepository
 *
 * Contrato abstracto que define la interfaz de un repository.
 * Todas las implementaciones concretas (MongoRepository, PostgresRepository, etc.)
 * deben cumplir esta interfaz.
 *
 * NO instanciar directamente — usar una implementación concreta.
 */

class BaseRepository {
  constructor() {
    if (new.target === BaseRepository) {
      throw new Error('BaseRepository is abstract. Use a concrete implementation like MongoRepository.');
    }
  }

  // --- Reads ---
  async findById(_id, _options) { throw new Error('Not implemented'); }
  async findOne(_filter, _options) { throw new Error('Not implemented'); }
  async find(_filter, _options) { throw new Error('Not implemented'); }
  async exists(_filter) { throw new Error('Not implemented'); }
  async countDocuments(_filter) { throw new Error('Not implemented'); }
  async distinct(_field, _filter) { throw new Error('Not implemented'); }
  async filterAndPaginate(_filter, _options) { throw new Error('Not implemented'); }

  // --- Writes ---
  async create(_data, _userId) { throw new Error('Not implemented'); }
  async createMany(_items, _userId) { throw new Error('Not implemented'); }
  async updateById(_id, _data, _userId) { throw new Error('Not implemented'); }
  async updateMany(_filter, _data, _userId) { throw new Error('Not implemented'); }
  async upsert(_filter, _data, _userId) { throw new Error('Not implemented'); }

  // --- Deletes ---
  async softDelete(_id, _userId) { throw new Error('Not implemented'); }
  async softDeleteMany(_filter, _userId) { throw new Error('Not implemented'); }
  async restore(_id, _userId) { throw new Error('Not implemented'); }
  async hardDelete(_filter) { throw new Error('Not implemented'); }
  async hardDeleteMany(_filter) { throw new Error('Not implemented'); }

  // --- Status ---
  async changeStatus(_id, _status, _userId) { throw new Error('Not implemented'); }
  async deactivate(_id, _userId) { throw new Error('Not implemented'); }
  async activate(_id, _userId) { throw new Error('Not implemented'); }
  async archive(_id, _userId) { throw new Error('Not implemented'); }

  // --- Advanced ---
  async withTransaction(_fn) { throw new Error('Not implemented'); }

  // --- Normalization ---
  normalizeInput(_data) { throw new Error('Not implemented'); }
  normalizeOutput(_doc) { throw new Error('Not implemented'); }
}

module.exports = { BaseRepository };
