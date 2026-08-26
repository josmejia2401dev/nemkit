'use strict';

const { BaseRepository } = require('./base-repository');
const { RECORD_STATUS } = require('./platform-schema');
const { UniqueNumberUtil } = require('../helpers/unique-number.util');

/**
 * @module data/MongoRepository
 *
 * Implementación concreta de BaseRepository para MongoDB (Mongoose).
 *
 * Features:
 * - ID numérico auto-generado (UniqueNumberUtil.generateRaw) si no se envía
 * - Filtro automático de registros eliminados
 * - Paginación avanzada (search regex + date range + sort + select + populate)
 * - Normalización I/O (_id ↔ id)
 * - Soft-delete, restore, status changes
 * - Bulk operations, aggregation, transactions
 * - Upsert, distinct
 */

class MongoRepository extends BaseRepository {
  /**
   * @param {import('mongoose').Model} model — Modelo Mongoose
   * @param {Object} [options]
   * @param {number} [options.queryTimeoutMs=30000] — Timeout para queries (0 = sin límite)
   */
  constructor(model, options = {}) {
    super();
    if (!model) throw new Error('MongoRepository: model is required');
    this.model = model;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 30000;
  }

  /** @private — Aplica timeout a una query Mongoose */
  _applyTimeout(query) {
    if (this.queryTimeoutMs > 0) {
      return query.maxTimeMS(this.queryTimeoutMs);
    }
    return query;
  }

  // ═══════════════════════════════════════════════════════
  // FILTERS
  // ═══════════════════════════════════════════════════════

  /**
   * Retorna el filtro base según las opciones.
   * Por defecto excluye deleted. Si `includeDeleted: true`, no filtra.
   * @param {Object} [options]
   * @param {boolean} [options.includeDeleted=false]
   * @returns {Object}
   */
  _baseFilter(options = {}) {
    if (options.includeDeleted) return {};
    return { recordStatus: { $ne: RECORD_STATUS.DELETED } };
  }

  // ═══════════════════════════════════════════════════════
  // READ OPERATIONS
  // ═══════════════════════════════════════════════════════

  async findById(id, options = {}) {
    let query = this.model.findOne({ _id: id, ...this._baseFilter(options) });
    if (options.select) query = query.select(options.select);
    if (options.populate) query = query.populate(options.populate);
    return this.normalizeOutput(await this._applyTimeout(query));
  }

  async findOne(filter = {}, options = {}) {
    let query = this.model.findOne({ ...this._baseFilter(options), ...filter });
    if (options.select) query = query.select(options.select);
    if (options.populate) query = query.populate(options.populate);
    return this.normalizeOutput(await this._applyTimeout(query));
  }

  async find(filter = {}, options = {}) {
    const { sort = { createdAt: -1 }, select, populate, limit } = options;
    let query = this.model.find({ ...this._baseFilter(options), ...filter }).sort(sort);
    if (select) query = query.select(select);
    if (populate) query = query.populate(populate);
    if (limit) query = query.limit(limit);
    const docs = await this._applyTimeout(query);
    return docs.map((d) => this.normalizeOutput(d));
  }

  async exists(filter = {}, options = {}) {
    const query = { ...this._baseFilter(options), ...filter };
    const count = await this._applyTimeout(this.model.countDocuments(query));
    return count > 0;
  }

  async countDocuments(filter = {}, options = {}) {
    return this._applyTimeout(this.model.countDocuments({ ...this._baseFilter(options), ...filter }));
  }

  async distinct(field, filter = {}, options = {}) {
    return this._applyTimeout(this.model.distinct(field, { ...this._baseFilter(options), ...filter }));
  }

  // ═══════════════════════════════════════════════════════
  // PAGINATION
  // ═══════════════════════════════════════════════════════

