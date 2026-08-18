const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const config = require('./config');
const deployLib = require('./lib/deploy');
const remoteDeploy = require('./lib/remoteDeploy');
const servers = require('./lib/servers');
const operations = require('./lib/operations');
const nginx = require('./lib/nginx');
const remoteTools = require('./lib/remoteTools');
const runtimeLogs = require('./lib/runtimeLogs');

operations.recoverInterrupted();

const app = express();
app.use(express.json());

function projectIdFromPath(requestPath) {
  return requestPath.match(/^\/api\/projects\/([^/]+)/)?.[1] || null;
}

//* 只记录API摘要；日志查询自身不进入日志流，避免轮询制造噪声。
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || req.path.endsWith('/logs')) return next();
  const startedAt = Date.now();
  res.on('finish', () => runtimeLogs.write({
    level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    source: 'http',
    projectId: projectIdFromPath(req.path),
    message: `${req.method} ${req.path} · ${res.statusCode} · ${Date.now() - startedAt}ms`
  }));
  next();
});
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
      runtimeLogs.write({
        level: 'error',
        source: 'api',
        projectId: projectIdFromPath(req.path),
        message: `${req.method} ${req.path} · ${error.message}`
      });
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
  runtimeLogs.write({ source: 'operation', projectId, message: `${title} · 开始` });
  try {
    const result = await action(project);
    operations.succeed(operation.id, result || null);
    runtimeLogs.write({ source: 'operation', projectId, message: `${title} · 完成` });
    return result;
  } catch (error) {
    operations.fail(operation.id, error);
    runtimeLogs.write({ level: 'error', source: 'operation', projectId, message: `${title} · ${error.message}` });
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
  releaseCount: deployLib.listReleases(project.id).length,
  rollbackRelease: deployLib.getRollbackRelease(project.id)
}))));

app.post('/api/projects', handle(req => {
  validateRemoteServer(req.body.targetType, req.body.serverId);
  return deployLib.createProject(req.body);
}));

