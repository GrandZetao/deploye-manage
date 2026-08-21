const path = require('path');
const deployLib = require('./deploy');
const remoteDeploy = require('./remoteDeploy');
const ssh = require('./ssh');

function scopeRoots(project) {
  const paths = remoteDeploy.remotePaths(project);
  return {
    site: { label: '线上目录', path: paths.current },
    releases: { label: '版本仓库', path: paths.releases }
  };
}

function normalizeRelativePath(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (input.startsWith('/') || input.includes('\\') || /[\0\r\n]/.test(input) || input.split('/').includes('..')) {
    throw new Error('文件浏览路径必须位于项目目录内');
  }
  return path.posix.normalize('/' + input).slice(1);
}

function isWithinRoot(rootPath, targetPath) {
  return targetPath === rootPath || targetPath.startsWith(rootPath.replace(/\/$/, '') + '/');
}

async function resolveScopedPath(sftp, project, scope, relativePath) {
  const roots = scopeRoots(project);
  const selected = roots[scope];
  if (!selected) throw new Error('文件浏览范围不存在');
  const normalizedRelative = normalizeRelativePath(relativePath);
  const rootRealPath = await ssh.sftpRealPath(sftp, selected.path);
  const targetPath = path.posix.join(selected.path, normalizedRelative);
  const targetRealPath = await ssh.sftpRealPath(sftp, targetPath);
  //! realpath校验阻止项目目录内的软链接跳转到未授权的系统目录。
  if (!isWithinRoot(rootRealPath, targetRealPath)) throw new Error('目标路径超出项目目录范围');
  return { roots, selected, normalizedRelative, targetRealPath };
}

async function browseProject({ projectId, scope = 'site', relativePath = '', password, passphrase }) {
  const project = deployLib.getProject(projectId);
  const connection = await remoteDeploy.connectProject(project, { password, passphrase });
  let sftp;
  try {
    sftp = await ssh.openSftp(connection.client);
    const resolved = await resolveScopedPath(sftp, project, scope, relativePath);
    const entries = await ssh.sftpReadDir(sftp, resolved.targetRealPath);
    return {
      scope,
      path: resolved.normalizedRelative,
      scopes: Object.entries(resolved.roots).map(([id, item]) => ({ id, label: item.label })),
      entries: entries
        .filter(entry => !['.', '..'].includes(entry.filename))
        .map(entry => ({
          name: entry.filename,
          type: entry.attrs.isDirectory() ? 'directory' : entry.attrs.isSymbolicLink() ? 'link' : 'file',
          sizeBytes: entry.attrs.size || 0,
          modifiedAt: entry.attrs.mtime ? new Date(entry.attrs.mtime * 1000).toISOString() : null
        }))
        .sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name))
    };
  } finally {
    connection.release();
  }
}

async function readProjectFile({ projectId, scope = 'site', relativePath, password, passphrase }) {
  const project = deployLib.getProject(projectId);
  const connection = await remoteDeploy.connectProject(project, { password, passphrase });
  let sftp;
  try {
    sftp = await ssh.openSftp(connection.client);
    const resolved = await resolveScopedPath(sftp, project, scope, relativePath);
    const attrs = await ssh.sftpStat(sftp, resolved.targetRealPath);
    if (attrs.isDirectory()) throw new Error('目录不能作为文本文件预览');
    if (attrs.size > 512 * 1024) throw new Error('在线预览仅支持512KB以内的文本文件');
    const buffer = await ssh.sftpReadFile(sftp, resolved.targetRealPath, 512 * 1024);
    if (buffer.includes(0)) throw new Error('二进制文件不能在线预览');
    return {
      scope,
      path: resolved.normalizedRelative,
      sizeBytes: buffer.length,
      content: buffer.toString('utf8')
    };
  } finally {
    connection.release();
  }
}

