'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const asyncLocalStorage = new AsyncLocalStorage();

class RequestContext {
  static middleware() {
    return (req, _res, next) => {
      asyncLocalStorage.run({ requestId: req.requestId ?? null, userId: null, startedAt: process.hrtime.bigint() }, () => next());
    };
  }

  static getStore() { return asyncLocalStorage.getStore() ?? {}; }
  static getRequestId() { return RequestContext.getStore().requestId ?? null; }
  static getUserId() { return RequestContext.getStore().userId ?? null; }
  static setUserId(id) { const s = asyncLocalStorage.getStore(); if (s) s.userId = id; }
  static set(key, val) { const s = asyncLocalStorage.getStore(); if (s) s[key] = val; }
  static get(key) { return RequestContext.getStore()[key] ?? null; }
  static run(store, fn) { return asyncLocalStorage.run(store, fn); }
}

module.exports = { RequestContext };
