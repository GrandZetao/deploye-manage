const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const deployLib = require('./deploy');
const servers = require('./servers');
const ssh = require('./ssh');

function assertReleaseFolder(folderName) {
  if (!/^\d{8}-\d{6}(?:-[A-Za-z0-9._-]+)?$/.test(folderName)) {
    throw new Error('远程版本目录名称不合法');
  }
}

function isLegacyLayout(project) {
  return project.linuxLayout === 'legacy-live-link';
}

function remotePaths(project, folderName = '') {
  const root = ssh.normalizeRemoteRoot(project.rootPath);
  const releases = isLegacyLayout(project)
    ? ssh.normalizeRemoteRoot(project.releaseRootPath)
    : path.posix.join(root, 'releases');
  const managementRoot = isLegacyLayout(project)
    ? `${releases}.deploy-manager`
    : path.posix.join(root, '.deploy-manager');
  return {
    root,
    releases,
    current: isLegacyLayout(project) ? root : path.posix.join(root, 'current'),
    managementRoot,
    incoming: path.posix.join(managementRoot, 'incoming'),
    lock: path.posix.join(managementRoot, 'deploy.lock'),
    logFile: path.posix.join(releases, '.deploy.log'),
    release: folderName ? path.posix.join(releases, folderName) : '',
    staging: folderName ? path.posix.join(releases, `.staging-${folderName}`) : '',
    releaseInfo: folderName ? path.posix.join(releases, folderName, '.release-info') : ''
  };
}

async function connectProject(project, secrets) {
  if (!deployLib.isRemoteProject(project)) throw new Error('项目不是Linux SSH部署目标');
  const server = servers.getServer(project.serverId);
  if (!server.hostFingerprint) throw new Error('请先在服务器管理中测试连接并确认主机指纹');
  const connection = await ssh.connect(server, secrets);
  return { ...connection, server };
}

async function acquireLock(client, paths) {
  const root = ssh.quoteArg(paths.root);
  const releases = ssh.quoteArg(paths.releases);
  const incoming = ssh.quoteArg(paths.incoming);
  const lock = ssh.quoteArg(paths.lock);
  const prepareDirs = paths.current === paths.root
    ? `${releases} ${incoming}`
    : `${root} ${releases} ${incoming}`;
  await ssh.run(client, [
    'set -eu',
    `for tool in unzip sha256sum find du ln mv stat awk cut basename tr; do command -v "$tool" >/dev/null || { echo "缺少远程命令: $tool" >&2; exit 27; }; done`,
    `mkdir -p -- ${prepareDirs}`,
    `test -w ${releases}`,
    `mkdir -- ${lock} || { echo '该项目已有远程操作正在执行' >&2; exit 23; }`
  ].join('; '));
}

async function releaseLock(client, lockPath) {
  try {
    await ssh.run(client, `rmdir -- ${ssh.quoteArg(lockPath)}`);
  } catch (_) {
    //* 连接中断时锁会保留，避免下一次操作误判上一次部署已经安全结束。
  }
}

async function activateWithClient(client, project, release, { logAction = 'SWITCH', message = '' } = {}) {
  assertReleaseFolder(release.folderName);
  const paths = remotePaths(project, release.folderName);
  const nextLink = `${paths.current}.tmp.${crypto.randomUUID()}`;
  const commands = [
    'set -eu',
    `test -d ${ssh.quoteArg(paths.release)}`,
    `if [ -e ${ssh.quoteArg(paths.current)} ] && [ ! -L ${ssh.quoteArg(paths.current)} ]; then echo 'current不是符号链接，已停止切换' >&2; exit 24; fi`,
    `rm -f -- ${ssh.quoteArg(nextLink)}`,
    `ln -s -- ${ssh.quoteArg(paths.release)} ${ssh.quoteArg(nextLink)}`,
    `mv -Tf -- ${ssh.quoteArg(nextLink)} ${ssh.quoteArg(paths.current)}`
  ];
  if (isLegacyLayout(project)) {
    commands.push(`printf '%s %s %s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" ${ssh.quoteArg(logAction)} ${ssh.quoteArg(release.folderName)} ${ssh.quoteArg(message)} >> ${ssh.quoteArg(paths.logFile)}`);
  }
  await ssh.run(client, commands.join('; '));
  deployLib.setActiveRelease({ projectId: project.id, releaseId: release.id });
}