  async filterAndPaginate(filter = {}, options = {}) {
    const {
      page = 1, limit = 20, sort = { createdAt: -1 },
      search = null, between = null, select, populate,
    } = options;

    const query = { ...this._baseFilter(options), ...filter };

    if (search?.value && search?.fields?.length) {
      const regex = new RegExp(search.value, 'i');
      query.$or = search.fields.map((f) => ({ [f]: regex }));
    }

    if (between?.field && (between.from || between.to)) {
      query[between.field] = {
        ...(between.from && { $gte: new Date(between.from) }),
        ...(between.to && { $lte: new Date(between.to) }),
      };
    }

    const skip = (page - 1) * limit;
    let docsQuery = this.model.find(query).sort(sort).skip(skip).limit(limit);
    if (select) docsQuery = docsQuery.select(select);
    if (populate) docsQuery = docsQuery.populate(populate);

    const [docs, total] = await Promise.all([this._applyTimeout(docsQuery), this._applyTimeout(this.model.countDocuments(query))]);
    const totalPages = Math.ceil(total / limit);

    return {
      data: docs.map((d) => this.normalizeOutput(d)),
      pagination: { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
    };
  }

  // ═══════════════════════════════════════════════════════
  // WRITE OPERATIONS
  // ═══════════════════════════════════════════════════════

  async create(data, userId = null) {
    const input = this.normalizeInput(data);
    if (!input._id) {
      input._id = UniqueNumberUtil.generateRaw();
    }
    const doc = await this.model.create({ ...input, createdBy: userId, updatedBy: userId });
    return this.normalizeOutput(doc);
  }

  async createMany(items, userId = null) {
    const docs = items.map((item) => {
      const input = this.normalizeInput(item);
      if (!input._id) {
        input._id = UniqueNumberUtil.generateRaw();
      }
      return { ...input, createdBy: userId, updatedBy: userId };
    });
    const created = await this.model.insertMany(docs);
    return created.map((d) => this.normalizeOutput(d));
  }

  async updateById(id, data, userId = null) {
    const { _id, id: _idAlias, ...input } = this.normalizeInput(data);
    const doc = await this.model.findOneAndUpdate(
      { _id: id, ...this._baseFilter() },
      { ...input, updatedBy: userId },
      { returnDocument: 'after' }
    );
    return this.normalizeOutput(doc);
  }

  async updateMany(filter, data, userId = null) {
    const { _id, id: _idAlias, ...input } = this.normalizeInput(data);
    const result = await this.model.updateMany(
      { ...this._baseFilter(), ...filter },
      { ...input, updatedBy: userId }
    );
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async upsert(filter, data, userId = null) {
    const existing = await this.model.findOne({ ...this._baseFilter(), ...filter });
    if (existing) {
      const updated = await this.updateById(existing._id, data, userId);
      return { doc: updated, created: false };
    }
    const created = await this.create({ ...filter, ...data }, userId);
    return { doc: created, created: true };
  }

  // ═══════════════════════════════════════════════════════
  // DELETE OPERATIONS
  // ═══════════════════════════════════════════════════════

  async softDelete(id, userId = null) {
    const doc = await this.model.findOneAndUpdate(
      { _id: id, ...this._baseFilter() },
      { recordStatus: RECORD_STATUS.DELETED, updatedBy: userId },
      { returnDocument: 'after' }
    );
    return this.normalizeOutput(doc);
  }

  async softDeleteMany(filter, userId = null) {
    const result = await this.model.updateMany(
      { ...this._baseFilter(), ...filter },
      { recordStatus: RECORD_STATUS.DELETED, updatedBy: userId }
    );
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  async restore(id, userId = null) {
    const doc = await this.model.findOneAndUpdate(
      { _id: id, recordStatus: RECORD_STATUS.DELETED },
      { recordStatus: RECORD_STATUS.ACTIVE, updatedBy: userId },
      { returnDocument: 'after' }
    );
    return this.normalizeOutput(doc);
  }

  async hardDelete(filter = {}) {
    const result = await this.model.deleteOne(filter);
    return { deletedCount: result.deletedCount };
  }

  async hardDeleteMany(filter = {}) {
    const result = await this.model.deleteMany(filter);
    return { deletedCount: result.deletedCount };
  }

  // ═══════════════════════════════════════════════════════
  // STATUS OPERATIONS
  // ═══════════════════════════════════════════════════════

  async changeStatus(id, status, userId = null) {
    if (!Object.values(RECORD_STATUS).includes(status)) {
      throw new Error(`MongoRepository: invalid status '${status}'`);
    }
    const doc = await this.model.findOneAndUpdate(
      { _id: id },
      { recordStatus: status, updatedBy: userId },
      { returnDocument: 'after' }
    );
    return this.normalizeOutput(doc);
  }

  async deactivate(id, userId = null) { return this.changeStatus(id, RECORD_STATUS.INACTIVE, userId); }
  async activate(id, userId = null) { return this.changeStatus(id, RECORD_STATUS.ACTIVE, userId); }
  async archive(id, userId = null) { return this.changeStatus(id, RECORD_STATUS.ARCHIVED, userId); }

  // ═══════════════════════════════════════════════════════
  // AGGREGATION & ADVANCED
  // ═══════════════════════════════════════════════════════

  async aggregate(pipeline) { return this.model.aggregate(pipeline); }
  async bulkWrite(operations) { return this.model.bulkWrite(operations); }

  // ═══════════════════════════════════════════════════════
  // TRANSACTIONS
  // ═══════════════════════════════════════════════════════

  async withTransaction(fn) {
    const session = await this.model.startSession();
    try {
      session.startTransaction();
      const result = await fn(session);
      await session.commitTransaction();
      return result;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  // ═══════════════════════════════════════════════════════
  // I/O NORMALIZATION
  // ═══════════════════════════════════════════════════════

  /**
   * Normaliza input del cliente → formato Mongo.
   * - Convierte `id` → `_id` en root level
   * - Recursivo en objetos y arrays planos
   * - Ignora Date, Buffer, ObjectId, RegExp, Map
   */
  normalizeInput(data = {}) {
    if (!data || typeof data !== 'object') return data;
    return this._toMongo(data, true);
  }

  /**
   * Normaliza output de Mongo → formato cliente.
   * - Convierte `_id` → `id` en root level
   * - Elimina `__v`
   * - Recursivo en objetos y arrays planos
   * - Ignora Date, Buffer, ObjectId, RegExp, Map
   */
  normalizeOutput(doc) {
    if (!doc) return null;
    const obj = doc.toObject ? doc.toObject({ virtuals: true }) : { ...doc };
    return this._toClient(obj, true);
  }

  /** @private — Convierte id → _id recursivamente */
  _toMongo(obj, isRoot = false) {
    if (this._isNonTraversable(obj)) return obj;

    const result = {};

    for (const key of Object.keys(obj)) {
      if (!Object.hasOwn(obj, key)) continue;

      const value = obj[key];

      // Root level: id → _id
      if (key === 'id' && isRoot) {
        result._id = value;
        continue;
      }

      result[key] = this._transformValue(value, this._toMongo.bind(this));
    }

    return result;
  }

  /** @private — Convierte _id → id, elimina __v recursivamente */
  _toClient(obj, isRoot = false) {
    if (this._isNonTraversable(obj)) return obj;

    const result = {};

    for (const key of Object.keys(obj)) {
      if (!Object.hasOwn(obj, key)) continue;

      // Siempre eliminar __v
      if (key === '__v') continue;

      const value = obj[key];

      // _id → id (root y subdocumentos con _id)
      if (key === '_id') {
        result.id = value;
        continue;
      }

      result[key] = this._transformValue(value, this._toClient.bind(this));
    }

    return result;
  }

  /** @private — Transforma un valor individual (recursión en objetos/arrays) */
  _transformValue(value, transformFn) {
    if (value === null || value === undefined) return value;
    if (this._isNonTraversable(value)) return value;
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (item === null || item === undefined) return item;
        if (this._isNonTraversable(item)) return item;
        if (typeof item === 'object') return transformFn(item, false);
        return item;
      });
    }
    if (typeof value === 'object') return transformFn(value, false);
    return value;
  }

  /** @private — Detecta tipos que NO deben recorrerse recursivamente */
  _isNonTraversable(value) {
    if (!value || typeof value !== 'object') return true;
    if (value instanceof Date) return true;
    if (value instanceof RegExp) return true;
    if (Buffer.isBuffer(value)) return true;
    if (value._bsontype) return true; // ObjectId, Decimal128, etc.
    if (value instanceof Map) return true;
    return false;
  }
}

module.exports = { MongoRepository };