async function diagnoseProject({ projectId, password, passphrase }) {
  const project = deployLib.getProject(projectId);
  const paths = remoteDeploy.remotePaths(project);
  const connection = await remoteDeploy.connectProject(project, { password, passphrase });
  const executable = project.nginxExecutablePath ? ssh.quoteArg(project.nginxExecutablePath) : '';
  const config = project.nginxConfigPath ? ssh.quoteArg(project.nginxConfigPath) : '';
  try {
    const result = await ssh.run(connection.client, [
      "printf '=== SYSTEM ===\\n'; uname -a; cat /etc/os-release 2>/dev/null | sed -n '1,8p'",
      "printf '\\n=== RUNTIME ===\\n'; printf 'user='; whoami; printf 'init='; ps -p 1 -o comm=; uptime",
      "printf '\\n=== MEMORY ===\\n'; free -h 2>/dev/null || true",
      "printf '\\n=== PROJECT PATHS ===\\n'; ls -ld " + ssh.quoteArg(paths.root) + ' ' + ssh.quoteArg(paths.current) + ' ' + ssh.quoteArg(paths.releases) + " 2>&1 || true; printf 'current_real='; readlink -f " + ssh.quoteArg(paths.current) + ' 2>/dev/null || true',
      "printf '\\n=== DISK ===\\n'; df -Ph " + ssh.quoteArg(paths.releases) + ' 2>&1 || true',
      "printf '\\n=== REQUIRED TOOLS ===\\n'; for tool in unzip sha256sum find du ln mv stat awk cut basename tr curl wget ss; do printf '%-12s' \"$tool\"; command -v \"$tool\" 2>/dev/null || printf 'missing'; printf '\\n'; done",
      "printf '\\n=== NGINX ===\\n'; ps -eo pid=,user=,args= | awk '/[n]ginx: master process/{print}' || true; " + (executable ? 'test -x ' + executable + " && " + executable + " -V 2>&1 | head -n 3 || true" : "printf 'project executable not configured\\n'"),
      "printf '\\n=== NGINX CONFIG ===\\n'; " + (config ? 'ls -l ' + config + ' 2>&1 || true' : "printf 'compiled default\\n'"),
      "printf '\\n=== NGINX UNITS ===\\n'; systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk 'tolower($1) ~ /(nginx|openresty|tengine)/ {print}' || true",
      "printf '\\n=== LISTEN PORTS ===\\n'; ss -lntp 2>/dev/null | sed -n '1,30p' || true"
    ].join('; '));
    return { details: result.stdout, checkedAt: new Date().toISOString() };
  } finally {
    connection.release();
  }
}

function parseLogEntry(source, line, index) {
  const errorLevel = line.match(/\[(emerg|alert|crit|error|warn|notice|info|debug)\]/i)?.[1]?.toLowerCase();
  const statusCode = source === 'nginx-access' ? Number(line.match(/"\s(\d{3})\s/)?.[1]) : 0;
  const level = errorLevel
    ? ['emerg', 'alert', 'crit', 'error'].includes(errorLevel) ? 'error' : errorLevel === 'warn' ? 'warn' : 'info'
    : statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  const time = source === 'nginx-error'
    ? line.match(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}/)?.[0]
    : line.match(/\[([^\]]+)]/)?.[1];
  return { id: `${source}-${index}`, timestamp: null, time: time || '', level, source, message: line };
}

/**
 * 读取项目已配置的Nginx日志尾部。
 * ! 日志路径只能来自项目配置，接口不接受任意远程路径，避免把它变成系统文件读取入口。
 */
async function readProjectLogs({ projectId, source, lines = 200, query = '', password, passphrase }) {
  const project = deployLib.getProject(projectId);
  const sources = {
    'nginx-access': { label: 'Nginx access', path: project.nginxAccessLogPath },
    'nginx-error': { label: 'Nginx error', path: project.nginxErrorLogPath }
  };
  const selected = sources[source];
  if (!selected) throw new Error('日志来源不存在');
  if (!selected.path) throw new Error(`请先在项目设置中填写${selected.label}日志路径`);
  const count = Math.min(1000, Math.max(20, Number(lines) || 200));
  const keyword = String(query || '').trim().slice(0, 200).toLowerCase();
  const connection = await remoteDeploy.connectProject(project, { password, passphrase });
  try {
    const quotedPath = ssh.quoteArg(selected.path);
    const result = await ssh.run(connection.client, `test -r ${quotedPath} || { echo '日志文件不存在或当前用户不可读' >&2; exit 31; }; tail -n ${count} -- ${quotedPath} | cut -c 1-8192`);
    const entries = result.stdout.split(/\r?\n/)
      .filter(Boolean)
      .filter(line => !keyword || line.toLowerCase().includes(keyword))
      .map((line, index) => parseLogEntry(source, line, index));
    return { source, label: selected.label, path: selected.path, entries, checkedAt: new Date().toISOString() };
  } finally {
    connection.release();
  }
}

module.exports = {
  browseProject,
  readProjectFile,
  diagnoseProject,
  readProjectLogs
};
