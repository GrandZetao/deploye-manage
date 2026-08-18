const state = {
  projects: [],
  servers: [],
  currentProjectId: null,
  currentServerId: null,
  releases: [],
  activeReleaseId: null,
  projectDialogMode: 'create',
  fileScope: 'site',
  filePath: '',
  logLive: true,
  logTimer: null,
  logController: null
};

const el = Object.fromEntries([
  'projectList', 'emptyState', 'projectView', 'projectName', 'projectPath', 'projectStatus',
  'projectTarget', 'targetSummary', 'activeVersion', 'releaseCount', 'releaseSize', 'timeline', 'cleanupBtn',
  'syncRemoteBtn', 'remoteOpsBar', 'nginxStateCopy', 'remoteSessionChip',
  'nginxPanelBtn', 'healthCheckBtn', 'rollbackBtn', 'diagnosticsBtn', 'fileBrowserBtn', 'logsBtn',
  'deployDialog', 'deployForm', 'deployError', 'deploySubmitBtn', 'deployTargetCopy',
  'deployCredentialField', 'deployCredentialLabel', 'deployProgress', 'deployStage', 'deployPercent',
  'deployProgressBar', 'deployDetail',
  'projectDialog', 'projectForm', 'projectDialogTitle', 'projectSubmitBtn', 'projectError',
  'projectTargetType', 'projectServerField', 'projectServerSelect', 'linuxLayoutField', 'linuxLayoutSelect',
  'releaseRootField', 'projectRootLabel', 'projectRootHint', 'linuxOpsFields',
  'nginxControlMode', 'nginxServiceField',
  'pathMigrationHint', 'deleteProjectBtn', 'deleteProjectDialog', 'deleteProjectForm',
  'deleteProjectName', 'deleteProjectSubmitBtn', 'deleteProjectError', 'deleteProjectCredentialField',
  'deleteProjectCredentialLabel', 'cleanupDialog', 'cleanupForm', 'cleanupSubmitBtn', 'cleanupError',
  'cleanupCredentialField', 'cleanupCredentialLabel',
  'confirmDialog', 'confirmKicker', 'confirmTitle', 'confirmMessage', 'confirmSubmitBtn',
  'confirmCredentialField', 'confirmCredentialLabel', 'confirmCredential',
  'serverDialog', 'serverList', 'serverForm', 'serverAuthType', 'privateKeyField', 'serverCredentialLabel',
  'serverFingerprint', 'serverSessionStatus', 'serverTestResult', 'serverSubmitBtn', 'serverError',
  'deleteServerBtn', 'disconnectServerBtn',
  'operationsDialog', 'operationList',
  'nginxDialog', 'nginxTargetCopy', 'nginxOutput', 'nginxValidateBtn', 'nginxReloadBtn', 'nginxRestartBtn',
  'diagnosticsDialog', 'diagnosticsOutput',
  'fileBrowserDialog', 'fileScopeSelect', 'fileBrowserPath', 'fileList', 'filePreviewName',
  'filePreviewMeta', 'filePreviewContent', 'fileBrowserError', 'fileUpBtn', 'fileRefreshBtn',
  'logsDialog', 'logSourceSelect', 'logQueryInput', 'logLinesSelect', 'logsLiveBtn', 'logsRefreshBtn',
  'logsStatus', 'logsPath', 'logStream', 'logsError',
  'toastRegion'
].map(id => [id, document.getElementById(id)]));

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const error = new Error((data && data.error) || `请求失败 (${res.status})`);
    error.code = data?.code;
    error.details = data?.details;
    throw error;
  }
  return data;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function currentProject() {
  return state.projects.find(project => project.id === state.currentProjectId);
}

function serverForProject(project = currentProject()) {
  return project ? state.servers.find(server => server.id === project.serverId) : null;
}

function isRemoteProject(project = currentProject()) {
  return project?.targetType === 'ssh-linux';
}

function isLegacyLayout(project = currentProject()) {
  return isRemoteProject(project) && project?.linuxLayout === 'legacy-live-link';
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  el.toastRegion.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 180);
  }, 3200);
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  //* 内网 IP 常通过 HTTP 打开，Clipboard API 不可用时保留传统复制路径。
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('浏览器不允许复制');
}

// ---------- 项目与版本 ----------

async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjectList();
}

async function loadServers() {
  state.servers = await api('/api/servers');
  renderServerList();
  renderServerOptions();
}

function projectTargetText(project) {
  if (!isRemoteProject(project)) return 'Windows 本机';
  const layout = isLegacyLayout(project) ? 'Linux旧脚本' : 'Linux';
  return `${layout} · ${serverForProject(project)?.name || '服务器缺失'}`;
}

function renderProjectList() {
  if (state.projects.length === 0) {
    el.projectList.innerHTML = '<div class="project-list-empty"><strong>还没有项目</strong><span>创建后会在这里显示版本状态。</span></div>';
    return;
  }

  el.projectList.innerHTML = state.projects.map(project => `
    <button class="project-item ${project.id === state.currentProjectId ? 'active' : ''}" data-id="${escapeHtml(project.id)}">
      <span class="project-item-main">
        <span class="p-name">${escapeHtml(project.name)}</span>
        ${project.activeReleaseId ? '<span class="live-dot" title="已有线上版本"></span>' : ''}
      </span>
      <span class="p-meta">${escapeHtml(projectTargetText(project))} · ${project.releaseCount} 个版本</span>
    </button>
  `).join('');

  el.projectList.querySelectorAll('.project-item').forEach(button => {
    button.addEventListener('click', () => selectProject(button.dataset.id));
  });
}

function showEmptyState() {
  el.emptyState.hidden = false;
  el.projectView.hidden = true;
}

async function selectProject(projectId) {
  const project = state.projects.find(item => item.id === projectId);
  if (!project) {
    state.currentProjectId = null;
    showEmptyState();
    renderProjectList();
    return;
  }

  state.currentProjectId = projectId;
  localStorage.setItem('deploy-manager:last-project', projectId);
  renderProjectList();
  el.emptyState.hidden = true;
  el.projectView.hidden = false;
  el.projectName.textContent = project.name;
  el.projectPath.textContent = isRemoteProject(project)
    ? isLegacyLayout(project) ? project.rootPath : `${project.rootPath}/current`
    : `${project.rootPath}\\current`;
  el.syncRemoteBtn.hidden = !isRemoteProject(project);
  el.remoteOpsBar.hidden = !isRemoteProject(project);
  if (isRemoteProject(project)) {
    const server = serverForProject(project);
    el.remoteSessionChip.textContent = server?.sessionReady ? 'SSH已连接' : 'SSH未连接';
    el.remoteSessionChip.classList.toggle('is-connected', Boolean(server?.sessionReady));
    el.nginxStateCopy.textContent = project.nginxExecutablePath
      ? (project.nginxControlMode === 'systemd' ? project.nginxServiceName : project.nginxExecutablePath)
      : 'Nginx尚未配置';
    el.nginxPanelBtn.disabled = !project.nginxExecutablePath;
    el.healthCheckBtn.disabled = !project.healthCheckUrl;
    el.rollbackBtn.disabled = !project.rollbackRelease;
  }
  el.projectTarget.textContent = projectTargetText(project);
  el.projectTarget.classList.toggle('is-local', !isRemoteProject(project));

  try {
    const result = await api(`/api/projects/${projectId}/releases`);
    //* 忽略快速切换项目后才返回的旧请求，避免时间线显示到另一个项目下。
    if (state.currentProjectId !== projectId) return;
    state.releases = result.releases;
    state.activeReleaseId = result.activeReleaseId;
    renderProjectSummary();
    renderTimeline();
  } catch (error) {
    showToast(`版本加载失败：${error.message}`, 'error');
  }
}

