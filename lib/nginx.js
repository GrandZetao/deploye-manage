const deployLib = require('./deploy');
const remoteDeploy = require('./remoteDeploy');
const ssh = require('./ssh');

function projectSettings(project) {
  if (!deployLib.isRemoteProject(project)) throw new Error('Nginx远程控制只适用于Linux项目');
  if (!project.nginxExecutablePath) throw new Error('请先在项目设置中填写Nginx可执行文件路径');
  if (project.nginxControlMode === 'systemd' && !project.nginxServiceName) {
    throw new Error('systemd控制方式必须填写Nginx服务名');
  }
  return {
    executable: ssh.normalizeRemoteRoot(project.nginxExecutablePath),
    config: project.nginxConfigPath ? ssh.normalizeRemoteRoot(project.nginxConfigPath) : null,
    mode: project.nginxControlMode,
    service: project.nginxServiceName
  };
}

function commandArgs(settings) {
  return settings.config ? ' -c ' + ssh.quoteArg(settings.config) : '';
}

async function validateWithClient(client, project) {
  const settings = projectSettings(project);
  const result = await ssh.run(client, [
    'set -eu',
    'test -x ' + ssh.quoteArg(settings.executable),
    ssh.quoteArg(settings.executable) + ' -t' + commandArgs(settings)
  ].join('; '));
  return {
    ok: true,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n') || 'Nginx配置校验通过'
  };
}

async function healthCheckWithClient(client, project) {
  if (!project.healthCheckUrl) return { configured: false, ok: null };
  const timeout = project.healthCheckTimeoutSeconds || 8;
  const hostArg = project.healthCheckHost ? ' -H ' + ssh.quoteArg('Host: ' + project.healthCheckHost) : '';
  const url = ssh.quoteArg(project.healthCheckUrl);
  const curlFormat = ssh.quoteArg('curl\t%{http_code}\t%{time_total}\t%{url_effective}');
  const command = [
    'set -eu',
    'if command -v curl >/dev/null; then',
    'curl -sS -o /dev/null --connect-timeout ' + timeout + ' --max-time ' + timeout + hostArg + ' -w ' + curlFormat + ' ' + url + ';',
    'elif command -v wget >/dev/null; then',
    'wget -q --spider --timeout=' + timeout + (project.healthCheckHost ? ' --header=' + ssh.quoteArg('Host: ' + project.healthCheckHost) : '') + ' ' + url + ';',
    'printf ' + ssh.quoteArg('wget\t200\t0\t' + project.healthCheckUrl) + ';',
    'else echo ' + ssh.quoteArg('健康检查需要curl或wget') + ' >&2; exit 28; fi'
  ].join(' ');

  try {
    const result = await ssh.run(client, command);
    const parts = result.stdout.split('\t');
    const statusCode = Number(parts[1]) || 0;
    return {
      configured: true,
      ok: statusCode >= 200 && statusCode < 400,
      tool: parts[0] || '',
      statusCode,
      durationMs: Math.round((Number(parts[2]) || 0) * 1000),
      url: parts[3] || project.healthCheckUrl
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      statusCode: 0,
      durationMs: 0,
      url: project.healthCheckUrl,
      error: error.message
    };
  }
}

async function validateProject({ projectId, password, passphrase }) {
  const project = deployLib.getProject(projectId);
  const connection = await remoteDeploy.connectProject(project, { password, passphrase });
  try {
    return await validateWithClient(connection.client, project);
  } finally {
    connection.release();
  }
}

async function healthCheckProject({ projectId, password, passphrase }) {
  const project = deployLib.getProject(projectId);
  if (!project.healthCheckUrl) return { configured: false, ok: null };
  const connection = await remoteDeploy.connectProject(project, { password, passphrase });
  try {
    return await healthCheckWithClient(connection.client, project);
  } finally {
    connection.release();
  }
}

/**
 * 校验通过后才执行reload/restart；二进制模式重启会等待旧master退出再启动新master。
 * ! restart存在短暂中断，不能用reload失败作为自动升级restart的理由。
 */
async function controlProject({ projectId, action, password, passphrase }) {
  if (!['reload', 'restart'].includes(action)) throw new Error('不支持的Nginx操作');
  const project = deployLib.getProject(projectId);
  const settings = projectSettings(project);
  const connection = await remoteDeploy.connectProject(project, { password, passphrase });
  try {
    const validation = await validateWithClient(connection.client, project);
    let command;
    if (settings.mode === 'systemd') {
      command = 'systemctl ' + action + ' ' + ssh.quoteArg(settings.service);
    } else if (action === 'reload') {
      command = ssh.quoteArg(settings.executable) + ' -s reload' + commandArgs(settings);
    } else {
      command = [
        'set -eu',
        'bin=' + ssh.quoteArg(settings.executable),
        'old_pid=$(ps -eo pid=,args= | awk -v needle="$bin" ' + ssh.quoteArg('index($0, "nginx: master process") && index($0, needle) {print $1; exit}') + ')',
        'if [ -n "$old_pid" ]; then "$bin" -s quit' + commandArgs(settings) + '; for i in $(seq 1 20); do kill -0 "$old_pid" 2>/dev/null || break; sleep 0.5; done; kill -0 "$old_pid" 2>/dev/null && { echo ' + ssh.quoteArg('旧Nginx主进程未在10秒内退出') + ' >&2; exit 29; }; fi',
        '"$bin"' + commandArgs(settings),
        'sleep 1',
        'new_pid=$(ps -eo pid=,args= | awk -v needle="$bin" ' + ssh.quoteArg('index($0, "nginx: master process") && index($0, needle) {print $1; exit}') + ')',
        'test -n "$new_pid"',
        'printf ' + ssh.quoteArg('Nginx已重启，master PID=%s\n') + ' "$new_pid"'
      ].join('; ');
    }
    const result = await ssh.run(connection.client, command);
    const health = await healthCheckWithClient(connection.client, project);
    return {
      action,
      validation,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n') || ('Nginx ' + action + ' 完成'),
      health
    };
  } finally {
    connection.release();
  }
}

module.exports = {
  validateProject,
  healthCheckProject,
  controlProject
};
