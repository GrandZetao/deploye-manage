const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const ssh = require('./ssh');

function publicServer(server) {
  return {
    ...server,
    credentialReady: ssh.credentialReady(server),
    sessionReady: ssh.sessionReady(server.id)
  };
}

function listServers() {
  return db.read().servers.map(publicServer);
}

function getServer(serverId) {
  const server = db.read().servers.find(item => item.id === serverId);
  if (!server) throw new Error('SSH服务器不存在');
  return server;
}

function validateInput({ name, host, port, username, authType, privateKeyPath }) {
  const input = {
    name: typeof name === 'string' ? name.trim() : '',
    host: typeof host === 'string' ? host.trim() : '',
    port: Number(port || 22),
    username: typeof username === 'string' ? username.trim() : '',
    authType: authType === 'password' ? 'password' : 'private-key',
    privateKeyPath: typeof privateKeyPath === 'string' ? privateKeyPath.trim() : ''
  };
  if (!input.name || !input.host || !input.username) throw new Error('服务器名称、地址和用户名不能为空');
  if (/\s|\//.test(input.host)) throw new Error('服务器地址格式不正确');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('SSH端口必须在 1 到 65535 之间');
  if (!/^[A-Za-z0-9._-]+$/.test(input.username)) throw new Error('SSH用户名格式不正确');
  if (input.authType === 'private-key' && (!input.privateKeyPath || !path.isAbsolute(input.privateKeyPath))) {
    throw new Error('私钥路径必须是Windows上的绝对路径');
  }
  if (input.authType === 'password') input.privateKeyPath = '';
  return input;
}

function createServer(input) {
  const serverInput = validateInput(input);
  const data = db.read();
  if (data.servers.some(item => item.host === serverInput.host && item.port === serverInput.port && item.username === serverInput.username)) {
    throw new Error('相同地址和用户的SSH服务器已经存在');
  }
  const server = {
    id: 'srv_' + crypto.randomUUID(),
    ...serverInput,
    hostFingerprint: '',
    lastTestedAt: null,
    lastTestStatus: 'untested',
    lastError: '',
    createdAt: new Date().toISOString()
  };
  data.servers.push(server);
  db.write(data);
  return publicServer(server);
}

function updateServer({ serverId, ...input }) {
  const serverInput = validateInput(input);
  const data = db.read();
  const index = data.servers.findIndex(item => item.id === serverId);
  if (index < 0) throw new Error('SSH服务器不存在');
  if (data.servers.some(item => item.id !== serverId && item.host === serverInput.host && item.port === serverInput.port && item.username === serverInput.username)) {
    throw new Error('相同地址和用户的SSH服务器已经存在');
  }
  const current = data.servers[index];
  const hostChanged = current.host !== serverInput.host || current.port !== serverInput.port;
  const connectionChanged = hostChanged
    || current.username !== serverInput.username
    || current.authType !== serverInput.authType
    || current.privateKeyPath !== serverInput.privateKeyPath;
  if (connectionChanged) ssh.disconnect(serverId);
  data.servers[index] = {
    ...current,
    ...serverInput,
    hostFingerprint: hostChanged ? '' : current.hostFingerprint,
    lastTestStatus: hostChanged ? 'untested' : current.lastTestStatus,
    lastError: hostChanged ? '' : current.lastError
  };
  db.write(data);
  return publicServer(data.servers[index]);
}

function deleteServer(serverId) {
  const data = db.read();
  if (data.projects.some(project => project.serverId === serverId)) {
    throw new Error('该服务器仍被项目使用，请先修改或删除相关项目');
  }
  const exists = data.servers.some(item => item.id === serverId);
  if (!exists) throw new Error('SSH服务器不存在');
  ssh.disconnect(serverId);
  data.servers = data.servers.filter(item => item.id !== serverId);
  db.write(data);
}

function disconnectServer(serverId) {
  const server = getServer(serverId);
  ssh.disconnect(serverId);
  return publicServer(server);
}

function updateTestStatus(serverId, changes) {
  const data = db.read();
  const index = data.servers.findIndex(item => item.id === serverId);
  if (index < 0) return;
  data.servers[index] = { ...data.servers[index], ...changes };
  db.write(data);
}

/**
 * 测试SSH认证、主机指纹和Linux发布所需的基础命令。
 * * 密码和私钥口令只进入进程内会话缓存，不写入数据库。
 */
async function testServer({ serverId, password, passphrase, acceptNewHost = false }) {
  const server = getServer(serverId);
  let connection;
  try {
    connection = await ssh.connect(server, { password, passphrase }, { acceptNewHost });
    const result = await ssh.run(connection.client, [
      "printf 'SYSTEM='; uname -srm",
      "printf '\\nOS='; awk -F= '/^PRETTY_NAME=/{gsub(/^\"|\"$/, \"\", $2); print $2}' /etc/os-release 2>/dev/null || true",
      "printf '\\nINIT='; ps -p 1 -o comm= 2>/dev/null | tr -d ' '",
      "printf '\\nHOME='; pwd",
      "printf '\\nTOOLS='; for tool in unzip sha256sum find du ln mv stat awk cut basename tr; do command -v \"$tool\" >/dev/null || printf 'missing:%s ' \"$tool\"; done",
      "printf '\\nNGINX_BIN='; nginx_pid=$(ps -eo pid=,args= 2>/dev/null | awk '/[n]ginx: master process/{print $1; exit}'); if [ -n \"$nginx_pid\" ]; then readlink -f \"/proc/$nginx_pid/exe\" 2>/dev/null || true; else command -v nginx 2>/dev/null || true; fi",
      "printf '\\nNGINX_UNITS='; if command -v systemctl >/dev/null; then systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk 'tolower($1) ~ /(nginx|openresty|tengine)/ {printf \"%s \", $1}'; fi",
      "printf '\\nDISK='; df -Pk . | tail -n 1"
    ].join('; '));
    updateTestStatus(serverId, {
      hostFingerprint: server.hostFingerprint || connection.fingerprint,
      lastTestedAt: new Date().toISOString(),
      lastTestStatus: 'success',
      lastError: ''
    });
    return {
      server: publicServer(getServer(serverId)),
      details: result.stdout
    };
  } catch (error) {
    updateTestStatus(serverId, {
      lastTestedAt: new Date().toISOString(),
      lastTestStatus: 'failed',
      lastError: error.message
    });
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = {
  listServers,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  disconnectServer,
  testServer
};