function renderProjectSummary() {
  const project = currentProject();
  const activeRelease = state.releases.find(release => release.id === state.activeReleaseId);
  const totalSize = state.releases.reduce((total, release) => total + release.sizeBytes, 0);
  el.projectStatus.textContent = activeRelease ? '线上运行中' : '尚未上线';
  el.projectStatus.classList.toggle('is-online', Boolean(activeRelease));
  el.activeVersion.textContent = activeRelease ? activeRelease.folderName : '—';
  el.releaseCount.textContent = state.releases.length;
  el.releaseSize.textContent = fmtSize(totalSize);
  el.targetSummary.textContent = projectTargetText(project);
  el.cleanupBtn.disabled = state.releases.length === 0;
}

function renderTimeline() {
  if (state.releases.length === 0) {
    el.timeline.innerHTML = `
      <div class="timeline-empty">
        <strong>还没有版本</strong>
        <span>点击“部署新版本”，上传第一个 zip 构建产物。</span>
      </div>`;
    return;
  }

  el.timeline.innerHTML = state.releases.map(release => {
    const isLive = release.id === state.activeReleaseId;
    return `
      <article class="release ${isLive ? 'is-live' : ''}">
        <div class="release-card">
          <div class="release-top">
            <div>
              <span class="release-time">${fmtTime(release.createdAt)}</span>
              ${isLive ? '<span class="live-badge">当前线上</span>' : ''}
            </div>
            <span class="release-size">${fmtSize(release.sizeBytes)}</span>
          </div>
          <p class="release-desc">${escapeHtml(release.description)}</p>
          <div class="release-bottom">
            <code>${escapeHtml(release.folderName)}</code>
            <div class="release-actions">
              ${isLive ? '' : `<button class="btn btn-sm btn-secondary" data-action="activate" data-id="${escapeHtml(release.id)}">切换上线</button>`}
              ${isLive ? '' : `<button class="btn btn-sm btn-ghost btn-danger" data-action="delete" data-id="${escapeHtml(release.id)}">删除版本</button>`}
            </div>
          </div>
        </div>
      </article>`;
  }).join('');

  el.timeline.querySelectorAll('[data-action="activate"]').forEach(button => {
    button.addEventListener('click', () => activateRelease(button.dataset.id));
  });
  el.timeline.querySelectorAll('[data-action="delete"]').forEach(button => {
    button.addEventListener('click', () => deleteRelease(button.dataset.id));
  });
}

let confirmResolver = null;
let confirmedCredential = '';

function confirmAction({ title, message, confirmText, danger = false, credentialServer = null }) {
  el.confirmKicker.textContent = danger ? 'Destructive action' : 'Release action';
  el.confirmKicker.classList.toggle('danger-text', danger);
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmSubmitBtn.textContent = confirmText;
  el.confirmSubmitBtn.className = danger ? 'btn btn-danger-solid' : 'btn btn-primary';
  const needsCredential = credentialServer && !credentialServer.sessionReady;
  el.confirmCredentialField.hidden = !needsCredential;
  el.confirmCredential.value = '';
  if (needsCredential) {
    el.confirmCredentialLabel.textContent = credentialServer.authType === 'password'
      ? 'SSH密码（连接后仅保存在本机进程内存）'
      : '私钥口令（连接后仅保存在本机进程内存）';
  }
  el.confirmDialog.showModal();
  return new Promise(resolve => { confirmResolver = resolve; });
}

function closeConfirm(result) {
  confirmedCredential = result && !el.confirmCredentialField.hidden ? el.confirmCredential.value : '';
  el.confirmDialog.close();
  if (confirmResolver) confirmResolver(result);
  confirmResolver = null;
}

document.getElementById('confirmCancelBtn').addEventListener('click', () => closeConfirm(false));
el.confirmSubmitBtn.addEventListener('click', () => closeConfirm(true));
el.confirmDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeConfirm(false);
});

function remoteActionHint(error) {
  return error.code === 'CREDENTIALS_REQUIRED'
    ? '需要SSH凭据，请先在“SSH服务器”中执行一次连接测试'
    : error.message;
}

