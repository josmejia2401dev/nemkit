'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

/**
 * @module seeds
 *
 * Seeder para carga de data por defecto (catálogos, roles, permisos, settings).
 *
 * Features:
 * - Upsert inteligente (insert si no existe, update si existe)
 * - Match key configurable (_id, code, email, etc.)
 * - Bulk operations (bulkWrite) para rendimiento
 * - Skip unchanged (no reescribe si el doc es idéntico)
 * - Delete orphans (opcional: sync completo)
 * - Dry run (simulación sin ejecutar)
 * - Carga desde JSON
 * - Logging detallado (inserted, updated, skipped, deleted)
 * - Soporta modelo Mongoose o nombre de colección
 */

class Seeder {
  #logger;
  #defaultMatchKey;

  /**
   * @param {Object} [options]
   * @param {Object} [options.logger] — Logger con .info(), .warn()
   * @param {string} [options.matchKey='_id'] — Campo por defecto para match de upsert
   */
  constructor(options = {}) {
    this.#logger = options.logger ?? console;
    this.#defaultMatchKey = options.matchKey ?? '_id';
  }

  /**
   * Ejecuta un seed: upsert de documentos en una colección.
   *
   * @param {Model|string} modelOrCollection — Modelo Mongoose o nombre de colección
   * @param {Object[]} data — Array de documentos a insertar/actualizar
   * @param {Object} [options]
   * @param {string} [options.matchKey] — Campo para match (default: '_id')
   * @param {boolean} [options.deleteOrphans=false] — Eliminar docs que no están en data
   * @param {boolean} [options.dryRun=false] — Solo simular, no ejecutar
   * @returns {Promise<{ inserted: number, updated: number, skipped: number, deleted: number }>}
   */
  async run(modelOrCollection, data, options = {}) {
    const matchKey = options.matchKey ?? this.#defaultMatchKey;
    const deleteOrphans = options.deleteOrphans ?? false;
    const dryRun = options.dryRun ?? false;

    const model = this.#resolveModel(modelOrCollection);
    const collectionName = model.modelName ?? model.collection?.name ?? 'unknown';

    this.#log('info', `Seeding "${collectionName}" — ${data.length} documents (matchKey: ${matchKey}, dryRun: ${dryRun})`);

    if (!data.length) {
      this.#log('info', `Seeding "${collectionName}" — nothing to seed`);
      return { inserted: 0, updated: 0, skipped: 0, deleted: 0 };
    }

    const stats = { inserted: 0, updated: 0, skipped: 0, deleted: 0 };
    const operations = [];

    for (const doc of data) {
      const matchValue = doc[matchKey];
      if (matchValue === undefined || matchValue === null) {
        this.#log('warn', `Seeding "${collectionName}" — skipping doc without matchKey "${matchKey}"`);
        stats.skipped++;
        continue;
      }

      const filter = { [matchKey]: matchValue };
      const existing = await model.findOne(filter).lean();

      if (existing) {
        // Comparar si hay cambios
        if (this.#isEqual(existing, doc, matchKey)) {
          stats.skipped++;
          continue;
        }

        operations.push({
          updateOne: {
            filter,
            update: { $set: this.#cleanForUpdate(doc, matchKey) },
          },
        });
        stats.updated++;
      } else {
        operations.push({
          insertOne: { document: doc },
        });
        stats.inserted++;
      }
    }

    // Delete orphans
    if (deleteOrphans) {
      const seedKeys = data.map((d) => d[matchKey]).filter((v) => v != null);
      const orphans = await model.find({ [matchKey]: { $nin: seedKeys } }).lean();
      for (const orphan of orphans) {
        operations.push({
          deleteOne: { filter: { [matchKey]: orphan[matchKey] } },
        });
        stats.deleted++;
      }
    }

    // Execute
    if (!dryRun && operations.length > 0) {
      await model.bulkWrite(operations, { ordered: false });
    }

    const mode = dryRun ? '[DRY RUN] ' : '';
    this.#log('info', `${mode}Seeded "${collectionName}" — inserted: ${stats.inserted}, updated: ${stats.updated}, skipped: ${stats.skipped}, deleted: ${stats.deleted}`);

    return stats;
  }

  /**
   * Ejecuta múltiples seeds.
   *
   * @param {Array<{ model?: Model, collection?: string, data: Object[], options?: Object }>} seeds
   * @returns {Promise<Object[]>} — Array de stats por seed
   */
  async runAll(seeds) {
    const results = [];
    for (const seed of seeds) {
      const target = seed.model ?? seed.collection;
      const result = await this.run(target, seed.data, seed.options);
      results.push({ target: this.#getModelName(target), ...result });
    }
    return results;
  }

  /**
   * Ejecuta un seed desde un archivo JSON.
   *
   * @param {Model|string} modelOrCollection
   * @param {string} filePath — Ruta al archivo JSON
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async runFromFile(modelOrCollection, filePath, options = {}) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Seeder: file not found "${resolved}"`);
    }

    const raw = fs.readFileSync(resolved, 'utf8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      throw new Error(`Seeder: file must contain a JSON array "${resolved}"`);
    }

    return this.run(modelOrCollection, data, options);
  }

  // ═══════════════════════════════════════════════════════
  // Private
  // ═══════════════════════════════════════════════════════

  #resolveModel(modelOrCollection) {
    if (typeof modelOrCollection === 'string') {
      // Si es string, buscar modelo registrado o crear acceso directo a colección
      const existing = mongoose.models[modelOrCollection];
      if (existing) return existing;

      // Crear modelo genérico para la colección
      const schema = new mongoose.Schema({}, { strict: false, collection: modelOrCollection });
      return mongoose.model(modelOrCollection, schema);
    }
    return modelOrCollection;
  }

  #getModelName(modelOrCollection) {
    if (typeof modelOrCollection === 'string') return modelOrCollection;
    return modelOrCollection.modelName ?? 'unknown';
  }

  #cleanForUpdate(doc, matchKey) {
    const clean = { ...doc };
    delete clean[matchKey];
    delete clean._id;
    delete clean.__v;
    return clean;
  }

  #isEqual(existing, incoming, matchKey) {
    const keys = Object.keys(incoming).filter((k) => k !== matchKey && k !== '__v');
    for (const key of keys) {
      const a = existing[key];
      const b = incoming[key];
      if (!this.#deepEqual(a, b)) return false;
    }
    return true;
  }

  #deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!this.#deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  #log(level, msg) {
    this.#logger?.[level]?.(msg) ?? console.log(`[Seeder] ${msg}`);
  }
}

/**
 * Factory.
 * @param {Object} [options]
 * @returns {Seeder}
 */
function createSeeder(options = {}) {
  return new Seeder(options);
}

module.exports = { Seeder, createSeeder };