/**
 * 通过SFTP上传单个压缩包，在远程staging目录完成校验和解压后再发布。
 * ! 正式版本目录只在解压成功后出现，失败任务不能污染版本时间线。
 */
async function deploy({ projectId, zipPath, description, activate = true, password, passphrase, onProgress = () => {} }) {
  const project = deployLib.getProject(projectId);
  const identity = deployLib.createReleaseIdentity();
  assertReleaseFolder(identity.folderName);
  const paths = remotePaths(project, identity.folderName);
  const remoteZip = path.posix.join(paths.incoming, `${identity.folderName}.zip`);
  const localSize = fs.statSync(zipPath).size;
  let connection;
  let lockAcquired = false;
  let releaseRecorded = false;

  try {
    onProgress('连接Linux服务器', 8, '正在验证SSH连接和主机指纹');
    connection = await connectProject(project, { password, passphrase });
    onProgress('检查远程环境', 15, '正在检查目录权限、unzip和sha256sum');
    await acquireLock(connection.client, paths);
    lockAcquired = true;

    onProgress('SFTP传输', 20, `正在上传 ${path.basename(zipPath)}`);
    let lastProgress = 20;
    const transferStartedAt = Date.now();
    let lastProgressAt = transferStartedAt;
    await ssh.uploadFile(connection.client, zipPath, remoteZip, transferred => {
      const progress = Math.min(65, 20 + Math.floor((transferred / localSize) * 45));
      const now = Date.now();
      //* 限制同步JSON进度写入频率，避免高速传输时管理器磁盘IO反过来拖慢SFTP。
      if (progress > lastProgress && (progress === 65 || now - lastProgressAt >= 300)) {
        lastProgress = progress;
        lastProgressAt = now;
        const seconds = Math.max((now - transferStartedAt) / 1000, 0.001);
        const speed = transferred / 1024 / 1024 / seconds;
        onProgress('SFTP传输', progress, `已传输 ${transferred} / ${localSize} 字节 · ${speed.toFixed(1)} MB/s`);
      }
    });

    const transferSeconds = Math.max((Date.now() - transferStartedAt) / 1000, 0.001);
    const averageSpeed = localSize / 1024 / 1024 / transferSeconds;
    onProgress('校验文件', 70, `SFTP平均 ${averageSpeed.toFixed(1)} MB/s，正在比对本地与远程SHA-256`);
    const [localHash, remoteHashResult] = await Promise.all([
      ssh.hashFile(zipPath),
      ssh.run(connection.client, `sha256sum -- ${ssh.quoteArg(remoteZip)}`)
    ]);
    const remoteHash = remoteHashResult.stdout.split(/\s+/)[0];
    if (localHash !== remoteHash) throw new Error('SFTP传输后的文件校验失败，部署已中止');

    onProgress('解压版本', 78, '正在远程解压并整理版本目录');
    const extractResult = await ssh.run(connection.client, [
      'set -eu',
      `test ! -e ${ssh.quoteArg(paths.release)}`,
      `rm -rf -- ${ssh.quoteArg(paths.staging)}`,
      `mkdir -- ${ssh.quoteArg(paths.staging)}`,
      `unzip -q ${ssh.quoteArg(remoteZip)} -d ${ssh.quoteArg(paths.staging)}`,
      `rm -f -- ${ssh.quoteArg(remoteZip)}`,
      `rm -rf -- ${ssh.quoteArg(path.posix.join(paths.staging, '__MACOSX'))}`,
      `entry_count=$(find ${ssh.quoteArg(paths.staging)} -mindepth 1 -maxdepth 1 -printf '.' | wc -c)`,
      `only_dir=$(find ${ssh.quoteArg(paths.staging)} -mindepth 1 -maxdepth 1 -type d -print -quit)`,
      `if [ "$entry_count" -eq 1 ] && [ -n "$only_dir" ]; then mv -- "$only_dir" ${ssh.quoteArg(paths.staging + '.flatten')}; rmdir -- ${ssh.quoteArg(paths.staging)}; mv -- ${ssh.quoteArg(paths.staging + '.flatten')} ${ssh.quoteArg(paths.staging)}; fi`,
      `test -n "$(find ${ssh.quoteArg(paths.staging)} -mindepth 1 -maxdepth 1 -print -quit)"`,
      `mv -- ${ssh.quoteArg(paths.staging)} ${ssh.quoteArg(paths.release)}`,
      ...(isLegacyLayout(project) ? [
        `{ printf 'version=%s\\n' ${ssh.quoteArg(identity.folderName)}; printf 'time=%s\\n' "$(date '+%Y-%m-%d %H:%M:%S')"; printf 'deployer=%s\\n' "$(whoami)"; printf 'size=%s\\n' "$(du -sh ${ssh.quoteArg(paths.release)} | cut -f1)"; printf '%s\\n' '---MESSAGE---'; printf '%s\\n' ${ssh.quoteArg(description || '无说明')}; } > ${ssh.quoteArg(paths.releaseInfo)}`
      ] : []),
      `du -sb -- ${ssh.quoteArg(paths.release)} | cut -f1`
    ].join('; '));

    const release = deployLib.recordRelease({
      id: identity.id,
      projectId,
      folderName: identity.folderName,
      description: description || '',
      createdAt: new Date().toISOString(),
      sizeBytes: Number(extractResult.stdout.split(/\s+/).pop()) || localSize
    });
    releaseRecorded = true;

    if (activate) {
      onProgress('切换线上版本', 92, '正在原子替换current符号链接');
      await activateWithClient(connection.client, project, release, { logAction: 'DEPLOY', message: description || '无说明' });
    }
    onProgress('部署完成', 100, activate ? '新版本已经上线' : '版本已上传，尚未上线');
    return release;
  } catch (error) {
    if (connection) {
      try {
        const cleanupPaths = releaseRecorded
          ? `${ssh.quoteArg(remoteZip)} ${ssh.quoteArg(paths.staging)}`
          : `${ssh.quoteArg(remoteZip)} ${ssh.quoteArg(paths.staging)} ${ssh.quoteArg(paths.release)}`;
        await ssh.run(connection.client, `rm -f -- ${ssh.quoteArg(remoteZip)}; rm -rf -- ${cleanupPaths}`);
      } catch (_) {
        //* 清理失败不覆盖原始部署错误，残留目录仍位于受控的incoming/staging范围内。
      }
    }
    throw error;
  } finally {
    if (connection && lockAcquired) await releaseLock(connection.client, paths.lock);
    if (connection) connection.release();
  }
}