async function activateRelease(releaseId) {
  const release = state.releases.find(item => item.id === releaseId);
  if (!release) return;
  const server = serverForProject();
  const confirmed = await confirmAction({
    title: '切换线上版本',
    message: `${fmtTime(release.createdAt)}\n${release.description || '未填写更新说明'}\n\n新请求会立即访问这个版本。`,
    confirmText: '确认切换',
    credentialServer: isRemoteProject() ? server : null
  });
  if (!confirmed) return;

  try {
    const body = {};
    if (server && !server.sessionReady) body[server.authType === 'password' ? 'password' : 'passphrase'] = confirmedCredential;
    const result = await api('/api/projects/' + state.currentProjectId + '/releases/' + releaseId + '/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    await loadProjects();
    await selectProject(state.currentProjectId);
    const suffix = result.health?.configured ? '；' + healthResultText(result.health) : '';
    showToast('线上版本已切换' + suffix, result.health?.configured && !result.health.ok ? 'error' : 'success');
  } catch (error) {
    showToast(`切换失败：${remoteActionHint(error)}`, 'error');
  }
}

async function deleteRelease(releaseId) {
  const release = state.releases.find(item => item.id === releaseId);
  if (!release) return;
  const server = serverForProject();
  const confirmed = await confirmAction({
    title: '删除这个版本？',
    message: `${fmtTime(release.createdAt)}\n${release.description || '未填写更新说明'}\n\n版本文件将永久删除，无法恢复。`,
    confirmText: '删除版本',
    danger: true,
    credentialServer: isRemoteProject() ? server : null
  });
  if (!confirmed) return;

  try {
    const body = {};
    if (server && !server.sessionReady) body[server.authType === 'password' ? 'password' : 'passphrase'] = confirmedCredential;
    await api(`/api/projects/${state.currentProjectId}/releases/${releaseId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    await selectProject(state.currentProjectId);
    await loadProjects();
    showToast('版本已删除');
  } catch (error) {
    showToast(`删除失败：${remoteActionHint(error)}`, 'error');
  }
}

// ---------- 部署 ----------

function configureCredentialField(field, label, project) {
  const server = serverForProject(project);
  field.hidden = !isRemoteProject(project) || Boolean(server?.sessionReady);
  if (!server) return;
  label.textContent = server.authType === 'password'
    ? 'SSH密码（连接后仅保存在本机进程内存）'
    : '私钥口令（连接后仅保存在本机进程内存）';
}

function openDeployDialog() {
  const project = currentProject();
  el.deployForm.reset();
  el.deployError.hidden = true;
  el.deployProgress.hidden = true;
  el.deployTargetCopy.textContent = isRemoteProject(project)
    ? `Windows → SSH → ${serverForProject(project)?.name || '服务器缺失'} → ${isLegacyLayout(project) ? project.releaseRootPath : project.rootPath}`
    : `Windows 本机 → ${project.rootPath}`;
  configureCredentialField(el.deployCredentialField, el.deployCredentialLabel, project);
  el.deployDialog.showModal();
}

function renderDeployProgress({ stage, progress, detail }) {
  const value = Math.max(0, Math.min(Number(progress) || 0, 100));
  el.deployProgress.hidden = false;
  el.deployStage.textContent = stage || '准备中';
  el.deployPercent.textContent = `${value}%`;
  el.deployProgressBar.style.width = `${value}%`;
  el.deployDetail.textContent = detail || '';
}

function uploadDeployment(url, formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.addEventListener('progress', event => {
      if (!event.lengthComputable) return;
      renderDeployProgress({
        stage: '上传到管理器',
        progress: Math.max(2, Math.floor((event.loaded / event.total) * 12)),
        detail: `已上传 ${fmtSize(event.loaded)} / ${fmtSize(event.total)}`
      });
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      const error = new Error(data?.error || `请求失败 (${xhr.status})`);
      error.code = data?.code;
      error.details = data?.details;
      reject(error);
    });
    xhr.addEventListener('error', () => reject(new Error('上传连接中断')));
    xhr.send(formData);
  });
}

async function waitForOperation(operationId) {
  while (true) {
    const operation = await api(`/api/operations/${operationId}`);
    renderDeployProgress(operation);
    if (operation.status !== 'running') return operation;
    await new Promise(resolve => setTimeout(resolve, 650));
  }
}

document.getElementById('deployBtn').addEventListener('click', openDeployDialog);
document.getElementById('deployCancelBtn').addEventListener('click', () => el.deployDialog.close());

el.deployForm.addEventListener('submit', async event => {
  event.preventDefault();
  const project = currentProject();
  el.deployError.hidden = true;
  el.deploySubmitBtn.disabled = true;
  document.getElementById('deployCancelBtn').disabled = true;
  el.deploySubmitBtn.textContent = '正在部署…';

  try {
    const formData = new FormData(el.deployForm);
    const activate = el.deployForm.elements.namedItem('activate').checked;
    formData.set('activate', activate ? 'true' : 'false');
    if (isRemoteProject(project) && !el.deployCredentialField.hidden) {
      const server = serverForProject(project);
      const credential = el.deployForm.elements.namedItem('credential').value;
      formData.set(server?.authType === 'password' ? 'password' : 'passphrase', credential);
    }
    renderDeployProgress({ stage: '上传到管理器', progress: 1, detail: '正在发送构建产物' });
    const operation = await uploadDeployment(`/api/projects/${state.currentProjectId}/deploy`, formData);
    const finished = await waitForOperation(operation.id);
    if (finished.status === 'failed') throw new Error(finished.error || '部署失败');
    el.deployDialog.close();
    await Promise.all([loadServers(), loadProjects()]);
    await selectProject(state.currentProjectId);
    const health = finished.result?.health;
    const message = activate ? '新版本已部署并上线' : '新版本已部署，尚未上线';
    showToast(message + (health?.configured ? '；' + healthResultText(health) : ''), health?.configured && !health.ok ? 'error' : 'success');
  } catch (error) {
    el.deployError.textContent = remoteActionHint(error);
    el.deployError.hidden = false;
  } finally {
    el.deploySubmitBtn.disabled = false;
    document.getElementById('deployCancelBtn').disabled = false;
    el.deploySubmitBtn.textContent = '开始部署';
  }
});

// ---------- 项目设置 ----------

function renderServerOptions(selectedId = el.projectServerSelect.value) {
  el.projectServerSelect.innerHTML = state.servers.length
    ? state.servers.map(server => `<option value="${escapeHtml(server.id)}">${escapeHtml(server.name)} · ${escapeHtml(server.host)}</option>`).join('')
    : '<option value="">请先添加SSH服务器</option>';
  if (selectedId && state.servers.some(server => server.id === selectedId)) el.projectServerSelect.value = selectedId;
}

function syncProjectTargetFields() {
  const remote = el.projectTargetType.value === 'ssh-linux';
  const legacy = remote && el.linuxLayoutSelect.value === 'legacy-live-link';
  el.projectServerField.hidden = !remote;
  el.linuxLayoutField.hidden = !remote;
  el.releaseRootField.hidden = !legacy;
  el.linuxOpsFields.hidden = !remote;
  el.nginxServiceField.hidden = !remote || el.nginxControlMode.value !== 'systemd';
  el.projectRootLabel.textContent = legacy
    ? 'Nginx当前站点路径（软链接）'
    : remote ? 'Linux部署目录（绝对路径）' : '服务器目录（绝对路径）';
  const rootInput = el.projectForm.elements.namedItem('rootPath');
  rootInput.placeholder = legacy ? '/home/nginx/html/company-website' : remote ? '/var/www/company-website' : 'D:\\sites\\company-website';
  const releaseInput = el.projectForm.elements.namedItem('releaseRootPath');
  if (legacy && !releaseInput.value && rootInput.value) releaseInput.value = `${rootInput.value.replace(/\/$/, '')}-releases`;
  el.projectRootHint.innerHTML = legacy
    ? 'Nginx继续访问这个既有路径，管理器只切换它指向的版本目录，无需修改配置。'
    : remote ? 'Nginx 的 root 需要指向 <code>&lt;这个目录&gt;/current</code>'
      : 'Nginx 的 root 需要指向 <code>&lt;这个目录&gt;\\current</code>';
  el.pathMigrationHint.textContent = remote
    ? '远程项目已有版本后不能直接修改目录，避免本地记录与服务器文件失配。'
    : '修改路径时会迁移历史版本并重建 current，根目录中的其他文件不会移动。';
}

function openProjectDialog(project = null) {
  state.projectDialogMode = project ? 'edit' : 'create';
  el.projectForm.reset();
  el.projectError.hidden = true;
  el.projectDialogTitle.textContent = project ? '项目设置' : '新建项目';
  el.projectSubmitBtn.textContent = project ? '保存更改' : '创建项目';
  el.deleteProjectBtn.hidden = !project;
  el.pathMigrationHint.hidden = !project;
  const releaseRootInput = el.projectForm.elements.namedItem('releaseRootPath');
  releaseRootInput.dataset.edited = project?.releaseRootPath ? 'true' : '';
  renderServerOptions(project?.serverId);

  if (project) {
    el.projectForm.elements.namedItem('name').value = project.name;
    el.projectForm.elements.namedItem('rootPath').value = project.rootPath;
    el.projectTargetType.value = project.targetType || 'local-windows';
    if (project.serverId) el.projectServerSelect.value = project.serverId;
    el.linuxLayoutSelect.value = project.linuxLayout || 'managed-current';
    releaseRootInput.value = project.releaseRootPath || '';
    for (const name of ['nginxControlMode', 'nginxExecutablePath', 'nginxConfigPath', 'nginxServiceName', 'nginxAccessLogPath', 'nginxErrorLogPath', 'healthCheckUrl', 'healthCheckHost', 'healthCheckTimeoutSeconds']) {
      const field = el.projectForm.elements.namedItem(name);
      if (field) field.value = project[name] ?? (name === 'healthCheckTimeoutSeconds' ? 8 : '');
    }
  }
  syncProjectTargetFields();
  el.projectDialog.showModal();
}

el.projectTargetType.addEventListener('change', syncProjectTargetFields);
el.linuxLayoutSelect.addEventListener('change', syncProjectTargetFields);
el.nginxControlMode.addEventListener('change', syncProjectTargetFields);
el.projectForm.elements.namedItem('rootPath').addEventListener('input', () => {
  const releaseInput = el.projectForm.elements.namedItem('releaseRootPath');
  if (el.linuxLayoutSelect.value === 'legacy-live-link' && !releaseInput.dataset.edited) {
    releaseInput.value = `${el.projectForm.elements.namedItem('rootPath').value.replace(/\/$/, '')}-releases`;
  }
});
el.projectForm.elements.namedItem('releaseRootPath').addEventListener('input', event => {
  event.target.dataset.edited = event.target.value ? 'true' : '';
});
document.getElementById('newProjectBtn').addEventListener('click', () => openProjectDialog());
document.getElementById('emptyNewProjectBtn').addEventListener('click', () => openProjectDialog());
document.getElementById('projectSettingsBtn').addEventListener('click', () => openProjectDialog(currentProject()));
document.getElementById('projectCancelBtn').addEventListener('click', () => el.projectDialog.close());

el.projectForm.addEventListener('submit', async event => {
  event.preventDefault();
  el.projectError.hidden = true;
  el.projectSubmitBtn.disabled = true;
  const isEdit = state.projectDialogMode === 'edit';
  el.projectSubmitBtn.textContent = isEdit ? '正在保存…' : '正在创建…';

  try {
    const targetType = el.projectTargetType.value;
    const body = {
      name: el.projectForm.elements.namedItem('name').value,
      rootPath: el.projectForm.elements.namedItem('rootPath').value,
      targetType,
      serverId: targetType === 'ssh-linux' ? el.projectServerSelect.value : null,
      linuxLayout: targetType === 'ssh-linux' ? el.linuxLayoutSelect.value : 'managed-current',
      releaseRootPath: targetType === 'ssh-linux' && el.linuxLayoutSelect.value === 'legacy-live-link'
        ? el.projectForm.elements.namedItem('releaseRootPath').value
        : null,
      nginxControlMode: targetType === 'ssh-linux' ? el.nginxControlMode.value : 'binary',
      nginxExecutablePath: targetType === 'ssh-linux' ? el.projectForm.elements.namedItem('nginxExecutablePath').value : null,
      nginxConfigPath: targetType === 'ssh-linux' ? el.projectForm.elements.namedItem('nginxConfigPath').value : null,
      nginxServiceName: targetType === 'ssh-linux' ? el.projectForm.elements.namedItem('nginxServiceName').value : null,
      nginxAccessLogPath: targetType === 'ssh-linux' ? el.projectForm.elements.namedItem('nginxAccessLogPath').value : null,
      nginxErrorLogPath: targetType === 'ssh-linux' ? el.projectForm.elements.namedItem('nginxErrorLogPath').value : null,
      healthCheckUrl: targetType === 'ssh-linux' ? el.projectForm.elements.namedItem('healthCheckUrl').value : null,
      healthCheckHost: targetType === 'ssh-linux' ? el.projectForm.elements.namedItem('healthCheckHost').value : null,
      healthCheckTimeoutSeconds: targetType === 'ssh-linux'
        ? Number(el.projectForm.elements.namedItem('healthCheckTimeoutSeconds').value || 8)
        : 8
    };
    const project = await api(isEdit ? `/api/projects/${state.currentProjectId}` : '/api/projects', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    el.projectDialog.close();
    await loadProjects();
    await selectProject(project.id);
    showToast(isEdit ? '项目设置已保存' : '项目已创建');
  } catch (error) {
    el.projectError.textContent = error.message;
    el.projectError.hidden = false;
  } finally {
    el.projectSubmitBtn.disabled = false;
    el.projectSubmitBtn.textContent = isEdit ? '保存更改' : '创建项目';
  }
});

// ---------- SSH服务器 ----------

function renderServerList() {
  if (!el.serverList) return;
  el.serverList.innerHTML = state.servers.length
    ? state.servers.map(server => `
      <button type="button" class="server-item ${server.id === state.currentServerId ? 'active' : ''}" data-id="${escapeHtml(server.id)}">
        <strong>${escapeHtml(server.name)}</strong>
        <span class="${server.sessionReady ? 'server-ok' : server.lastTestStatus === 'failed' ? 'server-failed' : ''}">${escapeHtml(server.host)}:${server.port} · ${server.sessionReady ? '本次会话已连接' : server.lastTestStatus === 'failed' ? '连接失败' : server.lastTestStatus === 'success' ? '已验证，当前未连接' : '未连接'}</span>
      </button>`).join('')
    : '<div class="project-list-empty"><strong>还没有服务器</strong><span>新增后即可创建Linux项目。</span></div>';
  el.serverList.querySelectorAll('.server-item').forEach(button => {
    button.addEventListener('click', () => editServer(button.dataset.id));
  });
}

function syncServerAuthField() {
  const passwordAuth = el.serverAuthType.value === 'password';
  const server = state.servers.find(item => item.id === state.currentServerId);
  el.privateKeyField.hidden = passwordAuth;
  el.serverCredentialLabel.textContent = server?.sessionReady
    ? `${passwordAuth ? 'SSH密码' : '私钥口令'}（留空复用当前会话）`
    : `${passwordAuth ? 'SSH密码' : '私钥口令'}（仅保存在本机进程内存）`;
}

function serverSubmitText(server) {
  if (!server) return '保存并连接';
  return server.sessionReady ? '保存并重新测试' : '连接服务器';
}

function editServer(serverId = null) {
  const server = state.servers.find(item => item.id === serverId);
  state.currentServerId = server?.id || null;
  el.serverForm.reset();
  el.serverForm.elements.namedItem('port').value = 22;
  el.serverError.hidden = true;
  el.serverTestResult.hidden = true;
  el.deleteServerBtn.hidden = !server;
  el.disconnectServerBtn.hidden = !server?.sessionReady;
  el.serverSessionStatus.textContent = server?.sessionReady
    ? '本次会话已连接 · 后续部署操作不再提交密码'
    : '当前未连接 · 连接后凭据只保存在部署管理器进程内存中';
  el.serverSessionStatus.classList.toggle('is-connected', Boolean(server?.sessionReady));
  el.serverSubmitBtn.textContent = serverSubmitText(server);
  el.serverFingerprint.textContent = server?.hostFingerprint
    ? `已确认主机指纹：${server.hostFingerprint}`
    : '尚未确认主机指纹';
  if (server) {
    //* API返回字段是id，隐藏字段必须显式写入它，否则编辑会被误提交为新增服务器。
    el.serverForm.elements.namedItem('serverId').value = server.id;
    for (const name of ['name', 'host', 'port', 'username', 'authType', 'privateKeyPath']) {
      el.serverForm.elements.namedItem(name).value = server[name] || '';
    }
  }
  syncServerAuthField();
  renderServerList();
}

async function testSavedServer(server, credential, acceptNewHost = false) {
  return api(`/api/servers/${server.id}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      password: server.authType === 'password' ? credential : '',
      passphrase: server.authType === 'private-key' ? credential : '',
      acceptNewHost
    })
  });
}

