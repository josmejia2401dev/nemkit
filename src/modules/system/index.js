'use strict';

const { toMb, getContainerMemory, isMemoryUnderPressure } = require('./container-memory');
const { getDiskMetrics, getHostMetrics } = require('./host-metrics');
const { getProcessMetrics } = require('./process-metrics');
const { startSample, endSample } = require('./sampler');

function getSystemMetrics(options = {}) {
  const diskPath = options.diskPath || process.cwd();

  return {
    timestamp: new Date().toISOString(),
    process: getProcessMetrics(),
    system: getHostMetrics(),
    container: getContainerMemory(),
    disk: getDiskMetrics(diskPath),
  };
}

module.exports = {
  toMb,
  getSystemMetrics,
  getContainerMemory,
  isMemoryUnderPressure,
  getDiskMetrics,
  getHostMetrics,
  getProcessMetrics,
  startSample,
  endSample,
};
