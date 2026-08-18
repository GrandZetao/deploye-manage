const crypto = require('crypto');
const db = require('./db');

const MAX_OPERATIONS = 200;

/**
 * 记录发布和远程操作的阶段状态，前端通过轮询获得长任务进度。
 * * 只保留最近 200 条，避免极简 JSON 数据库随操作次数无限增长。
 */
function create({ projectId = null, serverId = null, type, title }) {
  const now = new Date().toISOString();
  const operation = {
    id: 'op_' + crypto.randomUUID(),
    projectId,
    serverId,
    type,
    title,
    status: 'running',
    stage: '准备中',
    progress: 0,
    detail: '',
    error: '',
    result: null,
    createdAt: now,
    updatedAt: now
  };
  const data = db.read();
  data.operations.unshift(operation);
  data.operations = data.operations.slice(0, MAX_OPERATIONS);
  db.write(data);
  return operation;
}

function update(operationId, changes) {
  const data = db.read();
  const index = data.operations.findIndex(item => item.id === operationId);
  if (index < 0) throw new Error('操作记录不存在');
  data.operations[index] = {
    ...data.operations[index],
    ...changes,
    updatedAt: new Date().toISOString()
  };
  db.write(data);
  return data.operations[index];
}

function succeed(operationId, result = null) {
  return update(operationId, {
    status: 'success',
    stage: '已完成',
    progress: 100,
    result
  });
}

function fail(operationId, error) {
  return update(operationId, {
    status: 'failed',
    stage: '执行失败',
    error: error.message || String(error)
  });
}

function get(operationId) {
  const operation = db.read().operations.find(item => item.id === operationId);
  if (!operation) throw new Error('操作记录不存在');
  return operation;
}

function list({ projectId = null, limit = 30 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  return db.read().operations
    .filter(item => !projectId || item.projectId === projectId)
    .slice(0, safeLimit);
}

function recoverInterrupted() {
  const data = db.read();
  let changed = false;
  data.operations = data.operations.map(operation => {
    if (operation.status !== 'running') return operation;
    changed = true;
    return {
      ...operation,
      status: 'failed',
      stage: '执行中断',
      error: '管理服务在操作完成前重新启动，请检查目标目录后重试',
      updatedAt: new Date().toISOString()
    };
  });
  if (changed) db.write(data);
}

module.exports = { create, update, succeed, fail, get, list, recoverInterrupted };