document.getElementById('serverManagerBtn').addEventListener('click', async () => {
  await loadServers();
  editServer(state.currentServerId && state.servers.some(server => server.id === state.currentServerId) ? state.currentServerId : state.servers[0]?.id);
  el.serverDialog.showModal();
});
document.getElementById('serverCloseBtn').addEventListener('click', () => el.serverDialog.close());
document.getElementById('newServerBtn').addEventListener('click', () => editServer());
el.serverAuthType.addEventListener('change', syncServerAuthField);

el.serverForm.addEventListener('submit', async event => {
  event.preventDefault();
  el.serverError.hidden = true;
  el.serverTestResult.hidden = true;
  el.serverSubmitBtn.disabled = true;
  el.serverSubmitBtn.textContent = '正在连接…';
  const existingId = el.serverForm.elements.namedItem('serverId').value;

  try {
    const body = Object.fromEntries(new FormData(el.serverForm));
    const credential = body.credential;
    delete body.credential;
    delete body.serverId;
    const server = await api(existingId ? `/api/servers/${existingId}` : '/api/servers', {
      method: existingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    state.currentServerId = server.id;

    let result;
    try {
      result = await testSavedServer(server, credential);
    } catch (error) {
      if (error.code !== 'HOST_FINGERPRINT_REQUIRED') throw error;
      const accepted = await confirmAction({
        title: '确认服务器主机指纹',
        message: `${server.name}\n${server.host}:${server.port}\n\n${error.details?.fingerprint || '未获得指纹'}\n\n请与服务器管理员提供的指纹核对。`,
        confirmText: '信任并连接'
      });
      if (!accepted) throw new Error('未确认服务器主机指纹');
      result = await testSavedServer(server, credential, true);
    }

    await loadServers();
    editServer(server.id);
    el.serverTestResult.textContent = result.details;
    el.serverTestResult.hidden = false;
    showToast('SSH服务器连接正常');
  } catch (error) {
    el.serverError.textContent = error.message;
    el.serverError.hidden = false;
    await loadServers();
  } finally {
    el.serverSubmitBtn.disabled = false;
    el.serverSubmitBtn.textContent = serverSubmitText(state.servers.find(item => item.id === state.currentServerId));
  }
});

el.deleteServerBtn.addEventListener('click', async () => {
  const server = state.servers.find(item => item.id === state.currentServerId);
  if (!server) return;
  const confirmed = await confirmAction({
    title: '删除SSH连接？',
    message: `${server.name}\n${server.host}:${server.port}\n\n仍被项目使用的连接不能删除。`,
    confirmText: '删除连接',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api(`/api/servers/${server.id}`, { method: 'DELETE' });
    state.currentServerId = null;
    await loadServers();
    editServer();
    showToast('SSH连接已删除');
  } catch (error) {
    el.serverError.textContent = error.message;
    el.serverError.hidden = false;
  }
});

el.disconnectServerBtn.addEventListener('click', async () => {
  const server = state.servers.find(item => item.id === state.currentServerId);
  if (!server) return;
  try {
    await api(`/api/servers/${server.id}/session`, { method: 'DELETE' });
    await loadServers();
    editServer(server.id);
    showToast('SSH会话已断开，内存凭据已清除');
  } catch (error) {
    el.serverError.textContent = error.message;
    el.serverError.hidden = false;
  }
});

// ---------- 删除、清理与操作记录 ----------

el.deleteProjectBtn.addEventListener('click', () => {
  const project = currentProject();
  if (!project) return;
  el.projectDialog.close();
  el.deleteProjectForm.reset();
  el.deleteProjectError.hidden = true;
  el.deleteProjectName.textContent = project.name;
  el.deleteProjectSubmitBtn.disabled = true;
  configureCredentialField(el.deleteProjectCredentialField, el.deleteProjectCredentialLabel, project);
  el.deleteProjectDialog.showModal();
});

el.deleteProjectForm.elements.namedItem('confirmName').addEventListener('input', event => {
  el.deleteProjectSubmitBtn.disabled = event.target.value !== currentProject()?.name;
});

document.getElementById('deleteProjectCancelBtn').addEventListener('click', () => el.deleteProjectDialog.close());

el.deleteProjectForm.addEventListener('submit', async event => {
  event.preventDefault();
  const project = currentProject();
  if (!project || el.deleteProjectForm.elements.namedItem('confirmName').value !== project.name) return;

  el.deleteProjectError.hidden = true;
  el.deleteProjectSubmitBtn.disabled = true;
  el.deleteProjectSubmitBtn.textContent = '正在删除…';
  const deleteFiles = el.deleteProjectForm.elements.namedItem('deleteFiles').checked;
  const body = { deleteFiles };
  if (isRemoteProject(project) && !el.deleteProjectCredentialField.hidden) {
    const credential = el.deleteProjectForm.elements.namedItem('credential').value;
    body[serverForProject(project)?.authType === 'password' ? 'password' : 'passphrase'] = credential;
  }

  try {
    await api(`/api/projects/${project.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    el.deleteProjectDialog.close();
    localStorage.removeItem('deploy-manager:last-project');
    state.currentProjectId = null;
    state.releases = [];
    state.activeReleaseId = null;
    await loadProjects();
    if (state.projects.length) await selectProject(state.projects[0].id);
    else showEmptyState();
    showToast(deleteFiles ? '项目和版本文件已删除' : '项目已移除，线上文件仍然保留');
  } catch (error) {
    el.deleteProjectError.textContent = remoteActionHint(error);
    el.deleteProjectError.hidden = false;
  } finally {
    el.deleteProjectSubmitBtn.disabled = false;
    el.deleteProjectSubmitBtn.textContent = '删除项目';
  }
});

el.cleanupBtn.addEventListener('click', () => {
  el.cleanupForm.reset();
  el.cleanupForm.elements.namedItem('keep').value = Math.min(5, state.releases.length);
  el.cleanupError.hidden = true;
  configureCredentialField(el.cleanupCredentialField, el.cleanupCredentialLabel, currentProject());
  el.cleanupDialog.showModal();
});
document.getElementById('cleanupCancelBtn').addEventListener('click', () => el.cleanupDialog.close());

el.cleanupForm.addEventListener('submit', async event => {
  event.preventDefault();
  const keep = Number(el.cleanupForm.elements.namedItem('keep').value);
  if (!Number.isInteger(keep) || keep < 0) {
    el.cleanupError.textContent = '请输入一个非负整数';
    el.cleanupError.hidden = false;
    return;
  }

  el.cleanupError.hidden = true;
  el.cleanupSubmitBtn.disabled = true;
  el.cleanupSubmitBtn.textContent = '正在清理…';
  try {
    const body = { keep };
    if (isRemoteProject() && !el.cleanupCredentialField.hidden) {
      const server = serverForProject();
      const credential = el.cleanupForm.elements.namedItem('credential').value;
      body[server?.authType === 'password' ? 'password' : 'passphrase'] = credential;
    }
    const result = await api(`/api/projects/${state.currentProjectId}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    el.cleanupDialog.close();
    await selectProject(state.currentProjectId);
    await loadProjects();
    showToast(result.deletedCount ? `已清理 ${result.deletedCount} 个旧版本` : '没有需要清理的版本');
  } catch (error) {
    el.cleanupError.textContent = remoteActionHint(error);
    el.cleanupError.hidden = false;
  } finally {
    el.cleanupSubmitBtn.disabled = false;
    el.cleanupSubmitBtn.textContent = '开始清理';
  }
});

function operationStatusText(status) {
  return status === 'success' ? '成功' : status === 'failed' ? '失败' : '执行中';
}

async function openOperations() {
  el.operationsDialog.showModal();
  el.operationList.innerHTML = '<div class="project-list-empty"><strong>正在加载</strong></div>';
  try {
    const items = await api(`/api/projects/${state.currentProjectId}/operations?limit=50`);
    el.operationList.innerHTML = items.length ? items.map(item => `
      <article class="operation-item">
        <time>${fmtTime(item.createdAt)}</time>
        <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.error || item.detail || item.stage)}</span></div>
        <small class="operation-status ${escapeHtml(item.status)}">${operationStatusText(item.status)}</small>
      </article>`).join('') : '<div class="project-list-empty"><strong>还没有操作记录</strong><span>部署、切换和清理结果会显示在这里。</span></div>';
  } catch (error) {
    el.operationList.innerHTML = `<p class="dialog-error">${escapeHtml(error.message)}</p>`;
  }
}

document.getElementById('operationsBtn').addEventListener('click', openOperations);
document.getElementById('operationsCloseBtn').addEventListener('click', () => el.operationsDialog.close());

function confirmedRemoteBody(server) {
  const body = {};
  if (server && !server.sessionReady) body[server.authType === 'password' ? 'password' : 'passphrase'] = confirmedCredential;
  return body;
}

function healthResultText(health) {
  if (!health?.configured) return '未配置健康检查';
  if (health.ok) return '健康检查通过 · HTTP ' + health.statusCode + ' · ' + health.durationMs + 'ms';
  return '健康检查失败 · ' + (health.error || ('HTTP ' + health.statusCode));
}

function setNginxButtonsDisabled(disabled) {
  for (const button of [el.nginxValidateBtn, el.nginxReloadBtn, el.nginxRestartBtn]) button.disabled = disabled;
}

el.nginxPanelBtn.addEventListener('click', () => {
  const project = currentProject();
  if (!project?.nginxExecutablePath) {
    showToast('请先在项目设置中填写Nginx可执行文件路径', 'error');
    return;
  }
  el.nginxTargetCopy.textContent = (project.nginxControlMode === 'systemd'
    ? 'systemd · ' + project.nginxServiceName
    : 'binary · ' + project.nginxExecutablePath)
    + (project.nginxConfigPath ? ' · ' + project.nginxConfigPath : ' · 编译默认配置');
  el.nginxOutput.textContent = '选择一个操作。reload和restart执行前都会先运行配置校验。';
  el.nginxDialog.showModal();
});

document.getElementById('nginxCloseBtn').addEventListener('click', () => el.nginxDialog.close());

async function runNginxAction(action) {
  const project = currentProject();
  const server = serverForProject(project);
  if (!project || !server) return;
  const labels = {
    validate: ['校验Nginx配置', '开始校验', false],
    reload: ['Reload Nginx', '确认Reload', false],
    restart: ['Restart Nginx', '确认Restart', true]
  };
  const label = labels[action];
  const confirmed = await confirmAction({
    title: label[0],
    message: project.nginxExecutablePath + '\n\n' + (action === 'restart'
      ? 'Restart会等待旧master退出后启动新master，期间可能出现短暂中断。'
      : action === 'reload' ? '配置校验通过后才会平滑加载新配置。' : '只检查配置，不改变Nginx运行状态。'),
    confirmText: label[1],
    danger: label[2],
    credentialServer: server
  });
  if (!confirmed) return;
  setNginxButtonsDisabled(true);
  el.nginxOutput.textContent = '正在执行 ' + action + '…';
  try {
    const result = await api('/api/projects/' + project.id + '/nginx/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmedRemoteBody(server))
    });
    const output = result.output || result.validation?.output || '操作完成';
    el.nginxOutput.textContent = output + (result.health ? '\n\n' + healthResultText(result.health) : '');
    await loadServers();
    showToast(action === 'validate' ? 'Nginx配置校验通过' : 'Nginx ' + action + ' 已完成');
  } catch (error) {
    el.nginxOutput.textContent = remoteActionHint(error);
    showToast(label[0] + '失败', 'error');
  } finally {
    setNginxButtonsDisabled(false);
  }
}

el.nginxValidateBtn.addEventListener('click', () => runNginxAction('validate'));
el.nginxReloadBtn.addEventListener('click', () => runNginxAction('reload'));
el.nginxRestartBtn.addEventListener('click', () => runNginxAction('restart'));

el.healthCheckBtn.addEventListener('click', async () => {
  const project = currentProject();
  const server = serverForProject(project);
  if (!project?.healthCheckUrl || !server) return;
  const confirmed = await confirmAction({
    title: '检查站点健康状态',
    message: project.healthCheckUrl + (project.healthCheckHost ? '\nHost: ' + project.healthCheckHost : ''),
    confirmText: '开始检查',
    credentialServer: server
  });
  if (!confirmed) return;
  try {
    const result = await api('/api/projects/' + project.id + '/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmedRemoteBody(server))
    });
    showToast(healthResultText(result), result.ok ? 'success' : 'error');
    await loadServers();
  } catch (error) {
    showToast('健康检查失败：' + remoteActionHint(error), 'error');
  }
});

el.rollbackBtn.addEventListener('click', async () => {
  const project = currentProject();
  const release = project?.rollbackRelease;
  const server = serverForProject(project);
  if (!project || !release) return;
  const confirmed = await confirmAction({
    title: '回滚到上一个线上版本？',
    message: release.folderName + '\n' + (release.description || '未填写更新说明') + '\n\n软链接会立即切换到这个版本。',
    confirmText: '确认回滚',
    danger: true,
    credentialServer: isRemoteProject(project) ? server : null
  });
  if (!confirmed) return;
  try {
    const result = await api('/api/projects/' + project.id + '/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmedRemoteBody(server))
    });
    await loadProjects();
    await selectProject(project.id);
    const suffix = result.health?.configured ? '；' + healthResultText(result.health) : '';
    showToast('已回滚到 ' + result.release.folderName + suffix, result.health?.configured && !result.health.ok ? 'error' : 'success');
  } catch (error) {
    await loadProjects();
    await selectProject(project.id);
    showToast('回滚失败：' + remoteActionHint(error), 'error');
  }
});

el.diagnosticsBtn.addEventListener('click', async () => {
  const project = currentProject();
  const server = serverForProject(project);
  if (!project || !server) return;
  const confirmed = await confirmAction({
    title: '运行远程环境诊断',
    message: '只读取系统、磁盘、项目目录、Nginx进程和监听端口。',
    confirmText: '开始诊断',
    credentialServer: server
  });
  if (!confirmed) return;
  el.diagnosticsOutput.textContent = '正在读取远程环境…';
  el.diagnosticsDialog.showModal();
  try {
    const result = await api('/api/projects/' + project.id + '/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmedRemoteBody(server))
    });
    el.diagnosticsOutput.textContent = result.details || '诊断完成，没有输出。';
    await loadServers();
  } catch (error) {
    el.diagnosticsOutput.textContent = remoteActionHint(error);
  }
});

