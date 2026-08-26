'use strict';

/**
 * Helpers module — shared utility functions.
 */

// --- Pagination ---
const parsePagination = (query = {}, defaults = {}) => ({
  page: Math.max(1, parseInt(query.page, 10) || defaults.page || 1),
  limit: Math.min(defaults.maxLimit || 100, Math.max(1, parseInt(query.limit, 10) || defaults.limit || 20)),
});

const buildPaginationMeta = ({ total, page, limit }) => {
  const totalPages = Math.ceil(total / limit);
  return { total, page: +page, limit: +limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
};

// --- Date ---
const startOfDay = (date) => { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; };
const endOfDay = (date) => { const d = new Date(date); d.setHours(23, 59, 59, 999); return d; };

// --- Query Filters ---
const buildDateRangeFilter = (field, from, to) => {
  const filter = {};
  if (from || to) { filter[field] = {}; if (from) filter[field].$gte = startOfDay(from); if (to) filter[field].$lte = endOfDay(to); }
  return filter;
};

const buildTextSearchFilter = (fields, term) => {
  if (!term || !fields?.length) return {};
  return { $or: fields.map((f) => ({ [f]: new RegExp(term, 'i') })) };
};

// --- Object Utils ---
const pick = (obj, keys) => keys.reduce((acc, k) => { if (k in obj) acc[k] = obj[k]; return acc; }, {});
const omit = (obj, keys) => { const r = { ...obj }; keys.forEach((k) => delete r[k]); return r; };

const stripSensitive = (doc, fields = ['passwordHash', '__v']) => {
  const obj = typeof doc?.toObject === 'function' ? doc.toObject() : { ...doc };
  fields.forEach((f) => delete obj[f]);
  return obj;
};

const { UniqueNumberUtil, createUniqueNumber } = require('./unique-number.util');

module.exports = {
  parsePagination, buildPaginationMeta,
  startOfDay, endOfDay,
  buildDateRangeFilter, buildTextSearchFilter,
  pick, omit, stripSensitive,
  UniqueNumberUtil, createUniqueNumber,
};