app.patch('/api/projects/:projectId', handle(req => {
  validateRemoteServer(req.body.targetType, req.body.serverId);
  return deployLib.updateProject({ projectId: req.params.projectId, ...req.body });
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

app.get('/api/projects/:projectId/logs', handle(req => {
  const project = deployLib.getProject(req.params.projectId);
  const source = req.query.source || 'manager';
  if (source === 'manager') {
    return {
      source,
      label: 'Deploy Manager',
      path: '当前管理器进程 · 内存环形缓冲区',
      entries: runtimeLogs.list({ projectId: project.id, limit: req.query.lines, query: req.query.query }),
      checkedAt: new Date().toISOString()
    };
  }
  if (!deployLib.isRemoteProject(project)) throw new Error('本地Windows项目只提供Deploy Manager日志');
  return remoteTools.readProjectLogs({
    projectId: project.id,
    source,
    lines: req.query.lines,
    query: req.query.query
  });
}));

app.post('/api/projects/:projectId/nginx/validate', handle(req => recordedAction({
  projectId: req.params.projectId,
  type: 'nginx-validate',
  title: '校验Nginx配置',
  action: () => nginx.validateProject({
    projectId: req.params.projectId,
    password: req.body.password,
    passphrase: req.body.passphrase
  })
})));

for (const action of ['reload', 'restart']) {
  app.post('/api/projects/:projectId/nginx/' + action, handle(req => recordedAction({
    projectId: req.params.projectId,
    type: 'nginx-' + action,
    title: action === 'reload' ? '重新加载Nginx' : '重启Nginx',
    action: () => nginx.controlProject({
      projectId: req.params.projectId,
      action,
      password: req.body.password,
      passphrase: req.body.passphrase
    })
  })));
}

app.post('/api/projects/:projectId/health', handle(req => recordedAction({
  projectId: req.params.projectId,
  type: 'health-check',
  title: '站点健康检查',
  action: () => nginx.healthCheckProject({
    projectId: req.params.projectId,
    password: req.body.password,
    passphrase: req.body.passphrase
  })
})));

app.post('/api/projects/:projectId/rollback', handle(req => recordedAction({
  projectId: req.params.projectId,
  type: 'rollback',
  title: '一键回滚',
  action: async project => {
    const release = deployLib.getRollbackRelease(project.id);
    if (!release) throw new Error('没有可回滚的上一个线上版本');
    if (deployLib.isRemoteProject(project)) {
      await remoteDeploy.activateRelease({
        projectId: project.id,
        releaseId: release.id,
        password: req.body.password,
        passphrase: req.body.passphrase
      });
    } else {
      deployLib.activateRelease({ projectId: project.id, releaseId: release.id });
    }
    const health = deployLib.isRemoteProject(project)
      ? await nginx.healthCheckProject({ projectId: project.id, password: req.body.password, passphrase: req.body.passphrase })
      : { configured: false, ok: null };
    return { release, health };
  }
})));

app.post('/api/projects/:projectId/diagnostics', handle(req => recordedAction({
  projectId: req.params.projectId,
  type: 'diagnostics',
  title: '远程环境诊断',
  action: () => remoteTools.diagnoseProject({
    projectId: req.params.projectId,
    password: req.body.password,
    passphrase: req.body.passphrase
  })
})));

app.get('/api/projects/:projectId/files', handle(req => remoteTools.browseProject({
  projectId: req.params.projectId,
  scope: req.query.scope,
  relativePath: req.query.path
})));

app.get('/api/projects/:projectId/files/content', handle(req => remoteTools.readProjectFile({
  projectId: req.params.projectId,
  scope: req.query.scope,
  relativePath: req.query.path
})));

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
  runtimeLogs.write({ source: 'operation', projectId: project.id, message: `部署新版本 · ${project.name} · 开始` });
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
      let health = { configured: false, ok: null };
      if (activate && deployLib.isRemoteProject(project) && project.healthCheckUrl) {
        operations.update(operation.id, { stage: '站点健康检查', progress: 98, detail: project.healthCheckUrl });
        health = await nginx.healthCheckProject({
          projectId: project.id,
          password: req.body.password,
          passphrase: req.body.passphrase
        });
      }
      operations.succeed(operation.id, { release, activate, health });
      runtimeLogs.write({ source: 'operation', projectId: project.id, message: `部署新版本 · ${release.folderName} · 完成` });
    } catch (error) {
      operations.fail(operation.id, error);
      runtimeLogs.write({ level: 'error', source: 'operation', projectId: project.id, message: `部署新版本 · ${error.message}` });
    } finally {
      fs.remove(req.file.path).catch(() => {});
    }
  });
});

app.post('/api/projects/:projectId/releases/:releaseId/activate', handle(req => recordedAction({
  projectId: req.params.projectId,
  type: 'activate',
  title: '切换线上版本',
  action: async project => {
    const release = deployLib.isRemoteProject(project)
      ? await remoteDeploy.activateRelease({
        projectId: project.id,
        releaseId: req.params.releaseId,
        password: req.body.password,
        passphrase: req.body.passphrase
      })
      : deployLib.activateRelease({ projectId: project.id, releaseId: req.params.releaseId });
    const health = deployLib.isRemoteProject(project)
      ? await nginx.healthCheckProject({ projectId: project.id, password: req.body.password, passphrase: req.body.passphrase })
      : { configured: false, ok: null };
    return { release, health };
  }
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
  runtimeLogs.write({ source: 'system', message: `服务已启动 · http://${config.host}:${config.port}` });
  console.log(`部署管理服务已启动: http://${config.host}:${config.port}`);
  console.log(config.host === '127.0.0.1'
    ? '当前仅允许本机访问，可通过HOST环境变量显式开放到可信网络'
    : '当前已开放网络访问，请确保只处于可信网络并尽快配置访问认证');
});
