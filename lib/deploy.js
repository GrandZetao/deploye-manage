const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { safeExtract } = require('./zipUtil');

/**
 * 每个项目的目录结构：
 *
 *   <rootPath>\
 *     releases\
 *       20260818-153042-a1b2c3\   <- 不可变的某次发布内容
 *       20260817-120500-f4e5d6\
 *     current   <- NTFS junction（目录联接点），nginx 的 root 固定指向这个路径
 *
 * "切换版本" = 把 current 这个 junction 重新指向 releases 下的另一个文件夹，
 * 不需要移动/复制任何静态文件，也不需要重启或 reload nginx。
 */

function releasesDir(project) {
  return path.join(project.rootPath, 'releases');
}
function currentLink(project) {
  return path.join(project.rootPath, 'current');
}

function normalizeProject(project) {
  return {
    ...project,
    targetType: project.targetType || 'local-windows',
    serverId: project.serverId || null,
    linuxLayout: project.linuxLayout || 'managed-current',
    releaseRootPath: project.releaseRootPath || null,
    previousReleaseId: project.previousReleaseId || null,
    nginxControlMode: project.nginxControlMode === 'systemd' ? 'systemd' : 'binary',
    nginxExecutablePath: project.nginxExecutablePath || null,
    nginxConfigPath: project.nginxConfigPath || null,
    nginxServiceName: project.nginxServiceName || null,
    nginxAccessLogPath: project.nginxAccessLogPath || null,
    nginxErrorLogPath: project.nginxErrorLogPath || null,
    healthCheckUrl: project.healthCheckUrl || null,
    healthCheckHost: project.healthCheckHost || null,
    healthCheckTimeoutSeconds: Number(project.healthCheckTimeoutSeconds) || 8
  };
}

function isRemoteProject(project) {
  return normalizeProject(project).targetType === 'ssh-linux';
}

function listProjects() {
  return db.read().projects.map(normalizeProject);
}

function getProject(projectId) {
  const project = db.read().projects.find(p => p.id === projectId);
  if (!project) throw new Error('项目不存在');
  return normalizeProject(project);
}

function createProject(input) {
  const projectInput = validateProjectInput(input);
  const data = db.read();
  if (data.projects.some(p => p.name.toLowerCase() === projectInput.name.toLowerCase())) {
    throw new Error('项目名称已存在');
  }
  if (data.projects.some(p => sameTarget(p, projectInput))) {
    throw new Error('该目录已经绑定到其他项目');
  }
  if (data.projects.some(project => remoteScopesOverlap(project, projectInput))) {
    throw new Error('Linux站点路径或版本目录与其他项目冲突');
  }
  const project = {
    id: 'proj_' + crypto.randomUUID(),
    ...projectInput,
    createdAt: new Date().toISOString(),
    activeReleaseId: null
  };
  if (!isRemoteProject(project)) fs.ensureDirSync(releasesDir(project));
  data.projects.push(project);
  db.write(data);
  return project;
}

/**
 * 修改项目名称或部署根目录。
 * * 路径变化时只迁移 Deploy Manager 管理的 releases，并重建 current；根目录里的其他文件保持原样。
 * ! 目标目录已有 releases/current 时必须中止，避免合并或覆盖不属于当前项目的线上文件。
 */
