const state = {
  projects: [],
  currentProjectId: null,
  releases: [],
  activeReleaseId: null,
  projectDialogMode: 'create'
};

const el = Object.fromEntries([
  'projectList', 'emptyState', 'projectView', 'projectName', 'projectPath', 'projectStatus',
  'activeVersion', 'releaseCount', 'releaseSize', 'timeline', 'cleanupBtn',
  'deployDialog', 'deployForm', 'deployError', 'deploySubmitBtn',
  'projectDialog', 'projectForm', 'projectDialogTitle', 'projectSubmitBtn', 'projectError',
  'pathMigrationHint', 'deleteProjectBtn', 'deleteProjectDialog', 'deleteProjectForm',
  'deleteProjectName', 'deleteProjectSubmitBtn', 'deleteProjectError',
  'cleanupDialog', 'cleanupForm', 'cleanupSubmitBtn', 'cleanupError',
  'confirmDialog', 'confirmKicker', 'confirmTitle', 'confirmMessage', 'confirmSubmitBtn',
  'toastRegion'
].map(id => [id, document.getElementById(id)]));

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
  return data;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function currentProject() {
  return state.projects.find(project => project.id === state.currentProjectId);
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

//* 项目选择会持久化，刷新管理页后直接回到上次操作的项目。
async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjectList();
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
      <span class="p-meta">${project.releaseCount} 个版本</span>
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
  el.projectPath.textContent = `${project.rootPath}\\current`;

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
  const activeRelease = state.releases.find(release => release.id === state.activeReleaseId);
  const totalSize = state.releases.reduce((total, release) => total + release.sizeBytes, 0);
  el.projectStatus.textContent = activeRelease ? '线上运行中' : '尚未上线';
  el.projectStatus.classList.toggle('is-online', Boolean(activeRelease));
  el.activeVersion.textContent = activeRelease ? activeRelease.folderName : '—';
  el.releaseCount.textContent = state.releases.length;
  el.releaseSize.textContent = fmtSize(totalSize);
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

function confirmAction({ title, message, confirmText, danger = false }) {
  el.confirmKicker.textContent = danger ? 'Destructive action' : 'Release action';
  el.confirmKicker.classList.toggle('danger-text', danger);
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmSubmitBtn.textContent = confirmText;
  el.confirmSubmitBtn.className = danger ? 'btn btn-danger-solid' : 'btn btn-primary';
  el.confirmDialog.showModal();
  return new Promise(resolve => { confirmResolver = resolve; });
}

function closeConfirm(result) {
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

async function activateRelease(releaseId) {
  const release = state.releases.find(item => item.id === releaseId);
  if (!release) return;
  const confirmed = await confirmAction({
    title: '切换线上版本',
    message: `${fmtTime(release.createdAt)}\n${release.description || '未填写更新说明'}\n\n新请求会立即访问这个版本。`,
    confirmText: '确认切换'
  });
  if (!confirmed) return;

  try {
    await api(`/api/projects/${state.currentProjectId}/releases/${releaseId}/activate`, { method: 'POST' });
    await selectProject(state.currentProjectId);
    await loadProjects();
    showToast('线上版本已切换');
  } catch (error) {
    showToast(`切换失败：${error.message}`, 'error');
  }
}

async function deleteRelease(releaseId) {
  const release = state.releases.find(item => item.id === releaseId);
  if (!release) return;
  const confirmed = await confirmAction({
    title: '删除这个版本？',
    message: `${fmtTime(release.createdAt)}\n${release.description || '未填写更新说明'}\n\n版本文件将永久删除，无法恢复。`,
    confirmText: '删除版本',
    danger: true
  });
  if (!confirmed) return;

  try {
    await api(`/api/projects/${state.currentProjectId}/releases/${releaseId}`, { method: 'DELETE' });
    await selectProject(state.currentProjectId);
    await loadProjects();
    showToast('版本已删除');
  } catch (error) {
    showToast(`删除失败：${error.message}`, 'error');
  }
}

// ---------- 部署 ----------

function openDeployDialog() {
  el.deployForm.reset();
  el.deployError.hidden = true;
  el.deployDialog.showModal();
}

document.getElementById('deployBtn').addEventListener('click', openDeployDialog);
document.getElementById('deployCancelBtn').addEventListener('click', () => el.deployDialog.close());

el.deployForm.addEventListener('submit', async event => {
  event.preventDefault();
  el.deployError.hidden = true;
  el.deploySubmitBtn.disabled = true;
  el.deploySubmitBtn.textContent = '正在部署…';

  try {
    const formData = new FormData(el.deployForm);
    const activate = el.deployForm.elements.namedItem('activate').checked;
    formData.set('activate', activate ? 'true' : 'false');
    await api(`/api/projects/${state.currentProjectId}/deploy`, { method: 'POST', body: formData });
    el.deployDialog.close();
    await selectProject(state.currentProjectId);
    await loadProjects();
    showToast(activate ? '新版本已部署并上线' : '新版本已部署，尚未上线');
  } catch (error) {
    el.deployError.textContent = error.message;
    el.deployError.hidden = false;
  } finally {
    el.deploySubmitBtn.disabled = false;
    el.deploySubmitBtn.textContent = '开始部署';
  }
});

// ---------- 项目设置 ----------

function openProjectDialog(project = null) {
  state.projectDialogMode = project ? 'edit' : 'create';
  el.projectForm.reset();
  el.projectError.hidden = true;
  el.projectDialogTitle.textContent = project ? '项目设置' : '新建项目';
  el.projectSubmitBtn.textContent = project ? '保存更改' : '创建项目';
  el.deleteProjectBtn.hidden = !project;
  el.pathMigrationHint.hidden = !project;

  if (project) {
    el.projectForm.elements.namedItem('name').value = project.name;
    el.projectForm.elements.namedItem('rootPath').value = project.rootPath;
  }
  el.projectDialog.showModal();
}

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
    const name = el.projectForm.elements.namedItem('name').value;
    const rootPath = el.projectForm.elements.namedItem('rootPath').value;
    const project = await api(isEdit ? `/api/projects/${state.currentProjectId}` : '/api/projects', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rootPath })
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

el.deleteProjectBtn.addEventListener('click', () => {
  const project = currentProject();
  if (!project) return;
  el.projectDialog.close();
  el.deleteProjectForm.reset();
  el.deleteProjectError.hidden = true;
  el.deleteProjectName.textContent = project.name;
  el.deleteProjectSubmitBtn.disabled = true;
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

  try {
    await api(`/api/projects/${project.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteFiles })
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
    el.deleteProjectError.textContent = error.message;
    el.deleteProjectError.hidden = false;
  } finally {
    el.deleteProjectSubmitBtn.disabled = false;
    el.deleteProjectSubmitBtn.textContent = '删除项目';
  }
});

// ---------- 清理与辅助操作 ----------

el.cleanupBtn.addEventListener('click', () => {
  el.cleanupForm.reset();
  el.cleanupForm.elements.namedItem('keep').value = Math.min(5, state.releases.length);
  el.cleanupError.hidden = true;
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
    const result = await api(`/api/projects/${state.currentProjectId}/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep })
    });
    el.cleanupDialog.close();
    await selectProject(state.currentProjectId);
    await loadProjects();
    showToast(result.deletedCount ? `已清理 ${result.deletedCount} 个旧版本` : '没有需要清理的版本');
  } catch (error) {
    el.cleanupError.textContent = error.message;
    el.cleanupError.hidden = false;
  } finally {
    el.cleanupSubmitBtn.disabled = false;
    el.cleanupSubmitBtn.textContent = '开始清理';
  }
});

document.getElementById('copyPathBtn').addEventListener('click', async () => {
  try {
    await copyText(el.projectPath.textContent);
    showToast('线上目录已复制');
  } catch (error) {
    showToast('复制失败，请手动选择路径', 'error');
  }
});

async function init() {
  try {
    await loadProjects();
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
