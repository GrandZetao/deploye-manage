const crypto = require('crypto');

const MAX_ENTRIES = 1000;
const entries = [];

/**
 * 记录管理器自身的运行事件。
 * * 日志只接收服务端生成的摘要，不保存请求体或SSH凭据。
 */
function write({ level = 'info', source = 'system', message, projectId = null }) {
  const entry = {
    id: 'log_' + crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    source,
    projectId,
    message: String(message || '').slice(0, 8192)
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  return entry;
}

function list({ projectId, limit = 200, query = '' } = {}) {
  const count = Math.min(1000, Math.max(20, Number(limit) || 200));
  const keyword = String(query || '').trim().slice(0, 200).toLowerCase();
  return entries
    .filter(entry => (!projectId || !entry.projectId || entry.projectId === projectId)
      && (!keyword || `${entry.source} ${entry.level} ${entry.message}`.toLowerCase().includes(keyword)))
    .slice(-count);
}

module.exports = { write, list };