function updateProject({ projectId, ...input }) {
  const projectInput = validateProjectInput(input);
  const data = db.read();
  const projectIndex = data.projects.findIndex(p => p.id === projectId);
  if (projectIndex < 0) throw new Error('项目不存在');

  const project = normalizeProject(data.projects[projectIndex]);
  const projectReleases = data.releases.filter(release => release.projectId === projectId);
  if (data.projects.some(p => p.id !== projectId && p.name.toLowerCase() === projectInput.name.toLowerCase())) {
    throw new Error('项目名称已存在');
  }
  if (data.projects.some(p => p.id !== projectId && sameTarget(p, projectInput))) {
    throw new Error('该目录已经绑定到其他项目');
  }
  if (data.projects.some(item => item.id !== projectId && remoteScopesOverlap(item, projectInput))) {
    throw new Error('Linux站点路径或版本目录与其他项目冲突');
  }

  const targetChanged = project.targetType !== projectInput.targetType || project.serverId !== projectInput.serverId;
  const linuxLayoutChanged = project.linuxLayout !== projectInput.linuxLayout || project.releaseRootPath !== projectInput.releaseRootPath;
  if ((targetChanged || linuxLayoutChanged) && projectReleases.length) {
    throw new Error('已有版本的项目不能切换部署目标，请新建项目');
  }
  if (isRemoteProject(project) && !targetChanged && project.rootPath !== projectInput.rootPath && projectReleases.length) {
    throw new Error('远程项目已有版本，不能直接修改部署目录');
  }

  if (!isRemoteProject(project) && projectInput.targetType === 'local-windows' && !samePath(project.rootPath, projectInput.rootPath)) {
    moveProjectFiles({ project, nextRootPath: projectInput.rootPath, releases: data.releases });
  }
  if (targetChanged && projectInput.targetType === 'local-windows') {
    fs.ensureDirSync(path.join(projectInput.rootPath, 'releases'));
  }

  data.projects[projectIndex] = { ...project, ...projectInput };
  db.write(data);
  return data.projects[projectIndex];
}

/**
 * 从管理器删除项目。
 * * 默认只删除元数据，保留 current 和 releases，确保当前站点仍可继续提供服务。
 */
function deleteProject({ projectId, deleteFiles = false }) {
  const data = db.read();
  const project = data.projects.find(p => p.id === projectId);
  if (!project) throw new Error('项目不存在');

  if (deleteFiles) {
    if (isRemoteProject(project)) throw new Error('远程项目文件必须通过SSH连接删除');
    const linkPath = currentLink(project);
    if (fs.existsSync(linkPath)) {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        throw new Error('current 不是 junction，已停止删除。请手动确认目录内容后再操作');
      }
      removeJunction(linkPath);
    }
    fs.removeSync(releasesDir(project));
  }

  data.projects = data.projects.filter(p => p.id !== projectId);
  data.releases = data.releases.filter(r => r.projectId !== projectId);
  db.write(data);
  return { deletedFiles: deleteFiles };
}

