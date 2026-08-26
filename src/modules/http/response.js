'use strict';

const success = (res, data = null, message = 'OK', statusCode = 200, extra = {}) =>
  res.status(statusCode).json({ success: true, message, data, metadata: { requestId: res.locals?.requestId ?? null, ...extra } });

const created = (res, data, message = 'Created successfully') => success(res, data, message, 201);

const paginated = (res, data, pagination, message = 'OK') => success(res, data, message, 200, { pagination });

/**
 * Responde directamente con el resultado de service.filterAndPaginate().
 * Evita destructuring repetitivo en controllers.
 *
 * @param {Object} res — Express response
 * @param {{ data: Array, pagination: Object }} result — Resultado directo del service
 * @param {string} [message='OK']
 *
 * @example
 * // Antes:
 * const { data, pagination } = await service.getAll(req.query);
 * paginated(res, data, pagination);
 *
 * // Ahora:
 * paginatedFromService(res, await service.getAll(req.query));
 */
const paginatedFromService = (res, result, message = 'OK') =>
  success(res, result.data, message, 200, { pagination: result.pagination });

const noContent = (res) => res.status(204).end();

const error = (res, statusCode, message, errors = null) =>
  res.status(statusCode).json({ success: false, message, errors, metadata: { requestId: res.locals?.requestId ?? null } });

module.exports = { success, created, paginated, paginatedFromService, noContent, error };