document.getElementById('diagnosticsCloseBtn').addEventListener('click', () => el.diagnosticsDialog.close());

function logTime(entry) {
  if (entry.time) return entry.time;
  return entry.timestamp ? fmtTime(entry.timestamp) : '—';
}

function renderLogs(entries) {
  const stickToBottom = el.logStream.scrollHeight - el.logStream.scrollTop - el.logStream.clientHeight < 56;
  el.logStream.innerHTML = entries.length ? entries.map(entry => `
    <article class="log-row log-level-${escapeHtml(entry.level)}">
      <time>${escapeHtml(logTime(entry))}</time>
      <span class="log-source">${escapeHtml(entry.source)}</span>
      <span class="log-level">${escapeHtml(entry.level)}</span>
      <code>${escapeHtml(entry.message)}</code>
    </article>`).join('') : '<div class="log-empty">当前筛选条件下没有日志。</div>';
  if (stickToBottom) el.logStream.scrollTop = el.logStream.scrollHeight;
}

/**
 * 拉取当前日志快照，新的筛选请求会取消旧请求。
 * * 这样快速切换来源时，较慢的SSH结果不会覆盖最新选择。
 */
async function loadLogs(replacePending = false) {
  const project = currentProject();
  if (!project || !el.logsDialog.open) return;
  if (state.logController && !replacePending) return;
  if (state.logController) state.logController.abort();
  const controller = new AbortController();
  state.logController = controller;
  el.logsError.hidden = true;
  el.logsStatus.textContent = '正在更新…';
  const query = new URLSearchParams({
    source: el.logSourceSelect.value,
    lines: el.logLinesSelect.value,
    query: el.logQueryInput.value.trim()
  });
  try {
    const result = await api(`/api/projects/${project.id}/logs?${query}`, { signal: controller.signal });
    if (state.logController !== controller) return;
    renderLogs(result.entries);
    el.logsPath.textContent = result.path || result.label;
    el.logsStatus.textContent = `${result.entries.length} 行 · ${new Date(result.checkedAt).toLocaleTimeString()}`;
  } catch (error) {
    if (error.name === 'AbortError' || state.logController !== controller) return;
    el.logsStatus.textContent = '更新失败';
    el.logsError.textContent = remoteActionHint(error);
    el.logsError.hidden = false;
  } finally {
    if (state.logController === controller) state.logController = null;
  }
}

