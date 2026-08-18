const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');

const sessionSecrets = new Map();
const connectedServers = new Set();

function createError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function fingerprintHostKey(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function rememberSecrets(serverId, secrets = {}) {
  const current = sessionSecrets.get(serverId) || {};
  const next = { ...current };
  if (typeof secrets.password === 'string' && secrets.password) next.password = secrets.password;
  if (typeof secrets.passphrase === 'string' && secrets.passphrase) next.passphrase = secrets.passphrase;
  if (Object.keys(next).length) sessionSecrets.set(serverId, next);
  return next;
}

function credentialReady(server) {
  if (server.authType === 'private-key') return fs.existsSync(server.privateKeyPath);
  return Boolean(sessionSecrets.get(server.id)?.password);
}

function sessionReady(serverId) {
  return connectedServers.has(serverId);
}

function disconnect(serverId) {
  //* 主动断开会话时同时清除内存凭据，后续远程操作必须重新认证。
  sessionSecrets.delete(serverId);
  connectedServers.delete(serverId);
}

/**
 * 建立经过主机指纹校验的 SSH 连接。
 * ! 未确认的新主机和指纹变化都会中止连接，不能为方便而跳过校验。
 */
function connect(server, secrets = {}, { acceptNewHost = false } = {}) {
  const remembered = rememberSecrets(server.id, secrets);
  const options = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: 15000
  };

  if (server.authType === 'private-key') {
    if (!fs.existsSync(server.privateKeyPath)) {
      throw createError('SSH私钥文件不存在，请检查Windows上的私钥路径', 'PRIVATE_KEY_NOT_FOUND');
    }
    options.privateKey = fs.readFileSync(server.privateKeyPath);
    if (remembered.passphrase) options.passphrase = remembered.passphrase;
  } else {
    if (!remembered.password) {
      throw createError('需要输入SSH密码后才能连接', 'CREDENTIALS_REQUIRED');
    }
    options.password = remembered.password;
  }

  return new Promise((resolve, reject) => {
    const client = new Client();
    let observedFingerprint = '';
    let rejectedUnknownHost = false;
    let settled = false;

    options.hostVerifier = key => {
      observedFingerprint = fingerprintHostKey(key);
      if (server.hostFingerprint) return observedFingerprint === server.hostFingerprint;
      rejectedUnknownHost = !acceptNewHost;
      return acceptNewHost;
    };

    const fail = error => {
      if (settled) return;
      settled = true;
      client.end();
      connectedServers.delete(server.id);
      if (rejectedUnknownHost) {
        reject(createError(
          '首次连接需要确认服务器主机指纹',
          'HOST_FINGERPRINT_REQUIRED',
          { fingerprint: observedFingerprint }
        ));
        return;
      }
      if (server.hostFingerprint && observedFingerprint && observedFingerprint !== server.hostFingerprint) {
        reject(createError(
          '服务器主机指纹与已保存记录不一致，已拒绝连接',
          'HOST_FINGERPRINT_MISMATCH',
          { expected: server.hostFingerprint, actual: observedFingerprint }
        ));
        return;
      }
      if (error.level === 'client-authentication') sessionSecrets.delete(server.id);
      reject(error);
    };

    client.once('ready', () => {
      if (settled) return;
      settled = true;
      connectedServers.add(server.id);
      resolve({ client, fingerprint: observedFingerprint });
    });
    client.once('error', fail);
    client.connect(options);
  });
}

function run(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', chunk => { stdout += chunk.toString(); });
      stream.stderr.on('data', chunk => { stderr += chunk.toString(); });
      stream.on('close', code => {
        const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
        if (code === 0) {
          resolve(result);
          return;
        }
        reject(createError(
          result.stderr || result.stdout || `远程命令执行失败 (${code})`,
          'REMOTE_COMMAND_FAILED',
          result
        ));
      });
    });
  });
}

function uploadFile(client, localPath, remotePath, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      sftp.fastPut(localPath, remotePath, {
        step: transferred => onProgress(transferred)
      }, uploadError => {
        if (uploadError) reject(uploadError);
        else resolve();
      });
    });
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function quoteArg(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function normalizeRemoteRoot(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input.startsWith('/') || /[\0\r\n]/.test(input)) {
    throw createError('Linux部署目录必须是绝对路径', 'INVALID_REMOTE_PATH');
  }
  const normalized = path.posix.normalize(input);
  if (normalized === '/' || normalized.split('/').filter(Boolean).length < 2) {
    throw createError('Linux部署目录范围过大，请使用类似 /var/www/my-project 的独立目录', 'INVALID_REMOTE_PATH');
  }
  return normalized;
}

module.exports = {
  connect,
  run,
  uploadFile,
  hashFile,
  quoteArg,
  normalizeRemoteRoot,
  credentialReady,
  sessionReady,
  disconnect
};
