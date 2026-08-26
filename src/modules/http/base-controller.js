'use strict';

const { success, created, paginated } = require('./response');
const { validate } = require('../validators');

/**
 * @module http/BaseController
 *
 * Controller base con CRUD pre-implementado.
 * Encapsula el patrón: validar → llamar service → responder → catch errors.
 *
 * Los controllers de dominio extienden esta clase y:
 * - Usan los métodos por defecto tal cual
 * - Los sobreescriben para agregar lógica custom
 * - Agregan métodos nuevos específicos del dominio
 *
 * @example
 * class ProductsController extends BaseController {
 *   constructor() {
 *     super(productsService, {
 *       createSchema: { name: { type: 'string', required: true }, price: { type: 'number', required: true } },
 *       updateSchema: { name: { type: 'string' }, price: { type: 'number' } },
 *       listSchema:   { page: { type: 'number', toNumber: true }, limit: { type: 'number', toNumber: true } },
 *     });
 *   }
 * }
 */

class BaseController {
  /**
   * @param {import('../data/base-service').BaseService} service
   * @param {Object} [schemas]
   * @param {Object} [schemas.createSchema] — Schema de validación para create
   * @param {Object} [schemas.updateSchema] — Schema de validación para update
   * @param {Object} [schemas.listSchema] — Schema de validación para query params (getAll)
   */
  constructor(service, schemas = {}) {
    if (!service) throw new Error('BaseController: service is required');
    this.service = service;
    this.schemas = schemas;
  }

  /**
   * GET / — Listado paginado.
   */
  getAll = async (req, res, next) => {
    try {
      if (this.schemas.listSchema) {
        const { valid, errors, sanitized } = validate(req.query, this.schemas.listSchema);
        if (!valid) return this.#validationError(res, errors, req);
        req.query = sanitized;
      }

      const { data, pagination } = await this.service.filterAndPaginate({}, {
        page: +(req.query.page ?? 1),
        limit: +(req.query.limit ?? 20),
        search: req.query.search ? { fields: this.searchFields ?? [], value: req.query.search } : null,
      });

      return paginated(res, data, pagination);
    } catch (err) { next(err); }
  };

  /**
   * GET /:id — Obtener por ID.
   */
  getById = async (req, res, next) => {
    try {
      const id = this.#parseId(req.params.id);
      const record = await this.service.findById(id);

      if (!record) {
        return res.status(404).json({
          success: false,
          error: 'Not Found',
          message: this.notFoundMessage ?? 'Record not found',
          metadata: { requestId: req.requestId ?? null },
        });
      }

      return success(res, record);
    } catch (err) { next(err); }
  };

  /**
   * POST / — Crear.
   */
  create = async (req, res, next) => {
    try {
      if (this.schemas.createSchema) {
        const { valid, errors, sanitized } = validate(req.body, this.schemas.createSchema);
        if (!valid) return this.#validationError(res, errors, req);
        req.body = sanitized;
      }

      const record = await this.service.create(req.body, req.user?.id ?? null);
      return created(res, record);
    } catch (err) { next(err); }
  };

  /**
   * PUT /:id — Actualizar.
   */
  update = async (req, res, next) => {
    try {
      if (this.schemas.updateSchema) {
        const { valid, errors, sanitized } = validate(req.body, this.schemas.updateSchema);
        if (!valid) return this.#validationError(res, errors, req);
        req.body = sanitized;
      }

      const id = this.#parseId(req.params.id);
      const record = await this.service.updateById(id, req.body, req.user?.id ?? null);
      return success(res, record, 'Updated successfully');
    } catch (err) { next(err); }
  };

  /**
   * DELETE /:id — Soft delete.
   */
  remove = async (req, res, next) => {
    try {
      const id = this.#parseId(req.params.id);
      await this.service.softDelete(id, req.user?.id ?? null);
      return success(res, null, 'Deleted successfully');
    } catch (err) { next(err); }
  };

  /**
   * Registra las rutas CRUD en un Router de Express.
   * @param {import('express').Router} router
   * @param {Object} [options]
   * @param {Function[]} [options.middleware] — Middlewares antes de cada handler (auth, etc.)
   */
  registerRoutes(router, options = {}) {
    const mw = options.middleware ?? [];

    router.get('/', ...mw, this.getAll);
    router.get('/:id', ...mw, this.getById);
    router.post('/', ...mw, this.create);
    router.put('/:id', ...mw, this.update);
    router.delete('/:id', ...mw, this.remove);

    return router;
  }

  // ═══════════════════════════════════════════════════════
  // Private
  // ═══════════════════════════════════════════════════════

  #parseId(raw) {
    const num = Number(raw);
    return Number.isNaN(num) ? raw : num;
  }

  #validationError(res, errors, req) {
    return res.status(400).json({
      success: false,
      error: 'Validation Error',
      message: 'Invalid input data',
      errors,
      metadata: { requestId: req.requestId ?? null },
    });
  }
}

module.exports = { BaseController };