function stopLogPolling() {
  clearInterval(state.logTimer);
  state.logTimer = null;
  if (state.logController) state.logController.abort();
  state.logController = null;
}

function startLogPolling() {
  clearInterval(state.logTimer);
  //* 远程来源每次会建立短SSH连接，5秒间隔避免持续握手占用服务器资源。
  state.logTimer = state.logLive ? setInterval(loadLogs, 5000) : null;
}

el.logsBtn.addEventListener('click', () => {
  const project = currentProject();
  if (!project) return;
  for (const option of el.logSourceSelect.options) option.disabled = option.value !== 'manager' && !isRemoteProject(project);
  el.logSourceSelect.value = 'manager';
  el.logQueryInput.value = '';
  state.logLive = true;
  el.logsLiveBtn.textContent = '实时';
  el.logsLiveBtn.classList.add('is-live');
  el.logsLiveBtn.setAttribute('aria-pressed', 'true');
  el.logsStatus.textContent = '正在读取…';
  el.logsPath.textContent = '';
  el.logStream.innerHTML = '<div class="log-empty">正在读取运行日志…</div>';
  el.logsDialog.showModal();
  loadLogs();
  startLogPolling();
});

el.logSourceSelect.addEventListener('change', () => loadLogs(true));
el.logLinesSelect.addEventListener('change', () => loadLogs(true));
el.logsRefreshBtn.addEventListener('click', () => loadLogs(true));
el.logsLiveBtn.addEventListener('click', () => {
  state.logLive = !state.logLive;
  el.logsLiveBtn.textContent = state.logLive ? '实时' : '已暂停';
  el.logsLiveBtn.classList.toggle('is-live', state.logLive);
  el.logsLiveBtn.setAttribute('aria-pressed', String(state.logLive));
  if (state.logLive) loadLogs(true);
  startLogPolling();
});

