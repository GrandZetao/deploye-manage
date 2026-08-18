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

function listProjects() {
  return db.read().projects;
}

function getProject(projectId) {
  const project = db.read().projects.find(p => p.id === projectId);
  if (!project) throw new Error('项目不存在');
  return project;
}

function createProject({ name, rootPath }) {
  const projectInput = validateProjectInput({ name, rootPath });
  const data = db.read();
  if (data.projects.some(p => p.name.toLowerCase() === projectInput.name.toLowerCase())) {
    throw new Error('项目名称已存在');
  }
  if (data.projects.some(p => samePath(p.rootPath, projectInput.rootPath))) {
    throw new Error('该目录已经绑定到其他项目');
  }
  const project = {
    id: 'proj_' + crypto.randomUUID(),
    ...projectInput,
    createdAt: new Date().toISOString(),
    activeReleaseId: null
  };
  fs.ensureDirSync(releasesDir(project));
  data.projects.push(project);
  db.write(data);
  return project;
}

/**
 * 修改项目名称或部署根目录。
 * * 路径变化时只迁移 Deploy Manager 管理的 releases，并重建 current；根目录里的其他文件保持原样。
 * ! 目标目录已有 releases/current 时必须中止，避免合并或覆盖不属于当前项目的线上文件。
 */
function updateProject({ projectId, name, rootPath }) {
  const projectInput = validateProjectInput({ name, rootPath });
  const data = db.read();
  const projectIndex = data.projects.findIndex(p => p.id === projectId);
  if (projectIndex < 0) throw new Error('项目不存在');

  const project = data.projects[projectIndex];
  if (data.projects.some(p => p.id !== projectId && p.name.toLowerCase() === projectInput.name.toLowerCase())) {
    throw new Error('项目名称已存在');
  }
  if (data.projects.some(p => p.id !== projectId && samePath(p.rootPath, projectInput.rootPath))) {
    throw new Error('该目录已经绑定到其他项目');
  }

  if (!samePath(project.rootPath, projectInput.rootPath)) {
    moveProjectFiles({ project, nextRootPath: projectInput.rootPath, releases: data.releases });
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

function validateProjectInput({ name, rootPath }) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedRootPath = typeof rootPath === 'string' ? rootPath.trim() : '';
  if (!trimmedName || !trimmedRootPath) throw new Error('项目名称和目录路径不能为空');
  if (!path.isAbsolute(trimmedRootPath)) {
    throw new Error('目录路径必须是绝对路径，例如 D:\\sites\\my-project');
  }
  return { name: trimmedName, rootPath: path.normalize(trimmedRootPath) };
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
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
  const now = new Date();
  const folderName = `${formatTimestamp(now)}-${crypto.randomUUID().slice(0, 6)}`;
  const releasePath = path.join(releasesDir(project), folderName);

  safeExtract(zipPath, releasePath);

  const files = fs.readdirSync(releasePath);
  if (files.length === 0) {
    fs.removeSync(releasePath);
    throw new Error('压缩包解压后为空，部署已中止');
  }

  const release = {
    id: 'rel_' + crypto.randomUUID(),
    projectId,
    folderName,
    description: description || '',
    createdAt: now.toISOString(),
    sizeBytes: getDirSize(releasePath)
  };

  const data = db.read();
  data.releases.push(release);
  db.write(data);

  if (activate) {
    activateRelease({ projectId, releaseId: release.id });
  }

  return release;
}

function activateRelease({ projectId, releaseId }) {
  const project = getProject(projectId);
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

  const data = db.read();
  const idx = data.projects.findIndex(p => p.id === projectId);
  data.projects[idx].activeReleaseId = releaseId;
  db.write(data);

  return release;
}

function deleteRelease({ projectId, releaseId }) {
  const project = getProject(projectId);
  const release = db.read().releases.find(r => r.id === releaseId && r.projectId === projectId);
  if (!release) throw new Error('版本不存在');
  if (project.activeReleaseId === releaseId) {
    throw new Error('不能删除当前正在线上运行的版本，请先切换到其他版本');
  }

  fs.removeSync(path.join(releasesDir(project), release.folderName));

  const data = db.read();
  data.releases = data.releases.filter(r => r.id !== releaseId);
  db.write(data);
}

function cleanupOldReleases({ projectId, keep = 5 }) {
  const project = getProject(projectId);
  const releases = listReleases(projectId); // 按时间倒序

  const keepIds = new Set(releases.slice(0, keep).map(r => r.id));
  if (project.activeReleaseId) keepIds.add(project.activeReleaseId); // 无论如何都不清理当前线上版本

  const deletedIds = [];
  for (const r of releases) {
    if (!keepIds.has(r.id)) {
      deleteRelease({ projectId, releaseId: r.id });
      deletedIds.push(r.id);
    }
  }
  return deletedIds;
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
  cleanupOldReleases
};
