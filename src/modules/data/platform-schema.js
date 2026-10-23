'use strict';

const { Schema } = require('mongoose');

const RECORD_STATUS = Object.freeze({
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
});

const platformFields = {
  _id: { type: Number, required: true },
  recordStatus: { type: String, enum: Object.values(RECORD_STATUS), default: RECORD_STATUS.ACTIVE },
  createdBy: { type: Number, default: null },
  updatedBy: { type: Number, default: null },
};

const baseSchemaOptions = {
  timestamps: true,
  versionKey: false,
  toJSON: { virtuals: true, transform: (_doc, ret) => { ret.id = ret._id; delete ret._id; delete ret.__v; return ret; } },
  toObject: { virtuals: true, transform: (_doc, ret) => { ret.id = ret._id; delete ret._id; delete ret.__v; return ret; } },
};

/**
 * Construye un Schema con los campos de plataforma estándar.
 *
 * @param {Object} schemaFields — campos propios del modelo
 * @param {Object} [options] — opciones de Mongoose + extensiones de plataforma
 * @param {boolean} [options.tenant=false] — si es true, agrega `tenantId` (Number,
 *   indexado) como campo de plataforma transversal para multitenancy. El scoping
 *   concreto (qué valor lleva y cómo se filtra) es responsabilidad de cada API.
 * @returns {import('mongoose').Schema}
 */
const applyPlatformSchema = (schemaFields, options = {}) => {
  const { tenant = false, ...schemaOptions } = options;
  const fields = { ...platformFields, ...schemaFields };
  if (tenant) {
    fields.tenantId = { type: Number, default: null, index: true };
  }
  const schema = new Schema(fields, { ...baseSchemaOptions, ...schemaOptions });
  schema.index({ recordStatus: 1 });
  return schema;
};

module.exports = { applyPlatformSchema, RECORD_STATUS, platformFields };