let logSearchTimer;
el.logQueryInput.addEventListener('input', () => {
  clearTimeout(logSearchTimer);
  logSearchTimer = setTimeout(() => loadLogs(true), 260);
});
document.getElementById('logsCloseBtn').addEventListener('click', () => el.logsDialog.close());
el.logsDialog.addEventListener('close', stopLogPolling);

function browserChildPath(name) {
  return state.filePath ? state.filePath + '/' + name : name;
}

async function loadFileBrowser() {
  const project = currentProject();
  if (!project) return;
  el.fileBrowserError.hidden = true;
  el.fileList.innerHTML = '<div class="project-list-empty"><strong>正在读取目录</strong></div>';
  const query = new URLSearchParams({ scope: state.fileScope, path: state.filePath });
  try {
    const result = await api('/api/projects/' + project.id + '/files?' + query.toString());
    state.filePath = result.path;
    el.fileBrowserPath.textContent = '/' + state.filePath;
    el.fileUpBtn.disabled = !state.filePath;
    el.fileList.innerHTML = result.entries.length
      ? result.entries.map(item => '<button type="button" class="file-item" data-name="' + escapeHtml(item.name) + '" data-type="' + item.type + '"><span class="file-kind">' + (item.type === 'directory' ? 'DIR' : item.type === 'link' ? 'LNK' : 'FILE') + '</span><strong>' + escapeHtml(item.name) + '</strong><span>' + (item.type === 'directory' ? '—' : fmtSize(item.sizeBytes)) + '</span><time>' + (item.modifiedAt ? fmtTime(item.modifiedAt) : '—') + '</time></button>').join('')
      : '<div class="project-list-empty"><strong>目录为空</strong></div>';
    el.fileList.querySelectorAll('.file-item').forEach(button => {
      button.addEventListener('click', () => {
        const nextPath = browserChildPath(button.dataset.name);
        if (button.dataset.type === 'directory') {
          state.filePath = nextPath;
          loadFileBrowser();
          return;
        }
        previewProjectFile(nextPath);
      });
    });
  } catch (error) {
    el.fileList.innerHTML = '';
    el.fileBrowserError.textContent = remoteActionHint(error);
    el.fileBrowserError.hidden = false;
  }
}

