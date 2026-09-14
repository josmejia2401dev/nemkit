'use strict';

const { toMb } = require('./container-memory');

function getProcessMetrics() {
  const mem = process.memoryUsage();

  return {
    rssMb: toMb(mem.rss),
    heapUsedMb: toMb(mem.heapUsed),
    heapTotalMb: toMb(mem.heapTotal),
    externalMb: toMb(mem.external),
    arrayBuffersMb: toMb(mem.arrayBuffers || 0),
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
  };
}

module.exports = {
  getProcessMetrics,
};