function validateProjectInput({
  name,
  rootPath,
  targetType = 'local-windows',
  serverId = null,
  linuxLayout,
  releaseRootPath,
  nginxControlMode,
  nginxExecutablePath,
  nginxConfigPath,
  nginxServiceName,
  nginxAccessLogPath,
  nginxErrorLogPath,
  healthCheckUrl,
  healthCheckHost,
  healthCheckTimeoutSeconds
}) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedRootPath = typeof rootPath === 'string' ? rootPath.trim() : '';
  if (!trimmedName || !trimmedRootPath) throw new Error('项目名称和目录路径不能为空');
  const normalizedTargetType = targetType === 'ssh-linux' ? 'ssh-linux' : 'local-windows';
  if (normalizedTargetType === 'ssh-linux') {
    const normalizedRoot = path.posix.normalize(trimmedRootPath);
    if (!trimmedRootPath.startsWith('/') || normalizedRoot === '/' || normalizedRoot.split('/').filter(Boolean).length < 2 || /[\0\r\n]/.test(trimmedRootPath)) {
      throw new Error('Linux部署目录必须是类似 /var/www/my-project 的独立绝对路径');
    }
    if (!serverId) throw new Error('请选择SSH服务器');
    const normalizedLayout = linuxLayout === 'legacy-live-link' ? 'legacy-live-link' : 'managed-current';
    let normalizedReleaseRoot = null;
    if (normalizedLayout === 'legacy-live-link') {
      const releaseInput = typeof releaseRootPath === 'string' ? releaseRootPath.trim() : '';
      normalizedReleaseRoot = path.posix.normalize(releaseInput);
      if (!releaseInput.startsWith('/') || normalizedReleaseRoot === '/' || normalizedReleaseRoot.split('/').filter(Boolean).length < 2 || /[\0\r\n]/.test(releaseInput)) {
        throw new Error('旧脚本版本目录必须是类似 /home/nginx/html/my-project-releases 的独立绝对路径');
      }
      const relative = path.posix.relative(normalizedRoot, normalizedReleaseRoot);
      const reverseRelative = path.posix.relative(normalizedReleaseRoot, normalizedRoot);
      if (!relative || (!relative.startsWith('..') && !path.posix.isAbsolute(relative)) || (!reverseRelative.startsWith('..') && !path.posix.isAbsolute(reverseRelative))) {
        throw new Error('线上软链接路径和版本目录不能相同或互相包含');
      }
    }
    const controlMode = nginxControlMode === 'systemd' ? 'systemd' : 'binary';
    const normalizeOptionalPath = (value, label) => {
      const input = typeof value === 'string' ? value.trim() : '';
      if (!input) return null;
      const normalized = path.posix.normalize(input);
      if (!input.startsWith('/') || normalized === '/' || /[\0\r\n]/.test(input)) {
        throw new Error(label + '必须是Linux绝对路径');
      }
      return normalized;
    };
    const executablePath = normalizeOptionalPath(nginxExecutablePath, 'Nginx可执行文件');
    const configPath = normalizeOptionalPath(nginxConfigPath, 'Nginx配置文件');
    const accessLogPath = normalizeOptionalPath(nginxAccessLogPath, 'Nginx访问日志');
    const errorLogPath = normalizeOptionalPath(nginxErrorLogPath, 'Nginx错误日志');
    const serviceName = typeof nginxServiceName === 'string' ? nginxServiceName.trim() : '';
    if (serviceName && !/^[A-Za-z0-9@._-]+$/.test(serviceName)) throw new Error('Nginx服务名格式不正确');
    const healthUrlInput = typeof healthCheckUrl === 'string' ? healthCheckUrl.trim() : '';
    let normalizedHealthUrl = null;
    if (healthUrlInput) {
      let parsedUrl;
      try {
        parsedUrl = new URL(healthUrlInput);
      } catch (_) {
        throw new Error('健康检查地址格式不正确');
      }
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
        throw new Error('健康检查地址必须是没有账号密码的HTTP或HTTPS地址');
      }
      normalizedHealthUrl = parsedUrl.toString();
    }
    const hostHeader = typeof healthCheckHost === 'string' ? healthCheckHost.trim() : '';
    if (/[\0\r\n]/.test(hostHeader) || hostHeader.length > 255) throw new Error('健康检查Host格式不正确');
    const timeoutSeconds = Number(healthCheckTimeoutSeconds || 8);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 2 || timeoutSeconds > 60) {
      throw new Error('健康检查超时必须是2到60秒的整数');
    }
    return {
      name: trimmedName,
      rootPath: normalizedRoot,
      targetType: normalizedTargetType,
      serverId,
      linuxLayout: normalizedLayout,
      releaseRootPath: normalizedReleaseRoot,
      nginxControlMode: controlMode,
      nginxExecutablePath: executablePath,
      nginxConfigPath: configPath,
      nginxServiceName: serviceName || null,
      nginxAccessLogPath: accessLogPath,
      nginxErrorLogPath: errorLogPath,
      healthCheckUrl: normalizedHealthUrl,
      healthCheckHost: hostHeader || null,
      healthCheckTimeoutSeconds: timeoutSeconds
    };
  }
  if (!path.isAbsolute(trimmedRootPath)) {
    throw new Error('目录路径必须是绝对路径，例如 D:\\sites\\my-project');
  }
  return {
    name: trimmedName,
    rootPath: path.normalize(trimmedRootPath),
    targetType: normalizedTargetType,
    serverId: null,
    linuxLayout: 'managed-current',
    releaseRootPath: null,
    nginxControlMode: 'binary',
    nginxExecutablePath: null,
    nginxConfigPath: null,
    nginxServiceName: null,
    nginxAccessLogPath: null,
    nginxErrorLogPath: null,
    healthCheckUrl: null,
    healthCheckHost: null,
    healthCheckTimeoutSeconds: 8
  };
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function sameTarget(project, input) {
  const current = normalizeProject(project);
  if (current.targetType !== input.targetType || current.serverId !== input.serverId) return false;
  return current.targetType === 'ssh-linux'
    ? current.rootPath === input.rootPath
    : samePath(current.rootPath, input.rootPath);
}