async function previewProjectFile(relativePath) {
  const project = currentProject();
  const query = new URLSearchParams({ scope: state.fileScope, path: relativePath });
  el.filePreviewName.textContent = relativePath.split('/').pop();
  el.filePreviewMeta.textContent = '正在读取…';
  el.filePreviewContent.textContent = '';
  try {
    const result = await api('/api/projects/' + project.id + '/files/content?' + query.toString());
    el.filePreviewMeta.textContent = fmtSize(result.sizeBytes) + ' · 只读';
    el.filePreviewContent.textContent = result.content;
  } catch (error) {
    el.filePreviewMeta.textContent = '无法预览';
    el.filePreviewContent.textContent = remoteActionHint(error);
  }
}

el.fileBrowserBtn.addEventListener('click', () => {
  const server = serverForProject();
  if (!server?.sessionReady) {
    showToast('请先在SSH服务器中连接一次，再打开文件浏览器', 'error');
    return;
  }
  state.fileScope = 'site';
  state.filePath = '';
  el.fileScopeSelect.value = state.fileScope;
  el.filePreviewName.textContent = '选择文本文件';
  el.filePreviewMeta.textContent = '';
  el.filePreviewContent.textContent = '目录和版本文件保持只读，避免破坏不可变发布记录。';
  el.fileBrowserDialog.showModal();
  loadFileBrowser();
});

el.fileScopeSelect.addEventListener('change', () => {
  state.fileScope = el.fileScopeSelect.value;
  state.filePath = '';
  loadFileBrowser();
});
el.fileUpBtn.addEventListener('click', () => {
  state.filePath = state.filePath.includes('/') ? state.filePath.slice(0, state.filePath.lastIndexOf('/')) : '';
  loadFileBrowser();
});
el.fileRefreshBtn.addEventListener('click', loadFileBrowser);
document.getElementById('fileBrowserCloseBtn').addEventListener('click', () => el.fileBrowserDialog.close());

el.syncRemoteBtn.addEventListener('click', async () => {
  const project = currentProject();
  const server = serverForProject(project);
  if (!project || !server) return;
  const confirmed = await confirmAction({
    title: '同步Linux历史版本',
    message: `${server.name}\n${isLegacyLayout(project) ? project.releaseRootPath : `${project.rootPath}/releases`}\n\n将导入服务器上已有的版本，并以当前软链接作为线上版本。`,
    confirmText: '开始同步',
    credentialServer: server
  });
  if (!confirmed) return;
  try {
    const body = {};
    if (!server.sessionReady) body[server.authType === 'password' ? 'password' : 'passphrase'] = confirmedCredential;
    const result = await api(`/api/projects/${project.id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    await Promise.all([loadServers(), loadProjects()]);
    await selectProject(project.id);
    showToast(`已读取 ${result.remoteCount} 个远程版本，新增 ${result.addedCount} 个记录`);
  } catch (error) {
    showToast(`同步失败：${remoteActionHint(error)}`, 'error');
  }
});

document.getElementById('copyPathBtn').addEventListener('click', async () => {
  try {
    await copyText(el.projectPath.textContent);
    showToast('线上目录已复制');
  } catch (_) {
    showToast('复制失败，请手动选择路径', 'error');
  }
});

async function init() {
  try {
    await Promise.all([loadServers(), loadProjects()]);
    if (!state.projects.length) {
      showEmptyState();
      return;
    }
    const lastProjectId = localStorage.getItem('deploy-manager:last-project');
    const initialProject = state.projects.find(project => project.id === lastProjectId) || state.projects[0];
    await selectProject(initialProject.id);
  } catch (error) {
    showEmptyState();
    showToast(`项目加载失败：${error.message}`, 'error');
  }
}

init();
