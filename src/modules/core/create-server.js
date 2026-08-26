'use strict';

const http = require('http');

/**
 * @module core/createServer
 *
 * Bootstrap del servidor HTTP con:
 * - Conexión a MongoDB (retry)
 * - Graceful shutdown (SIGTERM, SIGINT)
 * - Forced shutdown después de 10s si graceful falla
 */

/**
 * @param {Object} params
 * @param {import('express').Application} params.app
 * @param {import('./mongo-client').MongoClient} params.mongo
 * @param {Object} [params.logger]
 * @param {number} [params.port=3000]
 * @param {string} [params.host='localhost']
 * @returns {Promise<http.Server>}
 */
const createServer = async ({ app, mongo, logger, port = 3000, host = 'localhost' }) => {
  const log = logger ?? console;
  const server = http.createServer(app);

  // Graceful shutdown
  const shutdown = async (signal) => {
    log.info?.(`${signal} received, shutting down...`);

    server.close(async () => {
      try { await mongo.close(); } catch { /* ignore */ }
      log.info?.('Server closed gracefully');
      process.exit(0);
    });

    setTimeout(() => {
      log.error?.('Forced shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Connect database
  log.info?.('Connecting to MongoDB...');
  await mongo.connect();

  // Start listening
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      log.info?.(`Server running at http://${host}:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
};

module.exports = { createServer };
