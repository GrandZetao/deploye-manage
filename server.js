const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const config = require('./config');
const deployLib = require('./lib/deploy');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

fs.ensureDirSync(config.uploadTmpDir);
const upload = multer({
  dest: config.uploadTmpDir,
  limits: { fileSize: config.maxUploadSizeMB * 1024 * 1024 }
});

function handle(fn) {
  return (req, res) => {
    try {
      res.json(fn(req));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };
}

// ---- 项目管理 ----
app.get('/api/projects', handle(() =>
  deployLib.listProjects().map(p => ({
    ...p,
    releaseCount: deployLib.listReleases(p.id).length
  }))
));

app.post('/api/projects', handle(req => {
  const { name, rootPath } = req.body;
  return deployLib.createProject({ name, rootPath });
}));

app.patch('/api/projects/:projectId', handle(req => {
  const { name, rootPath } = req.body;
  return deployLib.updateProject({ projectId: req.params.projectId, name, rootPath });
}));

app.delete('/api/projects/:projectId', handle(req =>
  deployLib.deleteProject({
    projectId: req.params.projectId,
    deleteFiles: req.body.deleteFiles === true
  })
));

// ---- 版本列表 ----
app.get('/api/projects/:projectId/releases', handle(req => ({
  releases: deployLib.listReleases(req.params.projectId),
  activeReleaseId: deployLib.getProject(req.params.projectId).activeReleaseId
})));

// ---- 部署新版本（上传 zip + 更新说明） ----
app.post('/api/projects/:projectId/deploy', upload.single('file'), (req, res) => {
  try {
    if (!req.file) throw new Error('未收到压缩包文件');
    const release = deployLib.deploy({
      projectId: req.params.projectId,
      zipPath: req.file.path,
      description: req.body.description || '',
      activate: req.body.activate !== 'false'
    });
    res.json(release);
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    if (req.file) fs.remove(req.file.path).catch(() => {});
  }
});

// ---- 切换/回滚到指定版本 ----
app.post('/api/projects/:projectId/releases/:releaseId/activate', handle(req =>
  deployLib.activateRelease({ projectId: req.params.projectId, releaseId: req.params.releaseId })
));

// ---- 删除单个历史版本 ----
app.delete('/api/projects/:projectId/releases/:releaseId', handle(req => {
  deployLib.deleteRelease({ projectId: req.params.projectId, releaseId: req.params.releaseId });
  return { ok: true };
}));

// ---- 批量清理旧版本（保留最近 N 个 + 当前线上版本） ----
app.post('/api/projects/:projectId/cleanup', handle(req => {
  const keep = Number(req.body.keep);
  if (!Number.isInteger(keep) || keep < 0) throw new Error('保留版本数必须是非负整数');
  const deletedIds = deployLib.cleanupOldReleases({ projectId: req.params.projectId, keep });
  return { deletedCount: deletedIds.length, deletedIds };
}));

app.listen(config.port, () => {
  console.log(`部署管理服务已启动: http://localhost:${config.port}`);
  console.log('当前未启用登录验证，请确保这个端口只有你自己能访问到（不要暴露在公网/未受信任的网络）');
});