function remoteScopesOverlap(project, input) {
  const current = normalizeProject(project);
  if (current.targetType !== 'ssh-linux' || input.targetType !== 'ssh-linux' || current.serverId !== input.serverId) return false;
  const currentReleaseRoot = current.linuxLayout === 'legacy-live-link'
    ? current.releaseRootPath
    : path.posix.join(current.rootPath, 'releases');
  const inputReleaseRoot = input.linuxLayout === 'legacy-live-link'
    ? input.releaseRootPath
    : path.posix.join(input.rootPath, 'releases');
  const currentPaths = [current.rootPath, currentReleaseRoot].filter(Boolean);
  const inputPaths = [input.rootPath, inputReleaseRoot].filter(Boolean);
  return currentPaths.some(currentPath => inputPaths.some(inputPath => {
    const relative = path.posix.relative(currentPath, inputPath);
    const reverseRelative = path.posix.relative(inputPath, currentPath);
    return !relative || (!relative.startsWith('..') && !path.posix.isAbsolute(relative)) || (!reverseRelative.startsWith('..') && !path.posix.isAbsolute(reverseRelative));
  }));
}

function isNestedPath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 迁移受管版本目录，并让新旧 current 的切换窗口尽可能短。
 * ! 不允许根目录互相嵌套，否则 releases 可能被移动到自身内部。
 */
function moveProjectFiles({ project, nextRootPath, releases }) {
  if (isNestedPath(project.rootPath, nextRootPath) || isNestedPath(nextRootPath, project.rootPath)) {
    throw new Error('新旧项目目录不能互相包含，请选择独立目录');
  }

  const sourceReleases = releasesDir(project);
  const sourceCurrent = currentLink(project);
  const nextProject = { ...project, rootPath: nextRootPath };
  const targetReleases = releasesDir(nextProject);
  const targetCurrent = currentLink(nextProject);

  if (fs.existsSync(targetCurrent)) throw new Error('目标目录已存在 current，请换一个空闲目录');
  if (fs.existsSync(targetReleases) && fs.readdirSync(targetReleases).length > 0) {
    throw new Error('目标目录的 releases 不为空，请换一个空闲目录');
  }
  if (fs.existsSync(sourceCurrent) && !fs.lstatSync(sourceCurrent).isSymbolicLink()) {
    throw new Error('原目录的 current 不是 junction，已停止迁移，请先手动检查');
  }

  fs.ensureDirSync(nextRootPath);
  if (fs.existsSync(targetReleases)) fs.removeSync(targetReleases);
  if (fs.existsSync(sourceReleases)) {
    fs.moveSync(sourceReleases, targetReleases, { overwrite: false });
  } else {
    fs.ensureDirSync(targetReleases);
  }

  try {
    if (project.activeReleaseId) {
      const activeRelease = releases.find(r => r.id === project.activeReleaseId && r.projectId === project.id);
      if (!activeRelease || !fs.existsSync(path.join(targetReleases, activeRelease.folderName))) {
        throw new Error('当前线上版本文件缺失，无法迁移项目路径');
      }
      fs.symlinkSync(path.join(targetReleases, activeRelease.folderName), targetCurrent, 'junction');
    }
  } catch (error) {
    if (!fs.existsSync(sourceReleases) && fs.existsSync(targetReleases)) {
      fs.moveSync(targetReleases, sourceReleases, { overwrite: false });
    }
    throw error;
  }

  if (fs.existsSync(sourceCurrent)) removeJunction(sourceCurrent);
}

