'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @module core/env-loader
 *
 * Carga y valida variables de entorno — sin dependencias externas.
 * Parser .env propio: soporta comments (#), comillas, multiline, export prefix.
 */

class EnvLoader {
  #values = {};

  /**
   * Loads environment variables from a cascade of files.
   *
   * Precedence (highest to lowest):
   *   process.env (real system vars)  >  .env.local  >  .env.{environment}  >  .env
   *
   * - `.env`               base values (also used as the production baseline)
   * - `.env.{environment}` per-environment overrides (e.g. .env.development)
   * - `.env.local`         personal/local overrides (should not be committed)
   *
   * Because #parseEnvFile only sets a key when it is still undefined
   * ("first writer wins"), files are parsed from highest to lowest priority.
   *
   * @param {Object} schema
   * @param {Object} [options]
   * @param {string} [options.environment] — selects .env.{environment}; defaults to NODE_ENV or 'development'
   * @param {string} [options.path=process.cwd()] — directory holding the env files
   * @param {string} [options.envFile] — explicit single file (bypasses the cascade)
   * @param {boolean} [options.requireFile=false] — throw if no env file is found
   */
  constructor(schema = {}, options = {}) {
    const environment = options.environment ?? process.env.NODE_ENV ?? 'development';
    const baseDir = options.path ?? process.cwd();

    // If an explicit envFile is given, load only that one (single-file mode).
    // Otherwise, build the cascade of candidate files (highest priority first).
    const candidates = options.envFile
      ? [path.resolve(baseDir, options.envFile)]
      : [
          path.resolve(baseDir, '.env.local'),           // highest priority
          path.resolve(baseDir, `.env.${environment}`),  // per-environment
          path.resolve(baseDir, '.env'),                 // base / production baseline
        ];

    let anyLoaded = false;

    for (const file of candidates) {
      if (fs.existsSync(file)) {
        this.#parseEnvFile(file);
        anyLoaded = true;
      }
    }

    // Env files are optional. When none exist (e.g. Docker, Render, CI),
    // values are read directly from process.env. Set options.requireFile
    // to true to enforce that at least one file must exist.
    if (!anyLoaded && options.requireFile) {
      throw new Error(`EnvLoader — no env file found in: ${baseDir} (looked for ${candidates.map((c) => path.basename(c)).join(', ')})`);
    }

    this.#load(schema);
    return Object.freeze(this.#values);
  }

  #parseEnvFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();

      // Skip empty lines and comments
      if (!line || line.startsWith('#')) continue;

      // Remove 'export ' prefix
      if (line.startsWith('export ')) line = line.slice(7);

      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) continue;

      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();

      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Handle multiline (value starts with quote but doesn't end)
      if (value.startsWith('"') && !value.endsWith('"')) {
        const parts = [value.slice(1)];
        while (++i < lines.length) {
          const nextLine = lines[i];
          if (nextLine.trimEnd().endsWith('"')) {
            parts.push(nextLine.trimEnd().slice(0, -1));
            break;
          }
          parts.push(nextLine);
        }
        value = parts.join('\n');
      }

      // Remove inline comments (only if not inside quotes)
      const commentIndex = value.indexOf(' #');
      if (commentIndex > -1) {
        value = value.slice(0, commentIndex).trim();
      }

      // Expand \n to actual newlines
      value = value.replace(/\\n/g, '\n');

      // Only set if not already defined (real env vars take precedence)
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  #load(schema) {
    const errors = [];

    for (const [key, def] of Object.entries(schema)) {
      const raw = process.env[key];

      if (raw === undefined || raw === '') {
        if (def.required) { errors.push(`Missing required env: ${key}`); continue; }
        this.#values[key] = def.default ?? null;
        continue;
      }

      this.#values[key] = this.#cast(key, raw, def, errors);
    }

    if (errors.length) {
      throw new Error(`EnvLoader — ${errors.length} error(s):\n  • ${errors.join('\n  • ')}`);
    }
  }

  #cast(key, raw, def, errors) {
    switch (def.type ?? 'string') {
      case 'number': {
        const n = Number(raw);
        if (Number.isNaN(n)) { errors.push(`${key} must be a number`); return def.default ?? null; }
        return n;
      }
      case 'boolean': return raw === 'true' || raw === '1';
      case 'array': return raw.split(def.separator ?? ',').map((s) => s.trim()).filter(Boolean);
      default: return raw;
    }
  }
}

function loadEnv(schema, options) {
  return new EnvLoader(schema, options);
}

module.exports = { EnvLoader, loadEnv };
