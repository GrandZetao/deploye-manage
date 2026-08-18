const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const config = require('./config');
const deployLib = require('./lib/deploy');
const remoteDeploy = require('./lib/remoteDeploy');
const servers = require('./lib/servers');
const operations = require('./lib/operations');

operations.recoverInterrupted();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

fs.ensureDirSync(config.uploadTmpDir);
const upload = multer({
  dest: config.uploadTmpDir,
  limits: { fileSize: config.maxUploadSizeMB * 1024 * 1024 }
});

function errorPayload(error) {
  return {
    error: error.message,
    code: error.code || 'REQUEST_FAILED',
    details: error.details || null
  };
}

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (error) {
      res.status(400).json(errorPayload(error));
    }
  };
}

function validateRemoteServer(targetType, serverId) {
  if (targetType === 'ssh-linux') servers.getServer(serverId);
}

async function recordedAction({ projectId, type, title, action }) {
  const project = deployLib.getProject(projectId);
  const operation = operations.create({ projectId, serverId: project.serverId, type, title });
  try {
    const result = await action(project);
    operations.succeed(operation.id, result || null);
    return result;
  } catch (error) {
    operations.fail(operation.id, error);
    throw error;
  }
}

// ---- SSH服务器 ----
app.get('/api/servers', handle(() => servers.listServers()));
app.post('/api/servers', handle(req => servers.createServer(req.body)));
app.patch('/api/servers/:serverId', handle(req => servers.updateServer({ serverId: req.params.serverId, ...req.body })));
app.delete('/api/servers/:serverId', handle(req => {
  servers.deleteServer(req.params.serverId);
  return { ok: true };
}));
app.delete('/api/servers/:serverId/session', handle(req => servers.disconnectServer(req.params.serverId)));
app.post('/api/servers/:serverId/test', handle(req => servers.testServer({
  serverId: req.params.serverId,
  password: req.body.password,
  passphrase: req.body.passphrase,
  acceptNewHost: req.body.acceptNewHost === true
})));

// ---- 项目管理 ----
app.get('/api/projects', handle(() => deployLib.listProjects().map(project => ({
  ...project,
  releaseCount: deployLib.listReleases(project.id).length
}))));

app.post('/api/projects', handle(req => {
  const { name, rootPath, targetType, serverId, linuxLayout, releaseRootPath } = req.body;
  validateRemoteServer(targetType, serverId);
  return deployLib.createProject({ name, rootPath, targetType, serverId, linuxLayout, releaseRootPath });
}));

app.patch('/api/projects/:projectId', handle(req => {
  const { name, rootPath, targetType, serverId, linuxLayout, releaseRootPath } = req.body;
  validateRemoteServer(targetType, serverId);
  return deployLib.updateProject({
    projectId: req.params.projectId,
    name,
    rootPath,
    targetType,
    serverId,
    linuxLayout,
    releaseRootPath
  });
}));

app.delete('/api/projects/:projectId', handle(async req => {
  const project = deployLib.getProject(req.params.projectId);
  const deleteFiles = req.body.deleteFiles === true;
  if (deleteFiles && deployLib.isRemoteProject(project)) {
    await remoteDeploy.deleteProjectFiles({
      projectId: project.id,
      password: req.body.password,
      passphrase: req.body.passphrase
    });
    deployLib.deleteProject({ projectId: project.id, deleteFiles: false });
    return { deletedFiles: true };
  }
  return deployLib.deleteProject({ projectId: project.id, deleteFiles });
}));

// ---- 版本与操作记录 ----
app.get('/api/projects/:projectId/releases', handle(req => ({
  releases: deployLib.listReleases(req.params.projectId),
  activeReleaseId: deployLib.getProject(req.params.projectId).activeReleaseId
})));
app.get('/api/projects/:projectId/operations', handle(req => operations.list({ projectId: req.params.projectId, limit: req.query.limit })));
app.get('/api/operations/:operationId', handle(req => operations.get(req.params.operationId)));