async function activateRelease({ projectId, releaseId, password, passphrase }) {
  const project = deployLib.getProject(projectId);
  const release = deployLib.listReleases(projectId).find(item => item.id === releaseId);
  if (!release) throw new Error('版本不存在');
  const paths = remotePaths(project, release.folderName);
  const connection = await connectProject(project, { password, passphrase });
  let lockAcquired = false;
  try {
    await acquireLock(connection.client, paths);
    lockAcquired = true;
    await activateWithClient(connection.client, project, release);
    return release;
  } finally {
    if (lockAcquired) await releaseLock(connection.client, paths.lock);
    connection.release();
  }
}

async function deleteRelease({ projectId, releaseId, password, passphrase }) {
  const project = deployLib.getProject(projectId);
  const release = deployLib.listReleases(projectId).find(item => item.id === releaseId);
  if (!release) throw new Error('版本不存在');
  if (project.activeReleaseId === releaseId) throw new Error('不能删除当前正在线上运行的版本，请先切换到其他版本');
  assertReleaseFolder(release.folderName);
  const paths = remotePaths(project, release.folderName);
  const connection = await connectProject(project, { password, passphrase });
  let lockAcquired = false;
  try {
    await acquireLock(connection.client, paths);
    lockAcquired = true;
    await ssh.run(connection.client, [
      'set -eu',
      `if [ -L ${ssh.quoteArg(paths.current)} ] && [ "$(readlink -f ${ssh.quoteArg(paths.current)})" = "$(readlink -f ${ssh.quoteArg(paths.release)})" ]; then echo '该目录是远程current实际指向，已停止删除' >&2; exit 25; fi`,
      `test -d ${ssh.quoteArg(paths.release)}`,
      `rm -rf -- ${ssh.quoteArg(paths.release)}`
    ].join('; '));
    if (isLegacyLayout(project)) {
      await ssh.run(connection.client, `printf '%s CLEAN %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" ${ssh.quoteArg(release.folderName)} >> ${ssh.quoteArg(paths.logFile)}`);
    }
    deployLib.removeReleaseRecord({ projectId, releaseId });
  } finally {
    if (lockAcquired) await releaseLock(connection.client, paths.lock);
    connection.release();
  }
}

