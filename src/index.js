'use strict';

/**
 * nemkit
 *
 * Single entry point — re-exports all modules.
 *
 * Usage:
 *   const { createApp, createServer, loadEnv, MongoRepository, HttpError, ... } = require('nemkit');
 *   // or import specific modules:
 *   const core = require('nemkit/src/modules/core');
 *   const data = require('nemkit/src/modules/data');
 */

const core = require('./modules/core');
const data = require('./modules/data');
const http = require('./modules/http');
const security = require('./modules/security');
const observability = require('./modules/observability');
const logs = require('./modules/logs');
const cache = require('./modules/cache');
const helpers = require('./modules/helpers');
const validators = require('./modules/validators');
const storage = require('./modules/storage');
const queue = require('./modules/queue');
const seeds = require('./modules/seeds');
const events = require('./modules/events');

// Expose underlying libs for direct access
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

module.exports = {
  // Libs
  express,
  mongoose,
  jwt,

  // Core
  ...core,

  // Data
  ...data,

  // HTTP
  ...http,

  // Security
  ...security,

  // Observability
  ...observability,

  // Logs
  ...logs,

  // Cache
  ...cache,

  // Helpers
  ...helpers,

  // Validators
  ...validators,

  // Storage
  ...storage,

  // Queue
  ...queue,

  // Seeds
  ...seeds,

  // Events
  ...events,

  // Named module access
  modules: { core, data, http, security, observability, logs, cache, helpers, validators, storage, queue, seeds, events },
};