app.post('/api/projects/:projectId/sync', handle(req => recordedAction({
  projectId: req.params.projectId,
  type: 'sync-remote',
  title: '同步Linux历史版本',
  action: project => {
    if (!deployLib.isRemoteProject(project)) throw new Error('只有Linux项目需要同步远程版本');
    return remoteDeploy.syncProject({
      projectId: project.id,
      password: req.body.password,
      passphrase: req.body.passphrase
    });
  }
})));

/**
 * 上传完成后立即返回operationId，实际部署在后台执行。
 * * 本地和远程项目共用同一进度协议，前端不需要维护两套发布交互。
 */
app.post('/api/projects/:projectId/deploy', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json(errorPayload(new Error('未收到压缩包文件')));
    return;
  }

  let project;
  try {
    project = deployLib.getProject(req.params.projectId);
  } catch (error) {
    fs.remove(req.file.path).catch(() => {});
    res.status(400).json(errorPayload(error));
    return;
  }

  const activate = req.body.activate !== 'false';
  const operation = operations.create({
    projectId: project.id,
    serverId: project.serverId,
    type: 'deploy',
    title: `部署新版本 · ${project.name}`
  });
  res.status(202).json(operation);

  Promise.resolve().then(async () => {
    try {
      let release;
      if (deployLib.isRemoteProject(project)) {
        release = await remoteDeploy.deploy({
          projectId: project.id,
          zipPath: req.file.path,
          description: req.body.description || '',
          activate,
          password: req.body.password,
          passphrase: req.body.passphrase,
          onProgress: (stage, progress, detail) => operations.update(operation.id, { stage, progress, detail })
        });
      } else {
        operations.update(operation.id, { stage: '解压本地版本', progress: 45, detail: '正在校验并解压构建产物' });
        release = deployLib.deploy({
          projectId: project.id,
          zipPath: req.file.path,
          description: req.body.description || '',
          activate
        });
      }
      operations.succeed(operation.id, { release, activate });
    } catch (error) {
      operations.fail(operation.id, error);
    } finally {
      fs.remove(req.file.path).catch(() => {});
    }
  });
});

app.post('/api/projects/:projectId/releases/:releaseId/activate', handle(req => recordedAction({
  projectId: req.params.projectId,
  type: 'activate',
  title: '切换线上版本',
  action: project => deployLib.isRemoteProject(project)
    ? remoteDeploy.activateRelease({
      projectId: project.id,
      releaseId: req.params.releaseId,
      password: req.body.password,
      passphrase: req.body.passphrase
    })
    : deployLib.activateRelease({ projectId: project.id, releaseId: req.params.releaseId })
})));

app.delete('/api/projects/:projectId/releases/:releaseId', handle(req => recordedAction({
  projectId: req.params.projectId,
  type: 'delete-release',
  title: '删除历史版本',
  action: async project => {
    if (deployLib.isRemoteProject(project)) {
      await remoteDeploy.deleteRelease({
        projectId: project.id,
        releaseId: req.params.releaseId,
        password: req.body.password,
        passphrase: req.body.passphrase
      });
    } else {
      deployLib.deleteRelease({ projectId: project.id, releaseId: req.params.releaseId });
    }
    return { ok: true };
  }
})));

app.post('/api/projects/:projectId/cleanup', handle(req => {
  const keep = Number(req.body.keep);
  if (!Number.isInteger(keep) || keep < 0) throw new Error('保留版本数必须是非负整数');
  return recordedAction({
    projectId: req.params.projectId,
    type: 'cleanup',
    title: '清理旧版本',
    action: async project => {
      const deletedIds = deployLib.isRemoteProject(project)
        ? await remoteDeploy.cleanupOldReleases({
          projectId: project.id,
          keep,
          password: req.body.password,
          passphrase: req.body.passphrase
        })
        : deployLib.cleanupOldReleases({ projectId: project.id, keep });
      return { deletedCount: deletedIds.length, deletedIds };
    }
  });
}));

app.listen(config.port, config.host, () => {
  console.log(`部署管理服务已启动: http://${config.host}:${config.port}`);
  console.log(config.host === '127.0.0.1'
    ? '当前仅允许本机访问，可通过HOST环境变量显式开放到可信网络'
    : '当前已开放网络访问，请确保只处于可信网络并尽快配置访问认证');
});
