'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @module logs
 *
 * Logger propio de alto rendimiento con:
 * - Niveles estándar: error, warn, info, http, debug, trace
 * - Formato JSON estructurado (production) o colorizado (development)
 * - Rotación de archivos por fecha con límites de tamaño/retención
 * - Child loggers (contexto adicional por request/módulo)
 * - Transports configurables: console, file, custom
 * - Timestamps ISO
 * - Supresión por nivel mínimo
 */

const LOG_LEVELS = Object.freeze({
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  http: 4,
  debug: 5,
  trace: 6,
});

const COLORS = Object.freeze({
  fatal: '\x1b[41m\x1b[37m',
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  http: '\x1b[35m',
  debug: '\x1b[90m',
  trace: '\x1b[90m',
  reset: '\x1b[0m',
});

class Logger {
  #level;
  #levelNum;
  #transports;
  #defaultMeta;
  #environment;
  #appName;
  #logsPath;
  #maxFileSize;
  #maxFiles;
  #currentFileStream = null;
  #currentFileDate = null;
  #rotateEnabled;

  /**
   * @param {Object} [options]
   * @param {string} [options.level='info']
   * @param {string} [options.environment='development']
   * @param {string} [options.appName='app']
   * @param {Object} [options.defaultMeta={}]
   * @param {string} [options.logsPath='./logs']
   * @param {number} [options.maxFileSizeMb=20]
   * @param {number} [options.maxFiles=30]
   * @param {boolean} [options.fileEnabled=true]
   * @param {boolean} [options.consoleEnabled=true]
   * @param {Function[]} [options.customTransports=[]]
   */
  constructor(options = {}) {
    this.#level = options.level ?? 'info';
    this.#levelNum = LOG_LEVELS[this.#level] ?? LOG_LEVELS.info;
    this.#environment = options.environment ?? 'development';
    this.#appName = options.appName ?? 'app';
    this.#defaultMeta = options.defaultMeta ?? {};
    this.#logsPath = options.logsPath ?? './logs';
    this.#maxFileSize = (options.maxFileSizeMb ?? 20) * 1024 * 1024;
    this.#maxFiles = options.maxFiles ?? 30;
    this.#rotateEnabled = options.fileEnabled !== false;

    this.#transports = [];

    if (options.consoleEnabled !== false) {
      this.#transports.push((entry) => this.#writeConsole(entry));
    }

    if (this.#rotateEnabled) {
      this.#ensureLogsDir();
      this.#transports.push((entry) => this.#writeFile(entry));
    }

    if (options.customTransports?.length) {
      options.customTransports.forEach((t) => this.#transports.push(t));
    }

    // Capturar warnings y errores no manejados del proceso
    if (options.captureProcessEvents !== false) {
      process.on('warning', (warning) => {
        this.warn(warning.message, { name: warning.name, stack: warning.stack });
      });

      process.on('uncaughtException', (err) => {
        this.error('Uncaught exception', { error: err.message, stack: err.stack });
      });

      process.on('unhandledRejection', (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        const stack = reason instanceof Error ? reason.stack : undefined;
        this.error('Unhandled rejection', { error: msg, stack });
      });
    }
  }

  error(message, meta = {}) { this.#log('error', message, meta); }
  warn(message, meta = {}) { this.#log('warn', message, meta); }

  /**
   * Loguea un error fatal y termina el proceso con exit code 1.
   * Usar para errores irrecuperables en bootstrap (DB no conecta, config inválida, etc.)
   * @param {string} message
   * @param {Object} [meta]
   */
  fatal(message, meta = {}) {
    this.#log('fatal', message, meta);
    // Dar tiempo al stream de archivo para escribir antes de morir
    setTimeout(() => process.exit(1), 100);
  }
  info(message, meta = {}) { this.#log('info', message, meta); }
  http(message, meta = {}) { this.#log('http', message, meta); }
  debug(message, meta = {}) { this.#log('debug', message, meta); }
  trace(message, meta = {}) { this.#log('trace', message, meta); }

  child(childMeta = {}) {
    const parent = this;
    const merged = { ...this.#defaultMeta, ...childMeta };
    return {
      fatal: (msg, meta = {}) => parent.#log('fatal', msg, { ...merged, ...meta }),
      error: (msg, meta = {}) => parent.#log('error', msg, { ...merged, ...meta }),
      warn: (msg, meta = {}) => parent.#log('warn', msg, { ...merged, ...meta }),
      info: (msg, meta = {}) => parent.#log('info', msg, { ...merged, ...meta }),
      http: (msg, meta = {}) => parent.#log('http', msg, { ...merged, ...meta }),
      debug: (msg, meta = {}) => parent.#log('debug', msg, { ...merged, ...meta }),
      trace: (msg, meta = {}) => parent.#log('trace', msg, { ...merged, ...meta }),
      child: (extraMeta) => parent.child({ ...merged, ...extraMeta }),
    };
  }

  setLevel(level) {
    if (LOG_LEVELS[level] === undefined) throw new Error(`Invalid log level: ${level}`);
    this.#level = level;
    this.#levelNum = LOG_LEVELS[level];
  }

  getLevel() { return this.#level; }

  destroy() {
    if (this.#currentFileStream) {
      this.#currentFileStream.end();
      this.#currentFileStream = null;
    }
  }

  // --- Private ---

  #log(level, message, meta) {
    const levelNum = LOG_LEVELS[level];
    if (levelNum === undefined || levelNum > this.#levelNum) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.#appName,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      ...this.#defaultMeta,
      ...meta,
    };

    if (meta.error instanceof Error) {
      entry.error = meta.error.message;
      entry.stack = meta.error.stack;
    }

    for (const transport of this.#transports) {
      try { transport(entry); } catch { /* transports must never break */ }
    }
  }

  #writeConsole(entry) {
    if (this.#environment === 'development') {
      const color = COLORS[entry.level] ?? COLORS.reset;
      const { timestamp, level, service, message, ...rest } = entry;
      const metaStr = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      process.stdout.write(`${color}[${level.toUpperCase().padEnd(5)}]${COLORS.reset} ${timestamp.slice(11, 23)} ${message}${metaStr}\n`);
    } else {
      process.stdout.write(JSON.stringify(entry) + '\n');
    }
  }

  #writeFile(entry) {
    const today = this.#getDateStr();

    if (this.#currentFileDate !== today) {
      if (this.#currentFileStream) this.#currentFileStream.end();
      this.#currentFileStream = this.#openFileStream(today);
      this.#currentFileDate = today;
      this.#cleanOldFiles();
    }

    if (this.#currentFileStream && this.#currentFileStream.bytesWritten >= this.#maxFileSize) {
      this.#currentFileStream.end();
      this.#currentFileStream = this.#openFileStream(today, true);
    }

    if (this.#currentFileStream) {
      this.#currentFileStream.write(JSON.stringify(entry) + '\n');
    }
  }

  #openFileStream(dateStr, rotated = false) {
    const suffix = rotated ? `-${Date.now()}` : '';
    const filePath = path.join(this.#logsPath, `${this.#appName}-${dateStr}${suffix}.log`);
    return fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
  }

  #cleanOldFiles() {
    try {
      const files = fs.readdirSync(this.#logsPath)
        .filter((f) => f.startsWith(this.#appName) && f.endsWith('.log'))
        .sort();
      if (files.length > this.#maxFiles) {
        const toDelete = files.slice(0, files.length - this.#maxFiles);
        toDelete.forEach((f) => { try { fs.unlinkSync(path.join(this.#logsPath, f)); } catch { /* ignore */ } });
      }
    } catch { /* directory may not exist yet */ }
  }

  #ensureLogsDir() {
    try { fs.mkdirSync(this.#logsPath, { recursive: true }); } catch { /* exists */ }
  }

  #getDateStr() {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Factory.
 * @param {Object} [options]
 * @returns {Logger}
 */
function createLogger(options = {}) {
  return new Logger(options);
}

module.exports = { Logger, createLogger, LOG_LEVELS };