async function cleanupOldReleases({ projectId, keep, password, passphrase }) {
  const candidates = deployLib.getCleanupCandidates({ projectId, keep });
  for (const release of candidates) {
    await deleteRelease({ projectId, releaseId: release.id, password, passphrase });
  }
  return candidates.map(release => release.id);
}

async function deleteProjectFiles({ projectId, password, passphrase }) {
  const project = deployLib.getProject(projectId);
  const paths = remotePaths(project);
  const connection = await connectProject(project, { password, passphrase });
  let lockAcquired = false;
  let deleted = false;
  try {
    await acquireLock(connection.client, paths);
    lockAcquired = true;
    await ssh.run(connection.client, [
      'set -eu',
      `if [ -e ${ssh.quoteArg(paths.current)} ] && [ ! -L ${ssh.quoteArg(paths.current)} ]; then echo 'current不是符号链接，已停止删除' >&2; exit 26; fi`,
      `rm -f -- ${ssh.quoteArg(paths.current)}`,
      `rm -rf -- ${ssh.quoteArg(paths.releases)}`
    ].join('; '));
    deleted = true;
  } finally {
    try {
      if (lockAcquired) await releaseLock(connection.client, paths.lock);
      if (deleted) await ssh.run(connection.client, `rm -rf -- ${ssh.quoteArg(paths.managementRoot)}`);
    } finally {
      connection.release();
    }
  }
}

/**
 * 扫描旧脚本版本目录和线上软链接，将已有版本导入当前管理器。
 * * 远程目录是事实来源，但同步只新增记录，不静默删除本地操作历史。
 */
async function syncProject({ projectId, password, passphrase }) {
  const project = deployLib.getProject(projectId);
  const paths = remotePaths(project);
  const connection = await connectProject(project, { password, passphrase });
  try {
    const result = await ssh.run(connection.client, [
      'set -eu',
      `releases=${ssh.quoteArg(paths.releases)}`,
      `current=${ssh.quoteArg(paths.current)}`,
      `active=''; if [ -L "$current" ]; then active=$(basename "$(readlink -f "$current")"); fi`,
      `printf 'CURRENT\\t%s\\n' "$active"`,
      `if [ -d "$releases" ]; then find "$releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort | while IFS= read -r name; do dir="$releases/$name"; created=$(stat -c %Y "$dir"); bytes=$(du -sb "$dir" | cut -f1); message=$(awk '/^---MESSAGE---$/{f=1; next} f{print; exit}' "$dir/.release-info" 2>/dev/null | tr '\\t\\r\\n' ' ' || true); printf 'VERSION\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$created" "$bytes" "$message"; done; fi`
    ].join('; '));
    let activeFolderName = '';
    const remoteReleases = [];
    for (const line of result.stdout.split('\n')) {
      const [type, folderName, created, sizeBytes, ...descriptionParts] = line.split('\t');
      if (type === 'CURRENT') {
        activeFolderName = folderName || '';
        continue;
      }
      if (type !== 'VERSION') continue;
      try {
        assertReleaseFolder(folderName);
      } catch (_) {
        continue;
      }
      const timestamp = Number(created) * 1000;
      remoteReleases.push({
        folderName,
        createdAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString(),
        sizeBytes: Number(sizeBytes) || 0,
        description: descriptionParts.join('\t') || '从Linux服务器导入'
      });
    }
    return {
      ...deployLib.syncRemoteReleases({ projectId, remoteReleases, activeFolderName }),
      remoteCount: remoteReleases.length,
      activeFolderName
    };
  } finally {
    connection.release();
  }
}

module.exports = {
  remotePaths,
  connectProject,
  deploy,
  activateRelease,
  deleteRelease,
  cleanupOldReleases,
  deleteProjectFiles,
  syncProject
};
