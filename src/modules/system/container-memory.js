'use strict';

const fs = require('fs');
const os = require('os');

const BYTES_PER_MB = 1024 * 1024;
const toMb = (bytes) => Math.round((bytes / BYTES_PER_MB) * 100) / 100;

// Rutas estándares de cgroups en Linux
const CGROUP_V2_CURRENT = '/sys/fs/cgroup/memory.current';
const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V1_USAGE = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
const CGROUP_V1_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

function readNumberFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content || content === 'max') return null;
    const num = Number(content);
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

function getCgroupMemory() {
  // Intentar cgroups v2
  let currentBytes = readNumberFromFile(CGROUP_V2_CURRENT);
  let maxBytes = readNumberFromFile(CGROUP_V2_MAX);

  // Fallback a cgroups v1 si v2 no existe
  if (currentBytes === null) {
    currentBytes = readNumberFromFile(CGROUP_V1_USAGE);
  }
  if (maxBytes === null) {
    maxBytes = readNumberFromFile(CGROUP_V1_LIMIT);
  }

  // Filtrar límites infinitos asignados por el kernel (ej: > 100 TB o límites no seteados)
  const totalHostMem = os.totalmem();
  if (maxBytes !== null && maxBytes > totalHostMem * 2) {
    maxBytes = null;
  }

  const isContainer = currentBytes !== null || maxBytes !== null;

  if (!isContainer) {
    return {
      isContainer: false,
      limitMb: null,
      usedMb: toMb(process.memoryUsage().rss),
      freeMb: null,
      usedPercent: null,
    };
  }

  const usedBytes = currentBytes ?? process.memoryUsage().rss;
  const usedMb = toMb(usedBytes);
  const limitMb = maxBytes !== null ? toMb(maxBytes) : null;
  const freeMb = limitMb !== null ? Math.max(0, toMb(maxBytes - usedBytes)) : null;
  const usedPercent = limitMb !== null && limitMb > 0
    ? Math.round((usedBytes / maxBytes) * 1000) / 10
    : null;

  return {
    isContainer: true,
    limitMb,
    usedMb,
    freeMb,
    usedPercent,
  };
}

function getContainerMemory() {
  return getCgroupMemory();
}

function isMemoryUnderPressure(options = {}) {
  const thresholdPercent = options.thresholdPercent ?? 75;
  const maxRssMb = options.maxRssMb ?? null;
  const mem = process.memoryUsage();
  const rssMb = toMb(mem.rss);

  if (maxRssMb !== null && rssMb >= maxRssMb) {
    return true;
  }

  const container = getCgroupMemory();
  if (container.isContainer && container.usedPercent !== null) {
    return container.usedPercent >= thresholdPercent;
  }

  // Si no hay límite de contenedor detectado, evaluar contra la memoria del host
  const hostTotalMb = toMb(os.totalmem());
  const hostUsedMb = toMb(os.totalmem() - os.freemem());
  const hostPercent = hostTotalMb > 0 ? (hostUsedMb / hostTotalMb) * 100 : 0;

  return hostPercent >= thresholdPercent;
}

module.exports = {
  toMb,
  getContainerMemory,
  isMemoryUnderPressure,
};
