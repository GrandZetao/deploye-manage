const fs = require('fs');
const config = require('../config');

/**
 * 极简 JSON 文件数据库。
 * 这个工具是单人使用的本地管理后台，并发写入的概率极低，
 * 所以没有引入 sqlite 之类需要编译的依赖，用同步文件读写 + 原子替换即可保证数据不会损坏。
 */

function ensureDb() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
  if (!fs.existsSync(config.dbFile)) {
    fs.writeFileSync(config.dbFile, JSON.stringify({ projects: [], releases: [], servers: [], operations: [] }, null, 2));
  }
}

function read() {
  ensureDb();
  const raw = fs.readFileSync(config.dbFile, 'utf-8');
  const data = JSON.parse(raw);
  //* 旧版本数据库没有服务器和操作记录字段，读取时补齐即可保持向后兼容。
  return {
    ...data,
    projects: Array.isArray(data.projects) ? data.projects : [],
    releases: Array.isArray(data.releases) ? data.releases : [],
    servers: Array.isArray(data.servers) ? data.servers : [],
    operations: Array.isArray(data.operations) ? data.operations : []
  };
}

function write(data) {
  ensureDb();
  const tmpFile = config.dbFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, config.dbFile); // 原子替换，防止写入过程中进程崩溃导致数据文件损坏
}

module.exports = { read, write };
