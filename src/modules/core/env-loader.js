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

  constructor(schema = {}, options = {}) {
    const envPath = options.path ?? path.resolve(process.cwd(), '.env');

    if (!fs.existsSync(envPath)) {
      throw new Error(`EnvLoader — .env file not found: ${envPath}`);
    }

    this.#parseEnvFile(envPath);
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