function listReleases(projectId) {
  return db.read().releases
    .filter(r => r.projectId === projectId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function deploy({ projectId, zipPath, description, activate = true }) {
  const project = getProject(projectId);
  if (isRemoteProject(project)) throw new Error('远程项目必须通过SSH部署');
  const now = new Date();
  const identity = createReleaseIdentity(now);
  const folderName = identity.folderName;
  const releasePath = path.join(releasesDir(project), folderName);

  safeExtract(zipPath, releasePath);

  const files = fs.readdirSync(releasePath);
  if (files.length === 0) {
    fs.removeSync(releasePath);
    throw new Error('压缩包解压后为空，部署已中止');
  }

  const release = recordRelease({
    id: identity.id,
    projectId,
    folderName,
    description: description || '',
    createdAt: now.toISOString(),
    sizeBytes: getDirSize(releasePath)
  });

  if (activate) {
    activateRelease({ projectId, releaseId: release.id });
  }

  return release;
}

function activateRelease({ projectId, releaseId }) {
  const project = getProject(projectId);
  if (isRemoteProject(project)) throw new Error('远程版本必须通过SSH切换');
  const release = db.read().releases.find(r => r.id === releaseId && r.projectId === projectId);
  if (!release) throw new Error('版本不存在');

  const releasePath = path.join(releasesDir(project), release.folderName);
  if (!fs.existsSync(releasePath)) {
    throw new Error('该版本的文件已丢失，无法切换');
  }

  const linkPath = currentLink(project);

  if (fs.existsSync(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    // 关键：这里只能删除 junction 本身（reparse point），绝不能对它做递归删除，
    // 否则一旦 current 不小心是个真实目录而不是 junction，会把线上文件真删掉。
    if (stat.isSymbolicLink()) {
      removeJunction(linkPath);
    } else {
      throw new Error(
        'current 目录不是一个 junction 链接（可能是历史遗留的真实目录），' +
        '为避免误删真实文件，已中止操作，请手动检查该目录后再重试'
      );
    }
  }

  // Windows 目录联接点（junction）要求目标必须是绝对路径，且创建它不需要管理员权限
  fs.symlinkSync(releasePath, linkPath, 'junction');

  setActiveRelease({ projectId, releaseId });

  return release;
}

function deleteRelease({ projectId, releaseId }) {
  const project = getProject(projectId);
  if (isRemoteProject(project)) throw new Error('远程版本必须通过SSH删除');
  const release = db.read().releases.find(r => r.id === releaseId && r.projectId === projectId);
  if (!release) throw new Error('版本不存在');
  if (project.activeReleaseId === releaseId) {
    throw new Error('不能删除当前正在线上运行的版本，请先切换到其他版本');
  }

  fs.removeSync(path.join(releasesDir(project), release.folderName));

  removeReleaseRecord({ projectId, releaseId });
}

function cleanupOldReleases({ projectId, keep = 5 }) {
  const project = getProject(projectId);
  if (isRemoteProject(project)) throw new Error('远程版本必须通过SSH清理');
  const releases = getCleanupCandidates({ projectId, keep });

  const deletedIds = [];
  for (const r of releases) {
    deleteRelease({ projectId, releaseId: r.id });
    deletedIds.push(r.id);
  }
  return deletedIds;
}

function createReleaseIdentity(now = new Date()) {
  return {
    id: 'rel_' + crypto.randomUUID(),
    folderName: `${formatTimestamp(now)}-${crypto.randomUUID().slice(0, 6)}`
  };
}

function recordRelease(release) {
  const data = db.read();
  if (!data.projects.some(project => project.id === release.projectId)) throw new Error('项目不存在');
  if (data.releases.some(item => item.id === release.id || (item.projectId === release.projectId && item.folderName === release.folderName))) {
    throw new Error('版本记录已经存在');
  }
  data.releases.push(release);
  db.write(data);
  return release;
}

function setActiveRelease({ projectId, releaseId }) {
  const data = db.read();
  const projectIndex = data.projects.findIndex(project => project.id === projectId);
  if (projectIndex < 0) throw new Error('项目不存在');
  if (!data.releases.some(release => release.id === releaseId && release.projectId === projectId)) throw new Error('版本不存在');
  const activeReleaseId = data.projects[projectIndex].activeReleaseId || null;
  if (activeReleaseId !== releaseId) {
    //* 回滚目标来自真实的上一次线上版本，不根据创建时间猜测。
    data.projects[projectIndex].previousReleaseId = activeReleaseId;
    data.projects[projectIndex].activeReleaseId = releaseId;
  }
  db.write(data);
}

function removeReleaseRecord({ projectId, releaseId }) {
  const data = db.read();
  data.releases = data.releases.filter(release => !(release.id === releaseId && release.projectId === projectId));
  const project = data.projects.find(item => item.id === projectId);
  if (project?.previousReleaseId === releaseId) project.previousReleaseId = null;
  db.write(data);
}

function getCleanupCandidates({ projectId, keep = 5 }) {
  const project = getProject(projectId);
  const releases = listReleases(projectId);
  const keepIds = new Set(releases.slice(0, keep).map(release => release.id));
  if (project.activeReleaseId) keepIds.add(project.activeReleaseId);
  if (project.previousReleaseId) keepIds.add(project.previousReleaseId);
  return releases.filter(release => !keepIds.has(release.id));
}

function getRollbackRelease(projectId) {
  const project = getProject(projectId);
  const releases = listReleases(projectId);
  const recorded = project.previousReleaseId && project.previousReleaseId !== project.activeReleaseId
    ? releases.find(release => release.id === project.previousReleaseId)
    : null;
  if (recorded) return recorded;
  const active = releases.find(release => release.id === project.activeReleaseId);
  //* 旧脚本导入时没有切换历史，只允许回到时间上紧邻且更早的版本，绝不把较新的离线版本误当成回滚。
  return active
    ? releases.find(release => release.id !== active.id && new Date(release.createdAt) < new Date(active.createdAt)) || null
    : null;
}

/**
 * 导入旧脚本已经存在的版本目录，只新增缺失记录并以远程软链接作为当前版本真值。
 * * 不删除本地历史记录，避免一次临时的远程读取异常破坏操作审计。
 */
function syncRemoteReleases({ projectId, remoteReleases, activeFolderName }) {
  const data = db.read();
  const projectIndex = data.projects.findIndex(project => project.id === projectId);
  if (projectIndex < 0) throw new Error('项目不存在');
  let addedCount = 0;
  for (const remoteRelease of remoteReleases) {
    if (data.releases.some(release => release.projectId === projectId && release.folderName === remoteRelease.folderName)) continue;
    data.releases.push({
      id: 'rel_' + crypto.randomUUID(),
      projectId,
      folderName: remoteRelease.folderName,
      description: remoteRelease.description || '从Linux服务器导入',
      createdAt: remoteRelease.createdAt,
      sizeBytes: remoteRelease.sizeBytes || 0
    });
    addedCount += 1;
  }
  const activeRelease = data.releases.find(release => release.projectId === projectId && release.folderName === activeFolderName);
  const nextActiveId = activeRelease?.id || null;
  const currentActiveId = data.projects[projectIndex].activeReleaseId || null;
  if (currentActiveId && currentActiveId !== nextActiveId) data.projects[projectIndex].previousReleaseId = currentActiveId;
  data.projects[projectIndex].activeReleaseId = nextActiveId;
  db.write(data);
  return { addedCount, activeReleaseId: activeRelease?.id || null };
}

function removeJunction(linkPath) {
  // 不同 Node 版本在 Windows 上对"目录型 reparse point"的处理有过差异，
  // 这里两种方式都尝试一下，两者都只会移除联接点本身，不会递归删除目标内容。
  try {
    fs.unlinkSync(linkPath);
  } catch (e) {
    fs.rmdirSync(linkPath);
  }
}

function formatTimestamp(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function getDirSize(dirPath) {
  let total = 0;
  for (const item of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, item.name);
    total += item.isDirectory() ? getDirSize(p) : fs.statSync(p).size;
  }
  return total;
}

module.exports = {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listReleases,
  deploy,
  activateRelease,
  deleteRelease,
  cleanupOldReleases,
  isRemoteProject,
  createReleaseIdentity,
  recordRelease,
  setActiveRelease,
  removeReleaseRecord,
  getCleanupCandidates,
  getRollbackRelease,
  syncRemoteReleases
};
