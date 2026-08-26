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

const applyPlatformSchema = (schemaFields, options = {}) => {
  const schema = new Schema({ ...platformFields, ...schemaFields }, { ...baseSchemaOptions, ...options });
  schema.index({ recordStatus: 1 });
  return schema;
};

module.exports = { applyPlatformSchema, RECORD_STATUS, platformFields };
