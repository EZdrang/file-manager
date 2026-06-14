const api = window.electronAPI;

let workspaceDir = null;
let currentDir = null;
let currentFile = null;
let expandedDirs = new Set();
let searchTimeout = null;
let linkedFolders = [];
let workspaces = []; // 所有工作目录
let autoCollapse = true;
let clipboard = null; // { action: 'copy'|'cut', entry: {...} }
let multiWindow = false;
let tabs = [];
let activeTabIndex = -1;
let panelMode = 1; // 1/2/3
let dragCtrlDown = false;
let dragData = null;
let dragGhost = null;
let dragSourcePanelIdx = -1;
let shortcutListening = false; // 快捷键录入模式

// 多面板状态
const panels = [{
  currentDir: null,
  fileList: [],
  selectedFiles: new Set(),
  lastClickedIndex: -1,
  sortBy: 'name',
  sortDir: 'asc',
  viewMode: 'list'
}];
let activePanelIndex = 0;

async function sysCopyFiles(entries) {
  const paths = entries.map(e => e.path);
  await api.clipboardWriteFiles(paths);
}

async function sysPasteFiles() {
  const sysFiles = await api.clipboardReadFiles();
  return sysFiles;
}

document.addEventListener('DOMContentLoaded', async () => {
  // 全局错误捕获
  window.onerror = (msg, src, line, col, err) => {
    const detail = `[${new Date().toISOString()}] ${msg}\n位置: ${src}:${line}:${col}\n${err?.stack || ''}`;
    console.error('JS错误:', detail);
    // 显示在预览区域
    const previewArea = document.getElementById('previewArea');
    if (previewArea) {
      previewArea.innerHTML = `<span class="preview-placeholder" style="color:var(--danger);text-align:left;font-size:11px;white-space:pre-wrap;">JS错误: ${msg}\n位置: ${src?.split('/').pop()}:${line}</span>`;
    }
  };
  
  initEventListeners();
  initTheme();
  loadSettings();
  initTabBar();

  // 监听关闭操作
  api.onAskCloseAction(() => {
    const s = getSettings();
    if (s.closeToTray === true) {
      api.hideToTray();
    } else if (s.closeToTray === false) {
      api.quitApp();
    } else {
      showCloseDialog();
    }
  });
  workspaceDir = await api.getWorkspace();
  if (workspaceDir) {
    currentDir = workspaceDir;
    linkedFolders = await api.getLinkedFolders();
    workspaces = await api.getWorkspaces();
    await buildTree();
    tabs = [{ path: workspaceDir, name: workspaceDir.split(/[/\\]/).pop() || '根目录', scrollY: 0 }];
    activeTabIndex = 0;
    renderTabs();
    initFilterBar(0);
    initCategoryViewBtn(0);
    await loadDir(workspaceDir);
  } else {
    document.getElementById('emptyHint').style.display = 'flex';
    document.getElementById('fileTree').style.display = 'none';
  }
  updateTitle();

  api.onOpenDir((dirPath) => {
    openTab(dirPath);
    buildTree().then(() => expandTreeToPath(dirPath));
  });

  // 文件变更监听：自动刷新所有面板
  api.onFileChanged((data) => {
    panels.forEach((p, idx) => {
      if (p.currentDir === data.dir) loadDir(data.dir, idx);
    });
  });

  // 面板模式切换
  document.querySelectorAll('.panel-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchPanelMode(parseInt(btn.dataset.mode)));
  });

  // 初始化最近文件
  renderRecentFiles();
  renderFavorites();

  // 收藏夹折叠/展开
  const favHeader = document.getElementById('favoritesHeader');
  if (favHeader) {
    favHeader.addEventListener('click', () => {
      const list = document.getElementById('favoritesList');
      const arrow = favHeader.querySelector('.recent-files-arrow');
      if (list.style.display === 'none') { list.style.display = 'block'; arrow.textContent = '▼'; }
      else { list.style.display = 'none'; arrow.textContent = '▶'; }
    });
  }

  // 全局跟踪Ctrl键状态（解决Electron drop事件e.ctrlKey不可靠问题）
  document.addEventListener('keydown', (e) => { if (e.key === 'Control') dragCtrlDown = true; });
  document.addEventListener('keyup', (e) => { if (e.key === 'Control') dragCtrlDown = false; });
  document.addEventListener('dragend', () => { dragCtrlDown = false; });
});

function initEventListeners() {
  document.getElementById('minimize').addEventListener('click', () => api.minimize());
  document.getElementById('maximize').addEventListener('click', () => api.maximize());
  document.getElementById('close').addEventListener('click', () => api.close());

  // 预览区链接点击统一用系统浏览器打开
  document.getElementById('previewArea').addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (link && link.href && link.href.startsWith('http')) {
      e.preventDefault();
      e.stopPropagation();
      api.openExternal(link.href);
    }
  });

  // 双击预览区全屏
  document.getElementById('previewArea').addEventListener('dblclick', () => {
    if (!currentFile) return;
    const ext = currentFile.name.split('.').pop().toLowerCase();
    const imageTypes = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'tiff'];
    const videoTypes = ['mp4', 'webm'];
    const pdfTypes = ['pdf'];

    if (!imageTypes.includes(ext) && !videoTypes.includes(ext) && !pdfTypes.includes(ext)) return;

    const overlay = document.getElementById('fullscreenOverlay');
    const content = document.getElementById('fullscreenContent');
    const fileUrl = 'file:///' + currentFile.path.replace(/\\/g, '/');

    if (imageTypes.includes(ext)) {
      content.innerHTML = `<img src="${fileUrl}" alt="全屏预览">`;
    } else if (videoTypes.includes(ext)) {
      content.innerHTML = `<video src="${fileUrl}" controls autoplay style="max-width:95vw;max-height:95vh;"></video>`;
    } else if (pdfTypes.includes(ext)) {
      content.innerHTML = `<iframe src="${fileUrl}"></iframe>`;
    }

    overlay.style.display = 'flex';
  });

  // 关闭全屏
  document.getElementById('fullscreenClose').addEventListener('click', closeFullscreen);
  document.getElementById('fullscreenOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'fullscreenOverlay') closeFullscreen();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('fullscreenOverlay').style.display === 'flex') {
      closeFullscreen();
    }
  });

  document.getElementById('newFolderBtn').addEventListener('click', async () => {
    const ws = await api.addWorkspace();
    if (ws) {
      workspaces = await api.getWorkspaces();
      if (workspaces.length === 1) workspaceDir = ws.path;
      await buildTree();
      showToast(`已添加工作目录: ${ws.name}`, 'success');
    }
  });
  document.getElementById('settingsBtn').addEventListener('click', showSettings);
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('setWorkspaceHint').addEventListener('click', setWorkspace);
  document.getElementById('backBtn').addEventListener('click', goBack);

  document.getElementById('menuSetWorkspace').addEventListener('click', setWorkspace);
  document.getElementById('menuAddRemote').addEventListener('click', showRemoteMount);
  document.getElementById('menuOpenFolder').addEventListener('click', () => { if (currentDir) api.openPath(currentDir); });
  document.getElementById('menuNewFolder').addEventListener('click', createNewFolder);
  document.getElementById('menuRename').addEventListener('click', renameSelected);
  document.getElementById('menuDelete').addEventListener('click', deleteSelected);
  document.getElementById('menuCopyPath').addEventListener('click', copyPath);
  document.getElementById('menuRefresh').addEventListener('click', refresh);
  document.getElementById('menuSortName').addEventListener('click', () => toggleSort('name'));
  document.getElementById('menuSortSize').addEventListener('click', () => toggleSort('size'));
  document.getElementById('menuSortDate').addEventListener('click', () => toggleSort('modified'));
  document.getElementById('menuSortCustom').addEventListener('click', () => toggleSort('custom'));
  document.getElementById('menuAbout').addEventListener('click', showAbout);
  document.getElementById('menuFindDuplicates').addEventListener('click', showDuplicates);
  document.getElementById('menuAutoTagExif').addEventListener('click', autoTagByExif);
  document.getElementById('menuStats').addEventListener('click', showStats);
  document.getElementById('menuNoteList').addEventListener('click', showNoteList);
  document.getElementById('menuExportNotes').addEventListener('click', exportNotes);

  document.getElementById('searchInput').addEventListener('input', function () {
    clearTimeout(searchTimeout);
    const q = this.value.trim();
    if (q) {
      // Detect Windows path (C:\, D:\, \\server\share, etc.)
      const isWinPath = /^[A-Za-z]:\\/.test(q) || /^\\\\/.test(q);
      if (isWinPath) {
        searchTimeout = setTimeout(async () => {
          await navigateToPath(q);
        }, 300);
        return;
      }
      searchTimeout = setTimeout(async () => {
        try {
          await advancedSearch(q);
        } catch (e) { console.error('Search error:', e); }
      }, 300);
    } else {
      clearSearchHighlight();
      if (panels[activePanelIndex].currentDir) loadDir(panels[activePanelIndex].currentDir, activePanelIndex);
    }
  });

  // 搜索范围切换
  document.querySelectorAll('.scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scope-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const q = document.getElementById('searchInput').value.trim();
      if (q) advancedSearch(q);
    });
  });

  document.getElementById('searchClear').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    clearSearchHighlight();
    const dir = panels[activePanelIndex].currentDir;
    if (dir) loadDir(dir, activePanelIndex);
  });

  document.getElementById('searchInput').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    document.getElementById('searchInput').value = '';
    clearSearchHighlight();
    const dir = panels[activePanelIndex].currentDir;
    if (dir) loadDir(dir, activePanelIndex);
  });

  document.addEventListener('contextmenu', (e) => {
    // 任何pre元素（预览区、模态框文档、API设置、日志查看器）
    const pre = e.target.closest('pre');
    if (pre) {
      e.preventDefault();
      const sel = window.getSelection().toString();
      const existing = document.querySelector('.context-menu');
      if (existing) existing.remove();
      const menu = document.createElement('div');
      menu.className = 'context-menu';
      const items = [];
      if (sel) items.push({ icon: '📋', label: '复制', action: () => { navigator.clipboard.writeText(sel); showToast('已复制', 'success'); } });
      items.push({ icon: '📎', label: '全选', action: () => { const r = document.createRange(); r.selectNodeContents(pre); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } });
      for (const item of items) {
        const btn = document.createElement('button');
        btn.className = 'ctx-menu-item';
        btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
        btn.addEventListener('click', () => { menu.remove(); item.action(); });
        menu.appendChild(btn);
      }
      positionMenu(menu, e);
      closeMenuOnClick(menu);
      return;
    }
    // Tags / Notes inputs
    const input = e.target.closest('#tagsInput, #notesInput');
    if (input) {
      e.preventDefault();
      const sel = input.value.substring(input.selectionStart, input.selectionEnd);
      const existing = document.querySelector('.context-menu');
      if (existing) existing.remove();
      const menu = document.createElement('div');
      menu.className = 'context-menu';
      const items = [];
      if (sel) {
        items.push({ icon: '✂️', label: '剪切', action: async () => { await navigator.clipboard.writeText(sel); input.setRangeText('', input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input')); } });
        items.push({ icon: '📋', label: '复制', action: () => { navigator.clipboard.writeText(sel); showToast('已复制', 'success'); } });
      }
      items.push({ icon: '📌', label: '粘贴', action: async () => { const text = await navigator.clipboard.readText(); input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input')); } });
      items.push({ icon: '📎', label: '全选', action: () => { input.select(); } });
      if (sel) items.push({ icon: '🗑️', label: '删除', action: () => { input.setRangeText('', input.selectionStart, input.selectionEnd, 'end'); input.dispatchEvent(new Event('input')); } });
      for (const item of items) {
        const btn = document.createElement('button');
        btn.className = 'ctx-menu-item';
        btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
        btn.addEventListener('click', () => { menu.remove(); item.action(); });
        menu.appendChild(btn);
      }
      positionMenu(menu, e);
      closeMenuOnClick(menu);
      return;
    }
  });

  document.getElementById('saveBtn').addEventListener('click', saveMeta);
  document.getElementById('closePanel').addEventListener('click', () => {
    document.getElementById('detailPanel').style.display = 'none';
    const exif = document.getElementById('exifPanel');
    if (exif) exif.remove();
    currentFile = null;
  });

  // 面板拖拽调整宽度
  const resizeHandle = document.getElementById('panelResizeHandle');
  const detailPanel = document.getElementById('detailPanel');
  let isResizing = false;

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizeHandle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const rect = detailPanel.getBoundingClientRect();
    const newWidth = rect.right - e.clientX;
    if (newWidth >= 200 && newWidth <= 600) {
      detailPanel.style.width = newWidth + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizeHandle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  document.addEventListener('keydown', async (e) => {
    if (e.target.closest('input,textarea,pre,#logContentPre')) return;
    if (shortcutListening) return; // 快捷键录入模式不触发操作

    const sc = getShortcuts();
    const get = (id) => sc.find(s => s.id === id)?.key;

    if (matchShortcut(e, get('refresh'))) { e.preventDefault(); refresh(); }
    if (matchShortcut(e, get('rename'))) { e.preventDefault(); renameSelected(); }
    if (matchShortcut(e, get('delete'))) { deleteSelected(); }
    if (matchShortcut(e, get('goBack'))) { e.preventDefault(); goBack(); }
    if (matchShortcut(e, get('openFile'))) {
      const sel = document.querySelector('.file-table tbody tr.selected');
      if (sel) {
        const entry = panels[activePanelIndex].fileList.find(f => f.path === sel.dataset.path);
        if (entry) {
          if (entry.isDir) loadDir(entry.path, activePanelIndex);
          else api.openPath(entry.path);
        }
      }
    }
    if (matchShortcut(e, get('closePanel'))) { document.getElementById('detailPanel').style.display = 'none'; currentFile = null; }

    if (matchShortcut(e, get('newFolder'))) { e.preventDefault(); createNewFolder(); }
    if (matchShortcut(e, get('copy'))) {
      const sel = document.querySelector('.file-table tbody tr.selected');
      if (sel) {
        const entry = panels[activePanelIndex].fileList.find(f => f.path === sel.dataset.path);
        if (entry) { clipboard = { action: 'copy', entry }; sysCopyFiles([entry]); showToast(`已复制: ${entry.name}`, 'success'); }
      }
    }
    if (matchShortcut(e, get('cut'))) {
      const sel = document.querySelector('.file-table tbody tr.selected');
      if (sel) {
        const entry = panels[activePanelIndex].fileList.find(f => f.path === sel.dataset.path);
        if (entry) { clipboard = { action: 'cut', entry }; sysCopyFiles([entry]); showToast(`已剪切: ${entry.name}`, 'success'); }
      }
    }
    if (matchShortcut(e, get('paste'))) {
      const sysFiles = await api.clipboardReadFiles();
      if (sysFiles && sysFiles.length > 0) pasteFromSystemClipboard();
      else if (clipboard && panels[activePanelIndex].currentDir) pasteToFolder(panels[activePanelIndex].currentDir);
    }
    if (matchShortcut(e, get('selectAll'))) {
      e.preventDefault();
      const p = panels[activePanelIndex];
      document.querySelectorAll('.file-table tbody tr').forEach(tr => {
        if (tr.dataset.path) {
          tr.classList.add('selected');
          p.selectedFiles.add(tr.dataset.path);
        }
      });
      updateBatchBar(activePanelIndex);
    }
    if (matchShortcut(e, get('undo'))) {
      e.preventDefault();
      const result = await api.undo();
      if (result.success) { showToast(result.message, 'success'); panels.forEach((p, idx) => { if (p.currentDir) loadDir(p.currentDir, idx); }); }
      else showToast(result.message, 'error');
    }
    if (matchShortcut(e, get('redo'))) {
      e.preventDefault();
      const result = await api.redo();
      if (result.success) { showToast(result.message, 'success'); panels.forEach((p, idx) => { if (p.currentDir) loadDir(p.currentDir, idx); }); }
      else showToast(result.message, 'error');
    }
  });

  // Alt+scroll = horizontal scroll for tree
  document.getElementById('sidebarTreeContainer').addEventListener('wheel', (e) => {
    if (e.altKey) {
      e.preventDefault();
      e.currentTarget.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // Right-click on tree empty area
  document.getElementById('sidebarTreeContainer').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-node-item')) return;
    e.preventDefault();
    showTreeBgContextMenu(e);
  });
}

function showTreeBgContextMenu(e) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = [
    { icon: '🔄', label: '刷新目录树', action: () => { buildTree(); showToast('已刷新', 'success'); } },
  ];

  if (clipboard && currentDir) {
    items.push({ icon: '📌', label: '粘贴到当前目录', action: () => pasteToFolder(currentDir) });
  }

  items.push({ sep: true });
  items.push({ icon: '🔗', label: '链接外部文件夹', action: () => linkNewFolder() });

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = `ctx-menu-item ${item.cls || ''}`;
      btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(btn);
    }
  }

  positionMenu(menu, e);
  closeMenuOnClick(menu);
}

function initTabBar() {
  document.getElementById('tabAddBtn').addEventListener('click', () => {
    openTab(currentDir || workspaceDir);
  });
}

function openTab(dirPath) {
  const existing = tabs.findIndex(t => t.path === dirPath);
  if (existing >= 0) {
    switchTab(existing);
    return;
  }

  const name = dirPath.split(/[/\\]/).pop() || '根目录';
  tabs.push({ path: dirPath, name, scrollY: 0 });
  activeTabIndex = tabs.length - 1;
  renderTabs();
  loadDir(dirPath);
}

function switchTab(index) {
  if (index < 0 || index >= tabs.length) return;

  // 保存当前标签页滚动位置
  if (activeTabIndex >= 0 && activeTabIndex < tabs.length) {
    const container = document.querySelector('.file-table-container');
    if (container) tabs[activeTabIndex].scrollY = container.scrollTop;
  }

  activeTabIndex = index;
  currentDir = tabs[index].path;
  renderTabs();
  loadDir(tabs[index].path).then(() => {
    const container = document.querySelector('.file-table-container');
    if (container) container.scrollTop = tabs[index].scrollY;
  });
}

function closeTab(index, e) {
  if (e) e.stopPropagation();
  if (tabs.length <= 1) return;

  tabs.splice(index, 1);

  if (activeTabIndex >= tabs.length) {
    activeTabIndex = tabs.length - 1;
  } else if (activeTabIndex > index) {
    activeTabIndex--;
  } else if (activeTabIndex === index) {
    activeTabIndex = Math.min(index, tabs.length - 1);
  }

  renderTabs();
  if (activeTabIndex >= 0) {
    currentDir = tabs[activeTabIndex].path;
    loadDir(tabs[activeTabIndex].path);
  }
}

function renderTabs() {
  const tabBar = document.getElementById('tabBar');
  tabBar.style.display = multiWindow ? 'flex' : 'none';

  const container = document.getElementById('tabsContainer');
  container.innerHTML = '';

  tabs.forEach((tab, i) => {
    const item = document.createElement('div');
    item.className = `tab-item ${i === activeTabIndex ? 'active' : ''}`;

    const dirIcon = tab.path === workspaceDir ? '📂' : '📁';
    item.innerHTML = `
      <span class="tab-icon">${dirIcon}</span>
      <span class="tab-name" title="${tab.path}">${tab.name}</span>
      <button class="tab-close" title="关闭标签页">✕</button>
    `;

    item.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) switchTab(i);
    });

    item.querySelector('.tab-close').addEventListener('click', (e) => closeTab(i, e));

    container.appendChild(item);
  });
}

// === 工作目录 ===
async function setWorkspace() {
  const dir = await api.setWorkspace();
  if (dir) {
    workspaceDir = dir;
    currentDir = dir;
    expandedDirs.clear();
    document.getElementById('emptyHint').style.display = 'none';
    document.getElementById('fileTree').style.display = 'block';
    workspaces = await api.getWorkspaces();
    await buildTree();
    await expandTreeToPath(workspaceDir);
    highlightTreeNode(workspaceDir);
    await loadDir(dir);
    updateTitle();
    showToast(`工作目录: ${dir.split(/[/\\]/).pop()}`, 'success');
  }
}

async function updateTitle() {
  let name = '未选择目录';
  if (workspaceDir) {
    const parts = workspaceDir.split(/[/\\]/).filter(Boolean);
    name = parts[parts.length - 1] || workspaceDir;
    try {
      const meta = await api.getMeta(workspaceDir);
      if (meta && meta.folderNote) name = meta.folderNote;
    } catch (e) {}
  }
  document.getElementById('titlebarTitle').textContent = `资料管理系统 - ${name}`;
}

// === 文件树（左侧边栏）===
async function buildTree() {
  const tree = document.getElementById('fileTree');
  if (!tree) return;
  tree.innerHTML = '';

  try {
    // 显示所有工作目录
    for (const ws of workspaces) {
      const isNetwork = /^[A-Z]:\\?$/.test(ws.path) && !ws.path.startsWith('C');
      const icon = ws.isPrimary ? '🏠' : isNetwork ? '🌐' : '📁';
      const label = ws.isPrimary ? ws.name : `${ws.name}`;
      const item = document.createElement('div');
      item.className = 'tree-node-item';
      item.style.paddingLeft = '8px';
      item.dataset.path = ws.path;
      item.dataset.workspaceId = ws.id;

      let displayName = label;
      let noteDot = '';
      try {
        const meta = await api.getMeta(ws.path);
        if (meta.folderColor) {
          item.style.color = meta.folderColor;
          item.style.fontWeight = '600';
        }
        if (meta.folderNote) {
          displayName = meta.folderNote;
          noteDot = `<span class="tree-note-dot" style="background:${meta.folderColor || 'var(--accent)'}"></span>`;
        }
      } catch (e) {}

      const sizeEl = document.createElement('span');
      sizeEl.className = 'tree-dir-size';
      sizeEl.style.cssText = 'margin-left:auto;font-size:11px;color:var(--text-muted);padding-right:8px;';
      const primaryBadge = ws.isPrimary ? '<span style="font-size:10px;background:var(--accent);color:white;padding:1px 5px;border-radius:4px;margin-left:4px;">主</span>' : '';
      item.innerHTML = `<span class="tree-arrow">▶</span>${noteDot}<span class="tree-file-icon">${icon}</span><span class="tree-file-name">${escapeHtml(displayName)}</span>${primaryBadge}`;
      item.appendChild(sizeEl);
      item.style.display = 'flex';
      // 异步加载根目录大小
      api.getDirSize(ws.path).then(size => {
        if (size > 0) sizeEl.textContent = formatSize(size);
      });

      const childrenEl = document.createElement('div');
      childrenEl.className = 'tree-children';
      childrenEl.style.display = 'none';

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        document.querySelectorAll('.tree-node-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        const arrow = item.querySelector('.tree-arrow');
        const isOpen = childrenEl.style.display !== 'none';
        if (isOpen) {
          childrenEl.style.display = 'none';
          arrow.classList.remove('expanded');
        } else {
          // 自动收缩其他工作目录根节点
          if (autoCollapse) {
            tree.querySelectorAll(':scope > .tree-children').forEach(sc => {
              if (sc !== childrenEl) {
                sc.style.display = 'none';
                const sibItem = sc.previousElementSibling;
                if (sibItem) sibItem.querySelector('.tree-arrow')?.classList.remove('expanded');
              }
            });
          }
          if (childrenEl.children.length === 0) {
            await loadChildren(childrenEl, ws.path, 1, !ws.isPrimary);
          }
          childrenEl.style.display = 'block';
          arrow.classList.add('expanded');
        }
        currentDir = ws.path;
        tabs[activeTabIndex] = { ...tabs[activeTabIndex], path: ws.path, name: ws.name };
        renderTabs();
        await loadDir(ws.path);
        updateBreadcrumb(ws.path);
      });

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showWorkspaceContextMenu(e, ws);
      });

      // 根节点可拖拽（到副面板或重排）
      item.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.tree-arrow')) return;
        const startX = e.clientX;
        const startY = e.clientY;
        let started = false;
        let targetItem = null;

        const onMove = (me) => {
          const dx = me.clientX - startX;
          const dy = me.clientY - startY;
          if (!started && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
            started = true;
            dragData = { path: ws.path, isDir: true, fromTree: true, wsId: ws.id };
            item.classList.add('dragging');
            dragGhost = document.createElement('div');
            dragGhost.className = 'drag-ghost';
            dragGhost.textContent = ws.name;
            document.body.appendChild(dragGhost);
          }
          if (started && dragGhost) {
            dragGhost.style.left = (me.clientX + 12) + 'px';
            dragGhost.style.top = (me.clientY + 12) + 'px';

          // 检测悬停位置
          const hoverEl = document.elementFromPoint(me.clientX, me.clientY);
          const hoverNode = hoverEl?.closest('.tree-node-item[data-workspace-id]');
          tree.querySelectorAll('.tree-node-item').forEach(n => { n.style.borderTop = ''; n.style.borderBottom = ''; });
          tree.style.borderBottom = '';
          targetItem = null;

          if (hoverNode && hoverNode !== item && hoverNode.dataset.workspaceId) {
            const rect = hoverNode.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (me.clientY < midY) {
              hoverNode.style.borderTop = '2px solid var(--accent)';
              targetItem = { node: hoverNode, pos: 'before' };
            } else {
              hoverNode.style.borderBottom = '2px solid var(--accent)';
              targetItem = { node: hoverNode, pos: 'after' };
            }
          } else {
            const treeRect = tree.getBoundingClientRect();
            if (me.clientY > treeRect.bottom - 20 && me.clientY < treeRect.bottom + 10) {
              tree.style.borderBottom = '2px solid var(--accent)';
              targetItem = { node: null, pos: 'end' };
            }
          }
          }
        };

        const onUp = async () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          item.classList.remove('dragging');
          tree.querySelectorAll('.tree-node-item').forEach(n => n.classList.remove('drag-over'));
          if (dragGhost) { dragGhost.remove(); dragGhost = null; }

          // 重排工作目录
          tree.querySelectorAll('.tree-node-item').forEach(n => { n.style.borderTop = ''; n.style.borderBottom = ''; });
          tree.style.borderBottom = '';

          if (targetItem) {
            const fromIdx = workspaces.findIndex(w => w.id === ws.id);
            if (fromIdx >= 0) {
              let toIdx;
              if (targetItem.pos === 'end') {
                toIdx = workspaces.length;
              } else {
                const targetId = parseInt(targetItem.node.dataset.workspaceId);
                toIdx = workspaces.findIndex(w => w.id === targetId);
                if (targetItem.pos === 'after') toIdx++;
              }
              if (toIdx !== fromIdx && toIdx !== fromIdx + 1) {
                const [moved] = workspaces.splice(fromIdx, 1);
                const insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
                workspaces.splice(insertIdx, 0, moved);
                await api.saveWorkspaceOrder(workspaces);
                await buildTree();
              }
            }
          }

          dragData = null;
          targetItem = null;
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      tree.appendChild(item);
      tree.appendChild(childrenEl);
    }
  } catch (err) {
    console.error('buildTree error:', err);
  }
}

async function loadChildren(container, dirPath, depth, isLinked) {
  const entries = await api.readDir(dirPath);
  const dirs = entries.filter(e => e.isDir);
  for (const d of dirs) {
    createChildNode(container, d.name, d.path, depth, isLinked);
  }
}

async function createChildNode(container, name, fullPath, depth, isLinked) {
  const item = document.createElement('div');
  item.className = 'tree-node-item';
  item.style.paddingLeft = (depth * 16 + 8) + 'px';
  item.dataset.path = fullPath;

  let displayName = name;
  let noteDot = '';
  try {
    const meta = await api.getMeta(fullPath);
    if (meta.folderColor) {
      item.style.color = meta.folderColor;
      item.style.fontWeight = '600';
    }
    if (meta.folderNote) {
      displayName = meta.folderNote;
      noteDot = `<span class="tree-note-dot" style="background:${meta.folderColor || 'var(--accent)'}"></span>`;
    }
  } catch (e) {}

  const sizeEl = document.createElement('span');
  sizeEl.className = 'tree-dir-size';
  sizeEl.style.cssText = 'margin-left:auto;font-size:11px;color:var(--text-muted);opacity:0;transition:opacity 0.3s;padding-right:8px;';

  item.innerHTML = `<span class="tree-arrow">▶</span>${noteDot}<span class="tree-file-icon">📂</span><span class="tree-file-name">${escapeHtml(displayName)}</span>`;
  item.appendChild(sizeEl);
  item.style.display = 'flex';

  const lineEl = document.createElement('div');
  lineEl.className = 'tree-line';
  item.insertBefore(lineEl, item.firstChild);

  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  childrenEl.style.display = 'none';

  item.addEventListener('click', async (e) => {
    e.stopPropagation();
    document.querySelectorAll('.tree-node-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    const arrow = item.querySelector('.tree-arrow');
    const isOpen = childrenEl.style.display !== 'none';
    if (isOpen) {
      childrenEl.style.display = 'none';
      arrow.classList.remove('expanded');
    } else {
      if (autoCollapse) {
        const siblingContainers = container.querySelectorAll(':scope > .tree-children');
        siblingContainers.forEach(sc => {
          if (sc !== childrenEl) {
            sc.style.display = 'none';
            const sibItem = sc.previousElementSibling;
            if (sibItem) {
              const sibArrow = sibItem.querySelector('.tree-arrow');
              if (sibArrow) sibArrow.classList.remove('expanded');
            }
          }
        });
      }
      if (childrenEl.querySelectorAll('.tree-node-item').length === 0) {
        await loadChildren(childrenEl, fullPath, depth + 1, isLinked);
      }
      childrenEl.style.display = 'block';
      arrow.classList.add('expanded');
      // 展开时异步加载文件夹大小
      if (!sizeEl.dataset.loaded) {
        sizeEl.dataset.loaded = '1';
        api.getDirSize(fullPath).then(size => {
          if (size > 0) {
            sizeEl.textContent = formatSize(size);
            sizeEl.style.opacity = '1';
          }
        });
      }
    }
    currentDir = fullPath;
    tabs[activeTabIndex] = { ...tabs[activeTabIndex], path: fullPath, name: fullPath.split(/[/\\]/).pop() || '根目录' };
    renderTabs();
    await loadDir(fullPath);
    updateBreadcrumb(fullPath);
  });

  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showTreeContextMenu(e, fullPath, name);
  });

  // 目录树节点可拖拽
  item.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tree-arrow')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const onMove = (me) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (!started && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        started = true;
        dragData = { path: fullPath, isDir: true, fromTree: true };
        item.classList.add('dragging');
        dragGhost = document.createElement('div');
        dragGhost.className = 'drag-ghost';
        dragGhost.textContent = name;
        document.body.appendChild(dragGhost);
      }
      if (started && dragGhost) {
        dragGhost.style.left = (me.clientX + 12) + 'px';
        dragGhost.style.top = (me.clientY + 12) + 'px';
      }
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      item.classList.remove('dragging');
      if (dragGhost) { dragGhost.remove(); dragGhost = null; }
      dragData = null;
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  container.appendChild(item);
  container.appendChild(childrenEl);
}

// === 文件列表（右侧面板）===
async function loadDir(dirPath, panelIdx) {
  if (!dirPath) return;
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  if (!p) return;
  p.currentDir = dirPath;

  // 启动文件监听
  api.watchDir(dirPath);

  const entries = await api.readDir(dirPath);

  // Sort
  if (p.sortBy === 'custom') {
    const order = getCustomOrder(dirPath);
    if (order.length > 0) {
      const orderMap = new Map(order.map((p, i) => [p, i]));
      entries.sort((a, b) => {
        const ai = orderMap.has(a.path) ? orderMap.get(a.path) : 9999;
        const bi = orderMap.has(b.path) ? orderMap.get(b.path) : 9999;
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
      });
    }
  } else if (p.sortBy !== 'name' || p.sortDir !== 'asc') {
    // 默认按名称升序已在 read-dir 中排序，跳过重复排序
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let va, vb;
      switch (p.sortBy) {
        case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
        case 'size': va = a.size || 0; vb = b.size || 0; break;
        case 'modified': va = a.modified || ''; vb = b.modified || ''; break;
        default: va = a.name.toLowerCase(); vb = b.name.toLowerCase();
      }
      if (va < vb) return p.sortDir === 'asc' ? -1 : 1;
      if (va > vb) return p.sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  p.fileList = entries;
  
  // 预加载 meta 缓存（看板视图用）
  if (p.viewMode === 'kanban') {
    _metaCache.clear();
    for (const entry of entries) {
      if (!entry.isDir) {
        try {
          const meta = await api.getMeta(entry.path);
          _metaCache.set(entry.path, meta);
        } catch (e) {}
      }
    }
  }
  
  const filtered = applyFilters(entries, panelIdx);
  renderFileList(filtered, panelIdx);
  updateFilterClearBtn(panelIdx);

  updateBreadcrumb(dirPath, panelIdx);
}

function renderFileList(entries, panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  const tbody = document.getElementById('fileTableBody' + panelIdx);
  if (!tbody) return;
  tbody.innerHTML = '';
  const currentDir = p.currentDir;

  // 返回上一层按钮
  if (currentDir && currentDir !== workspaceDir) {
    const parentDir = currentDir.replace(/[/\\][^/\\]+$/, '');
    const upRow = document.createElement('tr');
    upRow.innerHTML = `<td colspan="4"><div class="file-name"><span class="file-icon">⬆️</span><span>..</span></div></td>`;
    upRow.style.cursor = 'pointer';
    upRow.addEventListener('click', async () => {
      await loadDir(parentDir, panelIdx);
    });
    tbody.appendChild(upRow);
  }

  if (p.viewMode === 'category') {
    renderCategoryView(entries, panelIdx, tbody, currentDir);
  } else if (p.viewMode === 'kanban') {
    renderKanbanView(entries, panelIdx, tbody, currentDir);
  } else {
    loadTagsForEntries(entries, tbody, panelIdx);
  }
}

async function loadTagsForEntries(entries, tbody, panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const ext = entry.name.split('.').pop().toLowerCase();
    const icon = entry.isDir ? '📂' : getFileIcon(ext);
    const sizeStr = entry.isDir ? '-' : formatSize(entry.size);
    const dateStr = formatDate(entry.modified);

    let tagsHtml = '';
    if (!entry.isDir) {
      try {
        const meta = await api.getMeta(entry.path);
        if (meta.tags) tagsHtml = renderTags(meta.tags);
      } catch (e) {}
    }

    const tr = document.createElement('tr');
    tr.dataset.path = entry.path;
    tr.dataset.isDir = entry.isDir;
    tr.innerHTML = `
      <td><div class="file-name"><span class="file-icon">${icon}</span><span>${entry.name}</span></div></td>
      <td><div class="file-tags">${tagsHtml}</div></td>
      <td>${sizeStr}</td>
      <td>${dateStr}</td>
    `;

    const idx = panelIdx;
    tr.addEventListener('click', (e) => {
      const pp = panels[idx];
      const currentIndex = i;
      
      if (e.ctrlKey || e.metaKey) {
        if (pp.selectedFiles.has(entry.path)) {
          pp.selectedFiles.delete(entry.path);
          tr.classList.remove('selected');
        } else {
          pp.selectedFiles.add(entry.path);
          tr.classList.add('selected');
        }
      } else if (e.shiftKey && pp.lastClickedIndex >= 0) {
        const start = Math.min(pp.lastClickedIndex, currentIndex);
        const end = Math.max(pp.lastClickedIndex, currentIndex);
        const rows = tbody.querySelectorAll('tr');
        for (let j = start; j <= end; j++) {
          if (rows[j] && rows[j].dataset.path) {
            pp.selectedFiles.add(rows[j].dataset.path);
            rows[j].classList.add('selected');
          }
        }
      } else {
        clearSelection(idx);
        pp.selectedFiles.add(entry.path);
        tr.classList.add('selected');
        if (!entry.isDir) openFileDetail(entry);
      }
      
      pp.lastClickedIndex = currentIndex;
      updateBatchBar(idx);
    });

    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const pp = panels[idx];
      if (!pp.selectedFiles.has(entry.path)) {
        clearSelection(idx);
        pp.selectedFiles.add(entry.path);
        tr.classList.add('selected');
      }
      showFileContextMenu(e, entry);
    });

    tr.addEventListener('dblclick', () => {
      if (entry.isDir) {
        loadDir(entry.path, idx);
      } else {
        addRecentFile(entry.path);
        api.openPath(entry.path);
      }
    });

    // 拖拽（自定义实现，兼容Electron）
    tr.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('input,textarea,button,a')) return;
      
      const startX = e.clientX;
      const startY = e.clientY;
      let started = false;

      const onMove = (me) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        
        if (!started && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
          started = true;
          dragData = { path: entry.path, isDir: entry.isDir, panelIdx: idx };
          dragSourcePanelIdx = idx;
          tr.classList.add('dragging');
          
          dragGhost = document.createElement('div');
          dragGhost.className = 'drag-ghost';
          dragGhost.textContent = entry.name;
          document.body.appendChild(dragGhost);
        }
        
        if (started && dragGhost) {
          dragGhost.style.left = (me.clientX + 12) + 'px';
          dragGhost.style.top = (me.clientY + 12) + 'px';
        }

        // 拖出窗口时触发原生拖拽（拖到资源管理器/桌面）
        if (started) {
          const w = window.innerWidth;
          const h = window.innerHeight;
          if (me.clientX < 0 || me.clientX > w || me.clientY < 0 || me.clientY > h) {
            cleanup();
            api.startDrag(entry.path);
          }
        }
      };

      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        tr.classList.remove('dragging');
        if (dragGhost) {
          dragGhost.remove();
          dragGhost = null;
        }
        dragData = null;
      };

      const onUp = () => {
        cleanup();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // 文件夹接受拖入（自定义实现）
    if (entry.isDir) {
      tr.addEventListener('mouseenter', () => {
        if (!dragData) return;
        if (dragData.path === entry.path) return;
        if (dragCtrlDown) {
          tr.classList.add('drag-over-copy');
        } else {
          tr.classList.add('drag-over');
        }
      });

      tr.addEventListener('mouseleave', () => {
        tr.classList.remove('drag-over', 'drag-over-copy');
      });

      tr.addEventListener('mouseup', async (e) => {
        tr.classList.remove('drag-over', 'drag-over-copy');
        if (!dragData) return;
        if (dragData.path === entry.path) return;
        if (e.button !== 0) return;
        
        try {
          const dragItem = dragData;
          const fileName = dragItem.path.split(/[/\\]/).pop();
          const destPath = entry.path + '\\' + fileName;
          
          if (dragItem.isDir) {
            showToast('暂不支持操作文件夹', 'error');
            return;
          }
          
          const isCopy = dragCtrlDown;
          const success = isCopy
            ? await api.copyFile(dragItem.path, destPath)
            : await api.moveFile(dragItem.path, destPath);
          
          if (success) {
            showToast(`${isCopy ? '已复制' : '已移动'}: ${fileName}`, 'success');
            await loadDir(p.currentDir, idx);
            if (dragItem.panelIdx !== undefined && dragItem.panelIdx !== idx) {
              await loadDir(panels[dragItem.panelIdx].currentDir, dragItem.panelIdx);
            }
          } else {
            showToast(isCopy ? '复制失败' : '移动失败', 'error');
          }
        } catch (err) {
          showToast('操作失败', 'error');
        }
        dragData = null;
      });
    }

    tbody.appendChild(tr);

    // 自定义排序模式：行可拖拽重排
    if (p.sortBy === 'custom') {
      tr.setAttribute('draggable', 'true');
      tr.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', entry.path);
        e.dataTransfer.effectAllowed = 'move';
        tr.classList.add('dragging');
      });
      tr.addEventListener('dragend', () => {
        tr.classList.remove('dragging');
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
      });
      tr.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
        tr.classList.add('drag-over');
      });
      tr.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        tr.classList.remove('drag-over');
        const srcPath = e.dataTransfer.getData('text/plain');
        if (!srcPath || srcPath === entry.path) return;
        
        const rows = [...tbody.querySelectorAll('tr')];
        const paths = rows.map(r => r.dataset.path).filter(Boolean);
        const fromIdx = paths.indexOf(srcPath);
        const toIdx = paths.indexOf(entry.path);
        if (fromIdx < 0 || toIdx < 0) return;
        
        paths.splice(fromIdx, 1);
        paths.splice(toIdx, 0, srcPath);
        saveCustomOrder(p.currentDir, paths);
        
        loadDir(p.currentDir, idx);
      });
    }
  }
}

async function openFileDetail(entry) {
  try {
  currentFile = entry;
  addRecentFile(entry.path);
  // 清理旧的 EXIF 面板
  const oldExif = document.getElementById('exifPanel');
  if (oldExif) oldExif.remove();
  // 展开目录树到该文件的父目录
  const dir = entry.path.replace(/[/\\][^/\\]+$/, '');
  highlightTreeNode(dir);
  document.getElementById('detailPanel').style.display = 'flex';
  document.getElementById('detailTitle').textContent = entry.name;

  const ext = entry.name.split('.').pop().toLowerCase();
  const fileType = getFileTypeInfo(ext);

  document.getElementById('fileInfo').innerHTML = `
    <p style="margin-bottom:6px;"><span style="font-size:16px;margin-right:6px;">${fileType.icon}</span><strong>${entry.name}</strong></p>
    <p style="color:var(--text-muted);font-size:12px;margin-bottom:8px;">${fileType.label}</p>
    ${fileType.lang ? `<p style="margin-bottom:4px;"><span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:var(--bg-tertiary);border-radius:4px;font-size:12px;">${fileType.langLogo} ${fileType.lang}</span></p>` : ''}
    <p><strong>路径:</strong> <span class="copy-path" data-copy-path="${entry.path}" style="font-size:11px;color:var(--text-muted);word-break:break-all;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" title="点击复制路径">${entry.path}</span></p>
    <p><strong>大小:</strong> ${formatSize(entry.size)}</p>
    <p><strong>修改时间:</strong> ${formatDate(entry.modified)}</p>
  `;

  const meta = await api.getMeta(entry.path);
  document.getElementById('tagsInput').value = meta.tags || '';
  document.getElementById('notesInput').value = meta.notes || '';

  const previewArea = document.getElementById('previewArea');
  const imageTypes = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'tiff'];
  const videoTypes = ['mp4', 'webm'];
  const audioTypes = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus'];
  const textTypes = [
    'txt', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sql',
    'py', 'js', 'ts', 'jsx', 'tsx', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'dart', 'lua', 'r',
    'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
    'sh', 'bat', 'cmd', 'ps1', 'makefile', 'dockerfile', 'gitignore'
  ];

  if (imageTypes.includes(ext)) {
    previewArea.innerHTML = `
      <div class="preview-zoom-container" id="previewZoom">
        <img src="file:///${entry.path.replace(/\\/g, '/')}" alt="预览">
      </div>
      <div class="preview-rotate-bar">
        <button class="preview-rotate-btn" data-deg="-90" title="逆时针旋转90°">↺</button>
        <button class="preview-rotate-btn" data-deg="180" title="旋转180°">↕</button>
        <button class="preview-rotate-btn" data-deg="90" title="顺时针旋转90°">↻</button>
      </div>`;
    initPreviewZoom();
    initPreviewRotate();
    // 加载 EXIF 信息
    loadExifInfo(entry.path, previewArea);
  } else if (videoTypes.includes(ext)) {
    const videoUrl = 'file:///' + entry.path.replace(/\\/g, '/');
    previewArea.innerHTML = `<video src="${videoUrl}" controls autoplay style="max-width:100%;max-height:100%;border-radius:8px;">您的浏览器不支持视频预览</video>`;
  } else if (audioTypes.includes(ext)) {
    const audioUrl = 'file:///' + entry.path.replace(/\\/g, '/');
    previewArea.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;"><span style="font-size:48px;margin-bottom:12px;">🎵</span><audio src="${audioUrl}" controls autoplay style="width:90%;max-width:300px;"></audio></div>`;
  } else if (ext === 'pdf') {
    const pdfUrl = 'file:///' + entry.path.replace(/\\/g, '/');
    previewArea.innerHTML = `<div class="preview-zoom-container" id="previewZoom"><iframe src="${pdfUrl}"></iframe></div>`;
    initPreviewZoom();
  } else if (ext === 'docx') {
    const buffer = await api.readFileBuffer(entry.path);
    if (buffer) {
      try {
        const arrayBuffer = Uint8Array.from(atob(buffer), c => c.charCodeAt(0)).buffer;
        const result = await mammoth.convertToHtml({ arrayBuffer });
        const html = result.value || '<p style="color:var(--text-muted);">文档内容为空</p>';
        previewArea.innerHTML = `<div class="docx-preview">${html}</div>`;
      } catch (e) {
        previewArea.innerHTML = `<span class="preview-placeholder">Word 预览失败<br><small>${e.message}</small></span>`;
      }
    } else {
      previewArea.innerHTML = `<span class="preview-placeholder">无法读取</span>`;
    }
  } else if (ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'tar' || ext === 'gz') {
    const entries = await api.readZip(entry.path);
    if (entries && entries.length > 0) {
      let archiveHtml = `<div class="archive-preview"><div class="archive-header">📦 ${entries.length} 个文件</div><div class="archive-list">`;
      for (const e of entries) {
        const icon = e.isDir ? '📁' : getFileIcon(e.name.split('.').pop().toLowerCase());
        const sizeStr = e.size ? formatSize(e.size) : '-';
        archiveHtml += `<div class="archive-item"><span>${icon}</span><span class="archive-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span><span class="archive-size">${sizeStr}</span></div>`;
      }
      archiveHtml += '</div></div>';
      previewArea.innerHTML = archiveHtml;
    } else {
      previewArea.innerHTML = `<span class="preview-placeholder">无法读取压缩包内容<br><small>仅支持 ZIP 格式</small></span>`;
    }
  } else if (textTypes.includes(ext)) {
    const content = await api.readFileText(entry.path);
    if (content !== null) {
      if (ext === 'md') {
        previewArea.innerHTML = `<div class="md-preview">${marked.parse(content)}</div>`;
        previewArea.querySelectorAll('.md-preview a').forEach(a => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            api.openExternal(a.href);
          });
        });
      } else if (ext === 'html' || ext === 'htm') {
        previewArea.innerHTML = `<iframe src="file:///${entry.path.replace(/\\/g, '/')}" style="width:100%;height:100%;border:none;border-radius:8px;background:white;" sandbox="allow-scripts allow-same-origin"></iframe>`;
      } else if (ext === 'bat' || ext === 'cmd' || ext === 'sh' || ext === 'ps1') {
        const highlighted = highlightScript(content, ext);
        previewArea.innerHTML = `<pre tabindex="0" class="code-preview">${highlighted}</pre>`;
      } else {
        const linked = linkifyText(escapeHtml(content));
        previewArea.innerHTML = `<pre tabindex="0">${linked}</pre>`;
        previewArea.querySelectorAll('a.text-link').forEach(a => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            api.openExternal(a.dataset.url);
          });
        });
      }
    } else {
      previewArea.innerHTML = `<span class="preview-placeholder">无法读取</span>`;
    }
  } else {
    previewArea.innerHTML = `<span class="preview-placeholder"><span style="font-size:32px;display:block;margin-bottom:8px;">${fileType.icon}</span>暂不支持预览<br><small>${fileType.label}</small></span>`;
  }
  } catch (e) {
    console.error('预览错误:', e);
    const previewArea = document.getElementById('previewArea');
    if (previewArea) {
      previewArea.innerHTML = `<span class="preview-placeholder" style="color:var(--danger);">预览出错<br><small>${e.message || e}</small></span>`;
    }
  }
}

function getFileTypeInfo(ext) {
  const icons = getFileIcon;
  const langMap = {
    py: { lang: 'Python', label: 'Python 源文件' },
    js: { lang: 'JavaScript', label: 'JavaScript 源文件' },
    ts: { lang: 'TypeScript', label: 'TypeScript 源文件' },
    jsx: { lang: 'React JSX', label: 'React 组件文件' },
    tsx: { lang: 'React TSX', label: 'React 组件文件' },
    java: { lang: 'Java', label: 'Java 源文件' },
    c: { lang: 'C', label: 'C 源文件' },
    cpp: { lang: 'C++', label: 'C++ 源文件' },
    h: { lang: 'C/C++ Header', label: 'C/C++ 头文件' },
    cs: { lang: 'C#', label: 'C# 源文件' },
    go: { lang: 'Go', label: 'Go 源文件' },
    rs: { lang: 'Rust', label: 'Rust 源文件' },
    rb: { lang: 'Ruby', label: 'Ruby 源文件' },
    php: { lang: 'PHP', label: 'PHP 源文件' },
    swift: { lang: 'Swift', label: 'Swift 源文件' },
    kt: { lang: 'Kotlin', label: 'Kotlin 源文件' },
    dart: { lang: 'Dart', label: 'Dart 源文件' },
    lua: { lang: 'Lua', label: 'Lua 脚本' },
    r: { lang: 'R', label: 'R 脚本' },
    html: { lang: 'HTML', label: 'HTML 网页文件' },
    htm: { lang: 'HTML', label: 'HTML 网页文件' },
    css: { lang: 'CSS', label: 'CSS 样式文件' },
    scss: { lang: 'SCSS', label: 'SCSS 样式文件' },
    less: { lang: 'Less', label: 'Less 样式文件' },
    vue: { lang: 'Vue', label: 'Vue 组件文件' },
    svelte: { lang: 'Svelte', label: 'Svelte 组件文件' },
    sh: { lang: 'Shell', label: 'Shell 脚本' },
    bat: { lang: 'Batch', label: 'Windows 批处理' },
    cmd: { lang: 'CMD', label: 'Windows 命令脚本' },
    ps1: { lang: 'PowerShell', label: 'PowerShell 脚本' },
    json: { lang: 'JSON', label: 'JSON 数据文件' },
    xml: { lang: 'XML', label: 'XML 数据文件' },
    yaml: { lang: 'YAML', label: 'YAML 配置文件' },
    yml: { lang: 'YAML', label: 'YAML 配置文件' },
    toml: { lang: 'TOML', label: 'TOML 配置文件' },
    sql: { lang: 'SQL', label: 'SQL 数据库脚本' },
    md: { lang: 'Markdown', label: 'Markdown 文档' },
    txt: { lang: null, label: '纯文本文件' },
    log: { lang: null, label: '日志文件' },
    csv: { lang: null, label: 'CSV 表格文件' },
    ini: { lang: null, label: 'INI 配置文件' },
    cfg: { lang: null, label: '配置文件' },
    conf: { lang: null, label: '配置文件' },
    gitignore: { lang: 'Git', label: 'Git 忽略规则' },
    dockerfile: { lang: 'Docker', label: 'Docker 构建文件' },
    makefile: { lang: 'Make', label: 'Make 构建文件' },
    png: { lang: null, label: 'PNG 图片' },
    jpg: { lang: null, label: 'JPEG 图片' },
    jpeg: { lang: null, label: 'JPEG 图片' },
    gif: { lang: null, label: 'GIF 图片' },
    bmp: { lang: null, label: 'BMP 图片' },
    webp: { lang: null, label: 'WebP 图片' },
    svg: { lang: null, label: 'SVG 矢量图' },
    ico: { lang: null, label: '图标文件' },
    tiff: { lang: null, label: 'TIFF 图片' },
    psd: { lang: null, label: 'Photoshop 文件' },
    ai: { lang: null, label: 'Illustrator 文件' },
    pdf: { lang: null, label: 'PDF 文档' },
    doc: { lang: null, label: 'Word 97-2003 文档' },
    docx: { lang: null, label: 'Word 文档' },
    xls: { lang: null, label: 'Excel 表格' },
    xlsx: { lang: null, label: 'Excel 表格' },
    ppt: { lang: null, label: 'PowerPoint 演示' },
    pptx: { lang: null, label: 'PowerPoint 演示' },
    zip: { lang: null, label: 'ZIP 压缩包' },
    rar: { lang: null, label: 'RAR 压缩包' },
    '7z': { lang: null, label: '7Z 压缩包' },
    tar: { lang: null, label: 'TAR 归档' },
    gz: { lang: null, label: 'GZIP 压缩包' },
    mp3: { lang: null, label: 'MP3 音频' },
    wav: { lang: null, label: 'WAV 音频' },
    flac: { lang: null, label: 'FLAC 音频' },
    aac: { lang: null, label: 'AAC 音频' },
    mp4: { lang: null, label: 'MP4 视频' },
    avi: { lang: null, label: 'AVI 视频' },
    mkv: { lang: null, label: 'MKV 视频' },
    mov: { lang: null, label: 'MOV 视频' },
    wmv: { lang: null, label: 'WMV 视频' },
    ttf: { lang: null, label: '字体文件' },
    otf: { lang: null, label: '字体文件' },
    woff: { lang: null, label: 'Web 字体' },
    woff2: { lang: null, label: 'Web 字体' },
    exe: { lang: null, label: '可执行文件' },
    msi: { lang: null, label: '安装程序' },
  };

  const info = langMap[ext] || { lang: null, label: `${ext.toUpperCase()} 文件` };
  return { icon: getFileIcon(ext), lang: info.lang, langLogo: info.lang ? getFileIcon(ext) : null, label: info.label };
}

async function saveMeta() {
  if (!currentFile) return;
  await api.saveMeta(currentFile.path, {
    tags: document.getElementById('tagsInput').value,
    notes: document.getElementById('notesInput').value
  });
  showToast('已保存', 'success');
  const dir = panels[activePanelIndex]?.currentDir;
  if (dir) await loadDir(dir, activePanelIndex);
}

function showFileListBgContextMenu(e) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = [
    { icon: '🔄', label: '刷新', action: () => { if (currentDir) loadDir(currentDir); } },
    { icon: '📂', label: '新建文件夹', action: () => createNewFolder() },
  ];

  if (clipboard && currentDir) {
    items.push({ sep: true });
    items.push({ icon: '📌', label: '粘贴到当前文件夹', action: () => pasteToFolder(currentDir) });
  }

  // 始终显示从资源管理器粘贴选项
  if (currentDir) {
    items.push({ sep: true });
    items.push({ icon: '📋', label: '从资源管理器粘贴', action: () => pasteFromSystemClipboard() });
    items.push({ icon: '🪟', label: '在资源管理器中打开', action: () => api.openPath(currentDir) });
  }

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = `ctx-menu-item ${item.cls || ''}`;
      btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(btn);
    }
  }

  positionMenu(menu, e);
  closeMenuOnClick(menu);
}

// === 多选操作 ===
function clearSelection(panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  p.selectedFiles.clear();
  p.lastClickedIndex = -1;
  const tbody = document.getElementById('fileTableBody' + panelIdx);
  if (tbody) tbody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
  updateBatchBar(panelIdx);
}

function updateBatchBar(panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const bar = document.querySelector(`.batch-bar[data-panel="${panelIdx}"]`);
  if (!bar) return;
  const p = panels[panelIdx];
  
  if (p.selectedFiles.size > 1) {
    bar.style.display = 'flex';
    bar.querySelector('.batch-count').textContent = `已选 ${p.selectedFiles.size} 项`;
  } else {
    bar.style.display = 'none';
  }
}

function switchPanelMode(mode) {
  panelMode = mode;
  
  // 更新按钮状态
  document.querySelectorAll('.panel-mode-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.mode) === mode);
  });

  const container = document.getElementById('panelsContainer');
  container.innerHTML = '';

  for (let i = 0; i < mode; i++) {
    if (!panels[i]) {
      panels[i] = {
        currentDir: panels[0] ? panels[0].currentDir : workspaceDir,
        fileList: [],
        selectedFiles: new Set(),
        lastClickedIndex: -1,
        sortBy: 'name',
        sortDir: 'asc',
        viewMode: 'list'
      };
    }

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.dataset.panel = i;
    panel.innerHTML = `
      <div class="panel-toolbar">
        <div class="breadcrumb" id="breadcrumb${i}"></div>
      </div>
      <div class="filter-bar" id="filterBar${i}">
        <button class="filter-view-btn active" data-view="list" id="viewList${i}" title="列表视图">☰</button>
        <button class="filter-view-btn" data-view="category" id="viewCategory${i}" title="分类视图">▦</button>
        <button class="filter-view-btn" data-view="kanban" id="viewKanban${i}" title="看板视图">◫</button>
        <select class="filter-select" id="filterType${i}">
          <option value="">全部类型</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="audio">音频</option>
          <option value="document">文档</option>
          <option value="code">代码</option>
          <option value="archive">压缩包</option>
        </select>
        <select class="filter-select" id="filterSize${i}">
          <option value="">全部大小</option>
          <option value="0-100k">小于 100KB</option>
          <option value="100k-1m">100KB - 1MB</option>
          <option value="1m-10m">1MB - 10MB</option>
          <option value="10m-100m">10MB - 100MB</option>
          <option value="100m+">大于 100MB</option>
        </select>
        <select class="filter-select" id="filterDate${i}">
          <option value="">全部时间</option>
          <option value="today">今天</option>
          <option value="week">最近一周</option>
          <option value="month">最近一月</option>
          <option value="year">最近一年</option>
        </select>
        <button class="filter-clear-btn" id="filterClear${i}" style="display:none;" title="清除筛选">✕</button>
      </div>
      <div class="file-table-container">
        <table class="file-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>标签</th>
              <th>大小</th>
              <th>修改时间</th>
            </tr>
          </thead>
          <tbody class="file-table-body" id="fileTableBody${i}"></tbody>
        </table>
      </div>
      <div class="batch-bar" data-panel="${i}" style="display:none">
        <span class="batch-count">已选 0 项</span>
        <button class="batch-btn" onclick="batchTag(${i})">🏷️ 打标签</button>
        <button class="batch-btn" onclick="batchRemoveTag(${i})">🏷️ 删标签</button>
        <button class="batch-btn" onclick="batchRemoveNotes(${i})">📝 删备注</button>
        <button class="batch-btn" onclick="batchRename(${i})">✏️ 重命名</button>
        <button class="batch-btn" onclick="batchMove(${i})">📁 移动</button>
        <button class="batch-btn batch-btn-danger" onclick="batchDelete(${i})">🗑️ 删除</button>
        <button class="batch-btn batch-btn-cancel" onclick="clearSelection(${i})">✕ 取消</button>
      </div>
    `;
    container.appendChild(panel);

    // 点击空白取消选择
    const tableContainer = panel.querySelector('.file-table-container');
    tableContainer.addEventListener('click', (e) => {
      if (!e.target.closest('tr')) clearSelection(i);
    });
    tableContainer.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('tr')) {
        e.preventDefault();
        showFileListBgContextMenu(e);
      }
    });

    // 拖到面板
    const panelIdx = i;
    tableContainer.addEventListener('mouseenter', () => {
      if (dragData && dragData.fromTree && panelIdx !== 0) {
        tableContainer.style.background = 'rgba(59,130,246,0.08)';
      }
    });
    tableContainer.addEventListener('mouseleave', () => {
      tableContainer.style.background = '';
    });
    tableContainer.addEventListener('mouseup', async (e) => {
      tableContainer.style.background = '';
      if (!dragData) return;
      if (e.button !== 0) return;

      // 目录树拖入：在该面板打开文件夹
      if (dragData.fromTree) {
        if (panelIdx === 0) return; // 主栏不处理，保持原有点击行为
        await loadDir(dragData.path, panelIdx);
        dragData = null;
        return;
      }

      // 文件拖入面板空白区域：移动/复制到当前目录
      if (e.target.closest('tr')) return;
      
      try {
        const dragItem = dragData;
        const dir = panels[panelIdx].currentDir;
        if (!dir) return;
        
        const fileName = dragItem.path.split(/[/\\]/).pop();
        const destPath = dir + '\\' + fileName;
        
        if (dragItem.isDir) {
          showToast('暂不支持操作文件夹', 'error');
          return;
        }
        
        const isCopy = dragCtrlDown;
        const success = isCopy
          ? await api.copyFile(dragItem.path, destPath)
          : await api.moveFile(dragItem.path, destPath);
        
        if (success) {
          showToast(`${isCopy ? '已复制' : '已移动'}: ${fileName}`, 'success');
          await loadDir(dir, panelIdx);
          if (dragItem.panelIdx !== undefined && dragItem.panelIdx !== panelIdx) {
            await loadDir(panels[dragItem.panelIdx].currentDir, dragItem.panelIdx);
          }
        } else {
          showToast(isCopy ? '复制失败' : '移动失败', 'error');
        }
      } catch (err) {
        showToast('操作失败', 'error');
      }
      dragData = null;
    });
  }

  // 加载每个面板的当前目录
  for (let i = 0; i < mode; i++) {
    initFilterBar(i);
    initCategoryViewBtn(i);
    const dir = panels[i].currentDir || workspaceDir;
    if (dir) loadDir(dir, i);
  }
}

async function batchDelete(panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  if (p.selectedFiles.size === 0) return;
  const count = p.selectedFiles.size;
  if (!confirm(`确定删除选中的 ${count} 个项目吗？`)) return;
  
  let deleted = 0;
  for (const filePath of p.selectedFiles) {
    const success = await api.deletePath(filePath);
    if (success) deleted++;
  }
  
  clearSelection(panelIdx);
  if (p.currentDir) await loadDir(p.currentDir, panelIdx);
  showToast(`已删除 ${deleted} 个项目`, 'success');
}

async function batchMove(panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  if (p.selectedFiles.size === 0) return;
  const targetDir = await api.selectDirectory('选择移动目标文件夹');
  if (!targetDir) return;
  
  let moved = 0;
  for (const filePath of p.selectedFiles) {
    const fileName = filePath.split(/[/\\]/).pop();
    const destPath = targetDir + '\\' + fileName;
    const success = await api.moveFile(filePath, destPath);
    if (success) moved++;
  }
  
  clearSelection(panelIdx);
  if (p.currentDir) await loadDir(p.currentDir, panelIdx);
  showToast(`已移动 ${moved} 个项目`, 'success');
}

async function batchTag(panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  if (p.selectedFiles.size === 0) return;
  
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '批量添加标签';
  document.getElementById('modalBody').innerHTML = `
    <div class="form-group">
      <label>标签（多个标签用逗号分隔）</label>
      <input type="text" id="batchTagInput" placeholder="例如：重要, 待处理">
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = '';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);
  
  const applyBtn = document.createElement('button');
  applyBtn.className = 'modal-btn primary';
  applyBtn.textContent = '应用';
  const idx = panelIdx;
  applyBtn.addEventListener('click', async () => {
    const tags = document.getElementById('batchTagInput').value.trim();
    if (!tags) { showToast('请输入标签', 'error'); return; }
    
    let tagged = 0;
    for (const filePath of panels[idx].selectedFiles) {
      const meta = await api.getMeta(filePath) || {};
      const existingTags = meta.tags ? meta.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      const newTags = tags.split(',').map(t => t.trim()).filter(Boolean);
      const merged = [...new Set([...existingTags, ...newTags])].join(', ');
      await api.saveMeta(filePath, { ...meta, tags: merged });
      tagged++;
    }
    
    closeModal();
    clearSelection(idx);
    if (panels[idx].currentDir) await loadDir(panels[idx].currentDir, idx);
    showToast(`已为 ${tagged} 个项目添加标签`, 'success');
  });
  
  document.getElementById('modalFooter').appendChild(cancelBtn);
  document.getElementById('modalFooter').appendChild(applyBtn);
  modal.classList.add('active');
}

async function batchRemoveTag(panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  if (p.selectedFiles.size === 0) return;

  // 收集所有现有标签
  const allTags = new Set();
  for (const filePath of p.selectedFiles) {
    const meta = await api.getMeta(filePath);
    if (meta && meta.tags) {
      meta.tags.split(',').map(t => t.trim()).filter(Boolean).forEach(t => allTags.add(t));
    }
  }

  if (allTags.size === 0) {
    showToast('选中的文件没有标签', 'info');
    return;
  }

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '批量删除标签';
  let tagsHtml = [...allTags].map(t => 
    `<label class="batch-tag-check" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;margin:2px;"><input type="checkbox" value="${escapeHtml(t)}" class="batch-tag-cb" style="cursor:pointer;"> ${escapeHtml(t)}</label>`
  ).join('');

  document.getElementById('modalBody').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div style="font-size:12px;color:var(--text-muted);">勾选要删除的标签</div>
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;"><input type="checkbox" id="batchTagSelectAll" style="cursor:pointer;"> 全选</label>
    </div>
    <div id="batchTagContainer" style="display:flex;flex-wrap:wrap;gap:4px;">${tagsHtml}</div>
  `;

  document.getElementById('batchTagSelectAll').addEventListener('change', (e) => {
    document.querySelectorAll('.batch-tag-cb').forEach(cb => { cb.checked = e.target.checked; });
  });
  document.getElementById('modalFooter').innerHTML = '';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);

  const applyBtn = document.createElement('button');
  applyBtn.className = 'modal-btn primary';
  applyBtn.textContent = '删除标签';
  applyBtn.style.borderColor = 'var(--danger)';
  applyBtn.style.color = 'var(--danger)';
  const idx = panelIdx;
  applyBtn.addEventListener('click', async () => {
    const toRemove = [...document.querySelectorAll('.batch-tag-cb:checked')].map(cb => cb.value);
    if (toRemove.length === 0) { showToast('请选择要删除的标签', 'error'); return; }

    let count = 0;
    for (const filePath of panels[idx].selectedFiles) {
      const meta = await api.getMeta(filePath) || {};
      if (!meta.tags) continue;
      let tags = meta.tags.split(',').map(t => t.trim()).filter(Boolean);
      tags = tags.filter(t => !toRemove.includes(t));
      await api.saveMeta(filePath, { ...meta, tags: tags.join(', ') });
      count++;
    }

    closeModal();
    clearSelection(idx);
    if (panels[idx].currentDir) await loadDir(panels[idx].currentDir, idx);
    showToast(`已从 ${count} 个项目删除标签`, 'success');
  });

  document.getElementById('modalFooter').appendChild(cancelBtn);
  document.getElementById('modalFooter').appendChild(applyBtn);
  modal.classList.add('active');
}

async function batchRemoveNotes(panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  if (p.selectedFiles.size === 0) return;

  const count = p.selectedFiles.size;
  if (!confirm(`确定删除选中的 ${count} 个文件的备注吗？`)) return;

  let removed = 0;
  for (const filePath of p.selectedFiles) {
    const meta = await api.getMeta(filePath) || {};
    if (meta.notes || meta.fileNote) {
      await api.saveMeta(filePath, { ...meta, notes: '', fileNote: '' });
      removed++;
    }
  }

  clearSelection(panelIdx);
  if (p.currentDir) await loadDir(p.currentDir, panelIdx);
  showToast(`已删除 ${removed} 个文件的备注`, 'success');
}

// === 快捷键系统 ===
const DEFAULT_SHORTCUTS = [
  { id: 'newFolder', label: '新建文件夹', key: 'ctrl+n', category: '文件' },
  { id: 'copy', label: '复制', key: 'ctrl+c', category: '文件' },
  { id: 'cut', label: '剪切', key: 'ctrl+x', category: '文件' },
  { id: 'paste', label: '粘贴', key: 'ctrl+v', category: '文件' },
  { id: 'selectAll', label: '全选', key: 'ctrl+a', category: '文件' },
  { id: 'rename', label: '重命名', key: 'f2', category: '文件' },
  { id: 'delete', label: '删除', key: 'delete', category: '文件' },
  { id: 'refresh', label: '刷新', key: 'f5', category: '文件' },
  { id: 'undo', label: '撤销', key: 'ctrl+z', category: '编辑' },
  { id: 'redo', label: '重做', key: 'ctrl+y', category: '编辑' },
  { id: 'goBack', label: '返回上一层', key: 'backspace', category: '导航' },
  { id: 'closePanel', label: '关闭详情面板', key: 'escape', category: '导航' },
  { id: 'openFile', label: '打开文件/进入文件夹', key: 'enter', category: '导航' },
];

// === 文件筛选 ===
const FILE_TYPE_MAP = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'tiff', 'psd'],
  video: ['mp4', 'webm', 'avi', 'mkv', 'mov', 'wmv'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'],
  code: ['py', 'js', 'ts', 'jsx', 'tsx', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'json', 'xml', 'yaml', 'sql', 'sh', 'bat'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz'],
};

function getFilterState(panelIdx) {
  try {
    return JSON.parse(localStorage.getItem('filter_' + panelIdx) || '{}');
  } catch (e) { return {}; }
}

function saveFilterState(panelIdx, state) {
  localStorage.setItem('filter_' + panelIdx, JSON.stringify(state));
}

function applyFilters(entries, panelIdx) {
  const state = getFilterState(panelIdx);
  let filtered = entries;

  if (state.type) {
    const exts = FILE_TYPE_MAP[state.type] || [];
    filtered = filtered.filter(e => e.isDir || exts.includes(e.name.split('.').pop().toLowerCase()));
  }

  if (state.size) {
    filtered = filtered.filter(e => {
      if (e.isDir) return true;
      const s = e.size || 0;
      switch (state.size) {
        case '0-100k': return s < 102400;
        case '100k-1m': return s >= 102400 && s < 1048576;
        case '1m-10m': return s >= 1048576 && s < 10485760;
        case '10m-100m': return s >= 10485760 && s < 104857600;
        case '100m+': return s >= 104857600;
        default: return true;
      }
    });
  }

  if (state.date) {
    const now = Date.now();
    filtered = filtered.filter(e => {
      if (e.isDir) return true;
      const t = new Date(e.modified).getTime();
      switch (state.date) {
        case 'today': return now - t < 86400000;
        case 'week': return now - t < 604800000;
        case 'month': return now - t < 2592000000;
        case 'year': return now - t < 31536000000;
        default: return true;
      }
    });
  }

  return filtered;
}

function initFilterBar(panelIdx) {
  const typeEl = document.getElementById('filterType' + panelIdx);
  const sizeEl = document.getElementById('filterSize' + panelIdx);
  const dateEl = document.getElementById('filterDate' + panelIdx);
  const clearEl = document.getElementById('filterClear' + panelIdx);
  if (!typeEl) return;

  const state = getFilterState(panelIdx);
  typeEl.value = state.type || '';
  sizeEl.value = state.size || '';
  dateEl.value = state.date || '';
  updateFilterClearBtn(panelIdx);

  typeEl.addEventListener('change', () => { saveFilterState(panelIdx, { ...getFilterState(panelIdx), type: typeEl.value }); reloadPanel(panelIdx); });
  sizeEl.addEventListener('change', () => { saveFilterState(panelIdx, { ...getFilterState(panelIdx), size: sizeEl.value }); reloadPanel(panelIdx); });
  dateEl.addEventListener('change', () => { saveFilterState(panelIdx, { ...getFilterState(panelIdx), date: dateEl.value }); reloadPanel(panelIdx); });
  clearEl.addEventListener('click', () => {
    localStorage.removeItem('filter_' + panelIdx);
    typeEl.value = ''; sizeEl.value = ''; dateEl.value = '';
    updateFilterClearBtn(panelIdx);
    reloadPanel(panelIdx);
  });
}

function updateFilterClearBtn(panelIdx) {
  const clearEl = document.getElementById('filterClear' + panelIdx);
  if (!clearEl) return;
  const state = getFilterState(panelIdx);
  clearEl.style.display = (state.type || state.size || state.date) ? 'block' : 'none';
}

function reloadPanel(panelIdx) {
  const p = panels[panelIdx];
  if (p && p.currentDir) loadDir(p.currentDir, panelIdx);
}

// === 分类视图 ===
function renderCategoryView(entries, panelIdx, tbody, dirPath) {
  const categories = {
    '📁 文件夹': entries.filter(e => e.isDir),
    '🖼️ 图片': entries.filter(e => !e.isDir && FILE_TYPE_MAP.image.includes(e.name.split('.').pop().toLowerCase())),
    '🎬 视频': entries.filter(e => !e.isDir && FILE_TYPE_MAP.video.includes(e.name.split('.').pop().toLowerCase())),
    '🎵 音频': entries.filter(e => !e.isDir && FILE_TYPE_MAP.audio.includes(e.name.split('.').pop().toLowerCase())),
    '📄 文档': entries.filter(e => !e.isDir && FILE_TYPE_MAP.document.includes(e.name.split('.').pop().toLowerCase())),
    '💻 代码': entries.filter(e => !e.isDir && FILE_TYPE_MAP.code.includes(e.name.split('.').pop().toLowerCase())),
    '📦 压缩包': entries.filter(e => !e.isDir && FILE_TYPE_MAP.archive.includes(e.name.split('.').pop().toLowerCase())),
    '📎 其他': entries.filter(e => !e.isDir && !Object.values(FILE_TYPE_MAP).flat().includes(e.name.split('.').pop().toLowerCase())),
  };

  for (const [label, items] of Object.entries(categories)) {
    if (items.length === 0) continue;

    const header = document.createElement('tr');
    header.className = 'category-header';
    header.innerHTML = `<td colspan="4"><span class="category-label">${label}</span><span class="category-count">${items.length}</span></td>`;
    tbody.appendChild(header);

    const catBody = document.createElement('tbody');
    catBody.className = 'category-body';
    tbody.appendChild(catBody);

    for (const entry of items) {
      appendFileRow(entry, catBody, panelIdx, dirPath);
    }
  }
}

function appendFileRow(entry, tbody, panelIdx, dirPath) {
  const ext = entry.name.split('.').pop().toLowerCase();
  const icon = entry.isDir ? '📂' : getFileIcon(ext);
  const sizeStr = entry.isDir ? '-' : formatSize(entry.size);
  const dateStr = formatDate(entry.modified);
  const p = panels[panelIdx];
  const idx = panelIdx;

  const tr = document.createElement('tr');
  tr.dataset.path = entry.path;
  tr.dataset.isDir = entry.isDir;
  tr.innerHTML = `
    <td><div class="file-name"><span class="file-icon">${icon}</span><span>${entry.name}</span></div></td>
    <td></td>
    <td>${sizeStr}</td>
    <td>${dateStr}</td>
  `;

  tr.addEventListener('click', (e) => {
    const currentIndex = [...tbody.querySelectorAll('tr')].indexOf(tr);
    if (e.ctrlKey || e.metaKey) {
      if (p.selectedFiles.has(entry.path)) { p.selectedFiles.delete(entry.path); tr.classList.remove('selected'); }
      else { p.selectedFiles.add(entry.path); tr.classList.add('selected'); }
    } else {
      clearSelection(idx);
      p.selectedFiles.add(entry.path);
      tr.classList.add('selected');
      if (!entry.isDir) openFileDetail(entry);
    }
    p.lastClickedIndex = currentIndex;
    updateBatchBar(idx);
  });

  tr.addEventListener('dblclick', () => {
    if (entry.isDir) loadDir(entry.path, idx);
    else { addRecentFile(entry.path); api.openPath(entry.path); }
  });

  tbody.appendChild(tr);
}

function initCategoryViewBtn(panelIdx) {
  const listBtn = document.getElementById('viewList' + panelIdx);
  const catBtn = document.getElementById('viewCategory' + panelIdx);
  const kanbanBtn = document.getElementById('viewKanban' + panelIdx);
  if (!listBtn) return;

  const p = panels[panelIdx];
  const allBtns = [listBtn, catBtn, kanbanBtn].filter(Boolean);

  function updateActive(mode) {
    allBtns.forEach(b => b.classList.remove('active'));
    if (mode === 'list') listBtn.classList.add('active');
    else if (mode === 'category' && catBtn) catBtn.classList.add('active');
    else if (mode === 'kanban' && kanbanBtn) kanbanBtn.classList.add('active');
  }

  updateActive(p.viewMode || 'list');

  listBtn.addEventListener('click', () => { p.viewMode = 'list'; updateActive('list'); if (p.currentDir) loadDir(p.currentDir, panelIdx); });
  if (catBtn) catBtn.addEventListener('click', () => { p.viewMode = 'category'; updateActive('category'); if (p.currentDir) loadDir(p.currentDir, panelIdx); });
  if (kanbanBtn) kanbanBtn.addEventListener('click', () => { p.viewMode = 'kanban'; updateActive('kanban'); if (p.currentDir) loadDir(p.currentDir, panelIdx); });
}

// === 看板视图 ===
function renderKanbanView(entries, panelIdx, tbody, dirPath) {
  const p = panels[panelIdx];
  
  // 收集所有标签
  const tagMap = new Map(); // tag -> [entries]
  const noTag = [];
  
  for (const entry of entries) {
    if (entry.isDir) { noTag.push(entry); continue; }
    let hasTag = false;
    try {
      // 同步获取缓存的 meta
      const meta = getMetaSync(entry.path);
      if (meta && meta.tags) {
        const tags = meta.tags.split(',').map(t => t.trim()).filter(Boolean);
        for (const tag of tags) {
          if (!tagMap.has(tag)) tagMap.set(tag, []);
          tagMap.get(tag).push(entry);
        }
        hasTag = true;
      }
    } catch (e) {}
    if (!hasTag) noTag.push(entry);
  }

  // 构建看板
  const container = document.createElement('div');
  container.className = 'kanban-container';
  container.style.cssText = 'display:flex;gap:12px;padding:12px;overflow-x:auto;height:100%;';

  // 无标签列（始终显示）
  const noTagColumn = createKanbanColumn('无标签', noTag, panelIdx, dirPath, '#64748b');
  container.appendChild(noTagColumn);

  // 按标签分组列
  const sortedTags = [...tagMap.entries()].sort((a, b) => b[1].length - a[1].length);
  const TAG_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#ef4444', '#a855f7', '#ec4899', '#eab308', '#06b6d4'];
  for (let i = 0; i < sortedTags.length; i++) {
    const [tag, items] = sortedTags[i];
    const color = TAG_COLORS[i % TAG_COLORS.length];
    const column = createKanbanColumn(tag, items, panelIdx, dirPath, color);
    container.appendChild(column);
  }

  // 用 tr 包裹看板容器
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 4;
  td.style.padding = '0';
  td.style.height = '100%';
  td.style.verticalAlign = 'top';
  td.appendChild(container);
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function createKanbanColumn(tagName, items, panelIdx, dirPath, color) {
  const column = document.createElement('div');
  column.className = 'kanban-column';
  column.style.cssText = 'min-width:200px;max-width:250px;flex:1;background:var(--bg-secondary);border-radius:10px;display:flex;flex-direction:column;border:1px solid var(--border);';

  const header = document.createElement('div');
  header.className = 'kanban-header';
  header.style.cssText = `padding:8px 12px;font-size:12px;font-weight:600;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px;border-top:3px solid ${color};border-radius:10px 10px 0 0;`;
  header.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${color};"></span>${escapeHtml(tagName)}<span style="margin-left:auto;font-size:11px;color:var(--text-muted);">${items.length}</span>`;
  column.appendChild(header);

  const list = document.createElement('div');
  list.className = 'kanban-list';
  list.style.cssText = 'flex:1;overflow-y:auto;padding:8px;min-height:60px;';
  list.dataset.tag = tagName;

  for (const entry of items) {
    const card = createKanbanCard(entry, panelIdx, tagName);
    list.appendChild(card);
  }

  // 拖入放下
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    list.style.background = 'rgba(59,130,246,0.08)';
  });
  list.addEventListener('dragleave', () => {
    list.style.background = '';
  });
  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.style.background = '';
    const filePath = e.dataTransfer.getData('text/plain');
    if (!filePath) return;

    // 更新标签
    try {
      const meta = await api.getMeta(filePath) || {};
      let tags = meta.tags ? meta.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      
      // 从旧标签中移除
      tags = tags.filter(t => t !== dragData?.fromTag);
      // 添加新标签（如果不是"无标签"）
      if (tagName !== '无标签' && !tags.includes(tagName)) {
        tags.push(tagName);
      }
      
      await api.saveMeta(filePath, { ...meta, tags: tags.join(', ') });
      showToast('标签已更新', 'success');
      if (dirPath) loadDir(dirPath, panelIdx);
    } catch (err) {
      showToast('操作失败', 'error');
    }
  });

  column.appendChild(list);
  return column;
}

function createKanbanCard(entry, panelIdx, fromTag) {
  const ext = entry.name.split('.').pop().toLowerCase();
  const icon = getFileIcon(ext);
  const card = document.createElement('div');
  card.className = 'kanban-card';
  card.style.cssText = 'padding:8px 10px;margin-bottom:6px;background:var(--bg-tertiary);border-radius:8px;cursor:pointer;font-size:12px;border:1px solid transparent;transition:border-color 0.2s;';
  card.draggable = true;
  card.dataset.path = entry.path;

  card.innerHTML = `<div style="display:flex;align-items:center;gap:6px;"><span style="font-size:16px;">${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span></div><div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${formatSize(entry.size || 0)} · ${formatDate(entry.modified)}</div>`;

  card.addEventListener('click', () => openFileDetail(entry));
  card.addEventListener('dblclick', () => { addRecentFile(entry.path); api.openPath(entry.path); });

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', entry.path);
    e.dataTransfer.effectAllowed = 'move';
    dragData = { path: entry.path, fromTag };
    card.style.opacity = '0.4';
  });
  card.addEventListener('dragend', () => {
    card.style.opacity = '1';
    dragData = null;
  });

  card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)'; });
  card.addEventListener('mouseleave', () => { card.style.borderColor = 'transparent'; });

  return card;
}

// meta 同步缓存（看板视图用）
const _metaCache = new Map();
function getMetaSync(filePath) {
  // 返回缓存或空对象，实际数据异步加载后刷新
  return _metaCache.get(filePath) || null;
}

// === 最近文件 ===
const MAX_RECENT = 10;

function getRecentFiles() {
  try {
    return JSON.parse(localStorage.getItem('recentFiles') || '[]');
  } catch (e) { return []; }
}

function addRecentFile(filePath) {
  let recent = getRecentFiles();
  recent = recent.filter(f => f.path !== filePath);
  recent.unshift({ path: filePath, name: filePath.split(/[/\\]/).pop(), time: Date.now() });
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  localStorage.setItem('recentFiles', JSON.stringify(recent));
  renderRecentFiles();
}

function clearRecentFiles() {
  localStorage.removeItem('recentFiles');
  renderRecentFiles();
}

function renderRecentFiles() {
  const section = document.getElementById('recentFilesSection');
  const list = document.getElementById('recentFilesList');
  if (!section || !list) return;

  const recent = getRecentFiles();
  if (recent.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = '';

  for (const file of recent) {
    const item = document.createElement('div');
    item.className = 'recent-file-item';
    const ext = file.name.split('.').pop().toLowerCase();
    const icon = getFileIcon(ext);
    item.innerHTML = `<span style="font-size:14px;">${icon}</span><span class="recent-file-name">${escapeHtml(file.name)}</span>`;
    item.addEventListener('click', () => {
      const dir = file.path.replace(/[/\\][^/\\]+$/, '');
      loadDir(dir, 0);
      highlightTreeNode(dir);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = document.createElement('div');
      menu.className = 'context-menu';
      const items = [
        { icon: '📂', label: '打开所在文件夹', action: () => { const dir = file.path.replace(/[/\\][^/\\]+$/, ''); loadDir(dir, 0); highlightTreeNode(dir); } },
        { icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(file.path); showToast('路径已复制', 'success'); } },
        { icon: '🗑️', label: '从列表移除', action: () => { let r = getRecentFiles(); r = r.filter(f => f.path !== file.path); localStorage.setItem('recentFiles', JSON.stringify(r)); renderRecentFiles(); } },
      ];
      for (const item of items) {
        const btn = document.createElement('button');
        btn.className = 'ctx-menu-item';
        btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
        btn.addEventListener('click', () => { menu.remove(); item.action(); });
        menu.appendChild(btn);
      }
      positionMenu(menu, e);
      closeMenuOnClick(menu);
    });
    list.appendChild(item);
  }
}

// === 收藏夹 ===
function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem('favorites') || '[]');
  } catch (e) { return []; }
}

function addFavorite(dirPath) {
  const favs = getFavorites();
  if (favs.some(f => f.path === dirPath)) { showToast('已在收藏夹中', 'info'); return; }
  favs.push({ path: dirPath, name: dirPath.split(/[/\\]/).pop() });
  localStorage.setItem('favorites', JSON.stringify(favs));
  renderFavorites();
  showToast('已添加到收藏夹', 'success');
}

function removeFavorite(dirPath) {
  let favs = getFavorites();
  favs = favs.filter(f => f.path !== dirPath);
  localStorage.setItem('favorites', JSON.stringify(favs));
  renderFavorites();
}

function isFavorite(dirPath) {
  return getFavorites().some(f => f.path === dirPath);
}

function renderFavorites() {
  const section = document.getElementById('favoritesSection');
  const list = document.getElementById('favoritesList');
  if (!section || !list) return;

  const favs = getFavorites();
  if (favs.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = '';

  for (const fav of favs) {
    const item = document.createElement('div');
    item.className = 'recent-file-item';
    item.innerHTML = `<span style="font-size:14px;">📁</span><span class="recent-file-name">${escapeHtml(fav.name)}</span><span class="fav-remove-btn" title="取消收藏">✕</span>`;
    item.querySelector('.fav-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFavorite(fav.path);
    });
    item.addEventListener('click', () => {
      loadDir(fav.path, 0);
      highlightTreeNode(fav.path);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = document.createElement('div');
      menu.className = 'context-menu';
      const items = [
        { icon: '📂', label: '打开', action: () => { loadDir(fav.path, 0); highlightTreeNode(fav.path); } },
        { icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(fav.path); showToast('路径已复制', 'success'); } },
        { icon: '🗑️', label: '取消收藏', action: () => removeFavorite(fav.path) },
      ];
      for (const mi of items) {
        const btn = document.createElement('button');
        btn.className = 'ctx-menu-item';
        btn.innerHTML = `<span>${mi.icon}</span><span>${mi.label}</span>`;
        btn.addEventListener('click', () => { menu.remove(); mi.action(); });
        menu.appendChild(btn);
      }
      positionMenu(menu, e);
      closeMenuOnClick(menu);
    });
    list.appendChild(item);
  }
}

// === 自定义排序 ===
function getCustomOrder(dirPath) {
  try {
    const saved = localStorage.getItem('customOrder_' + dirPath);
    return saved ? JSON.parse(saved) : [];
  } catch (e) { return []; }
}

function saveCustomOrder(dirPath, order) {
  localStorage.setItem('customOrder_' + dirPath, JSON.stringify(order));
}

function getShortcuts() {
  try {
    const saved = localStorage.getItem('shortcuts');
    if (saved) {
      const parsed = JSON.parse(saved);
      // 合并默认和自定义
      return DEFAULT_SHORTCUTS.map(d => {
        const s = parsed.find(p => p.id === d.id);
        return s ? { ...d, key: s.key } : d;
      });
    }
  } catch (e) {}
  return [...DEFAULT_SHORTCUTS];
}

function formatKey(key) {
  return key.split('+').map(k => {
    const map = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Meta', f2: 'F2', f5: 'F5', delete: 'Del', backspace: '⌫', escape: 'Esc', enter: '↵' };
    return map[k.toLowerCase()] || k.toUpperCase();
  }).join(' + ');
}

function matchShortcut(e, shortcutKey) {
  const parts = shortcutKey.toLowerCase().split('+');
  const needCtrl = parts.includes('ctrl');
  const needShift = parts.includes('shift');
  const needAlt = parts.includes('alt');
  const mainKey = parts.filter(p => !['ctrl', 'shift', 'alt'].includes(p))[0];
  
  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;
  
  const keyMap = { delete: 'delete', backspace: 'backspace', escape: 'escape', enter: 'enter', f2: 'f2', f5: 'f5' };
  const targetKey = keyMap[mainKey] || mainKey;
  return e.key.toLowerCase() === targetKey;
}

function showShortcutSettings() {
  const shortcuts = getShortcuts();
  const categories = [...new Set(shortcuts.map(s => s.category))];
  
  let html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">点击快捷键可修改，按 Esc 取消录入</div>';
  
  for (const cat of categories) {
    html += `<div class="settings-group"><div class="settings-group-title">${cat}</div>`;
    for (const s of shortcuts.filter(sc => sc.category === cat)) {
      html += `
        <div class="settings-row" style="justify-content:space-between;">
          <label>${s.label}</label>
          <button class="shortcut-key-btn" data-id="${s.id}" style="min-width:80px;padding:4px 10px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;font-family:monospace;font-size:12px;cursor:pointer;text-align:center;">${formatKey(s.key)}</button>
        </div>`;
    }
    html += '</div>';
  }
  
  html += `<div style="margin-top:8px;text-align:center;"><button class="modal-btn secondary" id="resetShortcutsBtn" style="font-size:11px;">恢复默认</button></div>`;

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '快捷键设置';
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('modalFooter').innerHTML = '';

  let listeningBtn = null;

  document.getElementById('modalBody').addEventListener('click', (e) => {
    const btn = e.target.closest('.shortcut-key-btn');
    if (!btn) return;
    
    if (listeningBtn) {
      listeningBtn.textContent = listeningBtn.dataset.current;
      listeningBtn.style.borderColor = 'var(--border)';
    }
    
    btn.dataset.current = btn.textContent;
    btn.textContent = '按下快捷键...';
    btn.style.borderColor = 'var(--accent)';
    listeningBtn = btn;
    shortcutListening = true;
  });

  const keyHandler = (e) => {
    if (!listeningBtn) return;
    e.preventDefault();
    e.stopPropagation();
    
    if (e.key === 'Escape') {
      listeningBtn.textContent = listeningBtn.dataset.current;
      listeningBtn.style.borderColor = 'var(--border)';
      listeningBtn = null;
      shortcutListening = false;
      return;
    }
    
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    const mainKey = e.key.toLowerCase();
    const isModifier = ['control', 'shift', 'alt', 'meta'].includes(mainKey);
    
    // 只按了修饰键，显示当前组合但不确认
    if (isModifier) {
      if (parts.length > 0) {
        listeningBtn.textContent = formatKey(parts.join('+')) + ' + ...';
      }
      return;
    }
    
    parts.push(mainKey);
    const newKey = parts.join('+');
    listeningBtn.textContent = formatKey(newKey);
    listeningBtn.style.borderColor = 'var(--border)';
    listeningBtn.dataset.newKey = newKey;
    listeningBtn = null;
    shortcutListening = false;
  };

  document.addEventListener('keydown', keyHandler, true);

  document.getElementById('resetShortcutsBtn').addEventListener('click', () => {
    localStorage.removeItem('shortcuts');
    document.removeEventListener('keydown', keyHandler, true);
    showToast('已恢复默认快捷键', 'success');
    showShortcutSettings();
  });

  const backBtn = document.createElement('button');
  backBtn.className = 'modal-btn secondary';
  backBtn.textContent = '← 返回';
  backBtn.addEventListener('click', () => {
    shortcutListening = false;
    document.removeEventListener('keydown', keyHandler, true);
    showSettings();
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'modal-btn primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => {
    const updates = {};
    document.querySelectorAll('.shortcut-key-btn[data-new-key]').forEach(btn => {
      updates[btn.dataset.id] = btn.dataset.newKey;
    });
    
    if (Object.keys(updates).length > 0) {
      const shortcuts = getShortcuts().map(s => updates[s.id] ? { ...s, key: updates[s.id] } : s);
      localStorage.setItem('shortcuts', JSON.stringify(shortcuts));
      showToast('快捷键已保存', 'success');
    }
    shortcutListening = false;
    document.removeEventListener('keydown', keyHandler, true);
    closeModal();
  });

  document.getElementById('modalFooter').appendChild(backBtn);
  document.getElementById('modalFooter').appendChild(saveBtn);
  modal.classList.add('active');
}

// === 重复文件检测 ===
async function showDuplicates() {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '重复文件检测';
  document.getElementById('modalBody').innerHTML = `
    <div style="text-align:center;padding:20px;">
      <div style="font-size:32px;margin-bottom:12px;">🔍</div>
      <div style="color:var(--text-muted);margin-bottom:16px;">正在扫描当前工作目录...</div>
      <div class="spinner" style="width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto;"></div>
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = '';
  modal.classList.add('active');

  const dir = workspaceDir;
  if (!dir) { document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">未设置工作目录</div>'; return; }

  const duplicates = await api.findDuplicates(dir);
  
  if (duplicates.length === 0) {
    document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:20px;"><div style="font-size:32px;margin-bottom:12px;">✅</div><div style="color:var(--text-muted);">未发现重复文件</div></div>';
    return;
  }

  const totalWaste = duplicates.reduce((sum, d) => sum + d.size * (d.files.length - 1), 0);
  
  let html = `
    <div style="margin-bottom:12px;padding:8px 12px;background:var(--bg-tertiary);border-radius:8px;font-size:12px;">
      发现 <strong>${duplicates.length}</strong> 组重复文件，共浪费 <strong>${formatSize(totalWaste)}</strong> 空间
    </div>
    <div style="max-height:400px;overflow-y:auto;">
  `;

  for (let i = 0; i < duplicates.length; i++) {
    const d = duplicates[i];
    html += `
      <div class="dup-group" style="margin-bottom:8px;border:1px solid var(--border);border-radius:8px;overflow:hidden;">
        <div style="padding:6px 10px;background:var(--bg-tertiary);font-size:11px;color:var(--text-muted);">
          ${d.files[0].name} · ${formatSize(d.size)} · ${d.files.length} 个副本
        </div>
    `;
    for (let j = 0; j < d.files.length; j++) {
      const f = d.files[j];
      const isKeep = j === 0;
      html += `
        <div class="dup-file" style="display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:11px;${isKeep ? 'color:var(--success);' : ''}">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
          ${isKeep
            ? '<span style="font-size:10px;color:var(--success);">保留</span>'
            : `<button class="dup-open-btn" data-path="${escapeHtml(f.path)}" style="padding:2px 6px;border:1px solid var(--border);background:var(--bg-tertiary);border-radius:4px;cursor:pointer;font-size:10px;">打开</button><button class="dup-del-btn" data-path="${escapeHtml(f.path)}" style="padding:2px 6px;border:1px solid var(--danger);color:var(--danger);background:transparent;border-radius:4px;cursor:pointer;font-size:10px;">删除</button>`
          }
        </div>`;
    }
    html += '</div>';
  }
  html += '</div>';

  document.getElementById('modalBody').innerHTML = html;

  document.getElementById('modalBody').addEventListener('click', async (e) => {
    const openBtn = e.target.closest('.dup-open-btn');
    if (openBtn) { api.openPath(openBtn.dataset.path); return; }
    
    const delBtn = e.target.closest('.dup-del-btn');
    if (delBtn) {
      if (confirm('确定删除该重复文件？（将移入回收站）')) {
        const ok = await api.deletePath(delBtn.dataset.path);
        if (ok) {
          const row = delBtn.closest('.dup-file');
          if (row) { row.style.opacity = '0.3'; row.style.textDecoration = 'line-through'; delBtn.remove(); row.querySelector('.dup-open-btn')?.remove(); }
          showToast('已删除', 'success');
        }
      }
    }
  });

  const deleteAllBtn = document.createElement('button');
  deleteAllBtn.className = 'modal-btn secondary';
  deleteAllBtn.textContent = '清除全部重复';
  deleteAllBtn.style.borderColor = 'var(--danger)';
  deleteAllBtn.style.color = 'var(--danger)';
  deleteAllBtn.addEventListener('click', async () => {
    if (!confirm('确定删除所有重复文件？每组仅保留第一个文件。此操作不可撤销！')) return;
    let deleted = 0;
    for (const d of duplicates) {
      for (let j = 1; j < d.files.length; j++) {
        const ok = await api.deletePath(d.files[j].path);
        if (ok) deleted++;
      }
    }
    showToast(`已删除 ${deleted} 个重复文件`, 'success');
    closeModal();
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-btn secondary';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', closeModal);
  document.getElementById('modalFooter').appendChild(deleteAllBtn);
  document.getElementById('modalFooter').appendChild(closeBtn);
}

// === 远程挂载 ===
async function showRemoteMount() {
  const mounts = await api.listMounts();
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '挂载远程目录';

  let mountsHtml = '';
  if (mounts.length > 0) {
    mountsHtml = '<div style="margin-bottom:12px;"><div style="font-size:12px;font-weight:600;margin-bottom:6px;">已挂载</div>';
    for (const m of mounts) {
      mountsHtml += `<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:var(--bg-tertiary);border-radius:6px;margin-bottom:4px;font-size:12px;"><span style="font-weight:600;">${m.letter}:</span><span style="flex:1;color:var(--text-muted);">\\\\${m.path}</span><button class="mount-unmount-btn" data-letter="${m.letter}" style="padding:2px 8px;border:1px solid var(--danger);color:var(--danger);background:transparent;border-radius:4px;cursor:pointer;font-size:11px;">卸载</button></div>`;
    }
    mountsHtml += '</div>';
  }

  document.getElementById('modalBody').innerHTML = `
    ${mountsHtml}
    <div class="form-group">
      <label>类型</label>
      <select id="remoteType" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text-primary);">
        <option value="smb">SMB / 网络共享</option>
        <option value="webdav">WebDAV</option>
      </select>
    </div>
    <div class="form-group">
      <label>服务器地址</label>
      <input type="text" id="remoteHost" placeholder="例如: 192.168.1.100 或 nas.local">
    </div>
    <div class="form-group" id="shareGroup">
      <label>共享名称</label>
      <input type="text" id="remoteShare" placeholder="例如: documents">
    </div>
    <div class="form-group">
      <label>盘符（可选）</label>
      <input type="text" id="remoteDrive" placeholder="Z" maxlength="1" style="width:60px;text-transform:uppercase;">
    </div>
    <div class="form-group">
      <label>用户名（可选）</label>
      <input type="text" id="remoteUser" placeholder="留空则使用当前账户">
    </div>
    <div class="form-group">
      <label>密码（可选）</label>
      <input type="password" id="remotePass" placeholder="留空则无密码">
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = '';

  // 类型切换时更新提示
  document.getElementById('remoteType').addEventListener('change', (e) => {
    const host = document.getElementById('remoteHost');
    const share = document.getElementById('shareGroup');
    if (e.target.value === 'webdav') {
      host.placeholder = '例如: https://dav.example.com/remote.php/dav/files/user/';
      share.style.display = 'none';
    } else {
      host.placeholder = '例如: 192.168.1.100 或 nas.local';
      share.style.display = '';
    }
  });

  // 卸载按钮
  document.querySelectorAll('.mount-unmount-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const result = await api.unmountRemote(btn.dataset.letter);
      if (result.success) {
        showToast(`已卸载 ${btn.dataset.letter}:`, 'success');
        showRemoteMount();
      } else {
        showToast('卸载失败: ' + result.error, 'error');
      }
    });
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);

  const mountBtn = document.createElement('button');
  mountBtn.className = 'modal-btn primary';
  mountBtn.textContent = '挂载';
  mountBtn.addEventListener('click', async () => {
    const type = document.getElementById('remoteType').value;
    const host = document.getElementById('remoteHost').value.trim();
    const share = document.getElementById('remoteShare').value.trim();
    const driveLetter = document.getElementById('remoteDrive').value.trim().toUpperCase();
    const user = document.getElementById('remoteUser').value.trim();
    const password = document.getElementById('remotePass').value;

    if (!host) { showToast('请输入服务器地址', 'error'); return; }
    if (type === 'smb' && !share) { showToast('请输入共享名称', 'error'); return; }

    mountBtn.textContent = '挂载中...';
    mountBtn.disabled = true;

    const result = await api.mountRemote({ type, host, share, user, password, driveLetter });

    if (result.success) {
      showToast(`已挂载到 ${result.path}`, 'success');
      // 添加为工作目录
      const ws = await api.addWorkspacePath(result.path);
      if (ws) {
        workspaces = await api.getWorkspaces();
        await buildTree();
      }
      await loadDir(result.path, 0);
      closeModal();
    } else {
      showToast('挂载失败: ' + result.error, 'error');
      mountBtn.textContent = '挂载';
      mountBtn.disabled = false;
    }
  });

  document.getElementById('modalFooter').appendChild(cancelBtn);
  document.getElementById('modalFooter').appendChild(mountBtn);
  modal.classList.add('active');
}

// === EXIF 自动打标签 ===
async function autoTagByExif() {
  const dir = panels[0]?.currentDir || workspaceDir;
  if (!dir) { showToast('请先打开一个目录', 'error'); return; }

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = 'EXIF 自动打标签';
  document.getElementById('modalBody').innerHTML = `
    <div style="text-align:center;padding:20px;">
      <div style="font-size:32px;margin-bottom:12px;">📷</div>
      <div style="color:var(--text-muted);margin-bottom:16px;">正在扫描图片 EXIF 信息...</div>
      <div class="spinner" style="width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto;"></div>
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = '';
  modal.classList.add('active');

  const imageExts = ['jpg', 'jpeg', 'png', 'tiff', 'webp'];
  const entries = await api.readDir(dir);
  const images = entries.filter(e => !e.isDir && imageExts.includes(e.name.split('.').pop().toLowerCase()));

  if (images.length === 0) {
    document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">当前目录没有图片文件</div>';
    return;
  }

  const results = { tagged: 0, skipped: 0, errors: 0, tags: {} };

  for (const img of images) {
    try {
      const exif = await api.readExif(img.path);
      if (!exif) { results.skipped++; continue; }

      const meta = await api.getMeta(img.path);
      let tags = meta.tags ? meta.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

      // 自动打标签
      const newTags = [];
      if (exif.拍摄时间) {
        const date = new Date(exif.拍摄时间);
        const ym = `拍摄时间:${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
        if (!tags.includes(ym)) newTags.push(ym);
      }
      if (exif.设备 && !tags.includes(exif.设备)) newTags.push(exif.设备);
      if (exif.镜头 && !tags.includes(exif.镜头)) newTags.push(exif.镜头);
      if (exif.焦距 && !tags.includes(exif.焦距)) newTags.push(exif.焦距);
      if (exif.光圈 && !tags.includes(exif.光圈)) newTags.push(exif.光圈);
      if (exif.位置 && !tags.includes('GPS')) newTags.push('GPS');

      if (newTags.length > 0) {
        tags = [...tags, ...newTags];
        await api.saveMeta(img.path, { ...meta, tags: tags.join(', ') });
        results.tagged++;
        newTags.forEach(t => { results.tags[t] = (results.tags[t] || 0) + 1; });
      } else {
        results.skipped++;
      }
    } catch (e) {
      results.errors++;
    }
  }

  // 显示结果
  let html = `
    <div style="padding:10px;">
      <div style="display:flex;gap:16px;margin-bottom:16px;font-size:13px;">
        <div style="text-align:center;"><div style="font-size:24px;font-weight:700;color:var(--success);">${results.tagged}</div><div style="color:var(--text-muted);">已打标签</div></div>
        <div style="text-align:center;"><div style="font-size:24px;font-weight:700;color:var(--text-muted);">${results.skipped}</div><div style="color:var(--text-muted);">跳过</div></div>
        <div style="text-align:center;"><div style="font-size:24px;font-weight:700;color:var(--danger);">${results.errors}</div><div style="color:var(--text-muted);">失败</div></div>
      </div>
  `;

  const tagEntries = Object.entries(results.tags).sort((a, b) => b[1] - a[1]);
  if (tagEntries.length > 0) {
    html += '<div style="font-size:12px;font-weight:600;margin-bottom:6px;">新增标签</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
    for (const [tag, count] of tagEntries) {
      html += `<span style="padding:3px 10px;background:var(--bg-tertiary);border-radius:12px;font-size:12px;">${escapeHtml(tag)} <span style="color:var(--text-muted);">×${count}</span></span>`;
    }
    html += '</div>';
  }

  html += '</div>';
  document.getElementById('modalBody').innerHTML = html;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-btn secondary';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', () => { closeModal(); loadDir(dir, 0); });
  document.getElementById('modalFooter').appendChild(closeBtn);
}

// === 文件统计 ===
async function showStats() {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '文件统计';
  document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">正在统计...</div>';
  document.getElementById('modalFooter').innerHTML = '';
  modal.classList.add('active');

  const dir = panels[activePanelIndex]?.currentDir || workspaceDir;
  if (!dir) { document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">未设置工作目录</div>'; return; }

  const typeStats = await api.getTypeStats(dir);
  const entries = Object.entries(typeStats).sort((a, b) => b[1].count - a[1].count);
  const totalFiles = entries.reduce((s, e) => s + e[1].count, 0);
  const totalSize = entries.reduce((s, e) => s + e[1].size, 0);

  const TYPE_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#ef4444', '#a855f7', '#ec4899', '#eab308', '#06b6d4', '#84cc16', '#f43f5e', '#6366f1', '#14b8a6', '#fb923c', '#8b5cf6', '#d946ef', '#0ea5e9', '#10b981', '#f59e0b', '#64748b', '#78716c'];
  const CATEGORY_MAP = {
    '图片': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'tiff', 'psd'],
    '视频': ['mp4', 'webm', 'avi', 'mkv', 'mov', 'wmv'],
    '音频': ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus'],
    '文档': ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'],
    '代码': ['py', 'js', 'ts', 'jsx', 'tsx', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'json', 'xml', 'yaml', 'sql', 'sh', 'bat'],
    '压缩包': ['zip', 'rar', '7z', 'tar', 'gz'],
  };

  // 分类统计
  const catStats = { '图片': 0, '视频': 0, '音频': 0, '文档': 0, '代码': 0, '压缩包': 0, '其他': 0 };
  const imgSet = new Set(['png','jpg','jpeg','gif','bmp','webp','ico','svg','tiff','psd','arw','nef','cr2','dng','heic','heif']);
  const vidSet = new Set(['mp4','webm','avi','mkv','mov','wmv','m4v','flv','3gp']);
  const audSet = new Set(['mp3','wav','flac','aac','ogg','wma','m4a','opus','mid','midi']);
  const docSet = new Set(['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv','rtf','odt']);
  const codeSet = new Set(['py','js','ts','jsx','tsx','java','c','cpp','h','cs','go','rs','rb','php','html','css','json','xml','yaml','sql','sh','bat','ps1','vue','svelte','swift','kt','dart','lua']);
  const zipSet = new Set(['zip','rar','7z','tar','gz','bz2','xz','iso']);
  
  const allKeys = Object.keys(typeStats);
  for (let i = 0; i < allKeys.length; i++) {
    const e = allKeys[i].toLowerCase();
    const count = typeStats[allKeys[i]].count;
    if (imgSet.has(e)) catStats['图片'] += count;
    else if (vidSet.has(e)) catStats['视频'] += count;
    else if (audSet.has(e)) catStats['音频'] += count;
    else if (docSet.has(e)) catStats['文档'] += count;
    else if (codeSet.has(e)) catStats['代码'] += count;
    else if (zipSet.has(e)) catStats['压缩包'] += count;
    else catStats['其他'] += count;
  }
  const catEntries = Object.entries(catStats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

  let html = `
    <div style="margin-bottom:12px;padding:8px 12px;background:var(--bg-tertiary);border-radius:8px;font-size:12px;">
      共 <strong>${totalFiles}</strong> 个文件，总大小 <strong>${formatSize(totalSize)}</strong>，涵盖 <strong>${entries.length}</strong> 种格式
    </div>
    <div style="display:flex;gap:16px;align-items:flex-start;">
      <div style="flex-shrink:0;">
        <canvas id="statsPieChart" width="180" height="180"></canvas>
      </div>
      <div style="flex:1;font-size:12px;">
  `;

  for (let i = 0; i < catEntries.length; i++) {
    const [cat, count] = catEntries[i];
    const pct = (count / totalFiles * 100).toFixed(1);
    const color = TYPE_COLORS[i % TYPE_COLORS.length];
    html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0;"></span><span style="flex:1;">${cat}</span><span style="color:var(--text-muted);">${count}</span><span style="color:var(--text-muted);width:45px;text-align:right;">${pct}%</span></div>`;
  }

  html += '</div></div>';

  // Top 10 扩展名
  html += '<div style="margin-top:12px;font-size:12px;"><div style="font-weight:600;margin-bottom:6px;">扩展名 Top 10</div>';
  const top10 = entries.slice(0, 10);
  const maxCount = top10[0]?.[1].count || 1;
  for (let i = 0; i < top10.length; i++) {
    const [ext, data] = top10[i];
    const pct = (data.count / totalFiles * 100).toFixed(1);
    const barW = (data.count / maxCount * 100).toFixed(0);
    html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;"><span style="width:40px;color:var(--text-muted);">.${ext}</span><div style="flex:1;height:14px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;"><div style="height:100%;width:${barW}%;background:${TYPE_COLORS[i % TYPE_COLORS.length]};border-radius:3px;"></div></div><span style="width:35px;text-align:right;color:var(--text-muted);">${data.count}</span><span style="width:45px;text-align:right;color:var(--text-muted);">${pct}%</span></div>`;
  }
  html += '</div>';

  document.getElementById('modalBody').innerHTML = html;

  // 画饼图
  const canvas = document.getElementById('statsPieChart');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const cx = 90, cy = 90, r = 80;
    let startAngle = -Math.PI / 2;
    for (let i = 0; i < catEntries.length; i++) {
      const [, count] = catEntries[i];
      const sliceAngle = (count / totalFiles) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
      ctx.closePath();
      ctx.fillStyle = TYPE_COLORS[i % TYPE_COLORS.length];
      ctx.fill();
      startAngle += sliceAngle;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 40, 0, Math.PI * 2);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim() || '#1e1e1e';
    ctx.fill();
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-btn secondary';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', closeModal);
  document.getElementById('modalFooter').appendChild(closeBtn);
}

// === 笔记系统 ===
async function openNoteEditor(entry) {
  const meta = await api.getMeta(entry.path);
  const existingNote = meta.fileNote || '';

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = `笔记 - ${entry.name}`;
  document.getElementById('modalBody').innerHTML = `
    <div style="margin-bottom:8px;font-size:12px;color:var(--text-muted);">
      <strong>文件路径:</strong> <span style="word-break:break-all;">${escapeHtml(entry.path)}</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <label style="font-size:12px;color:var(--text-muted);">字号</label>
      <button class="font-size-btn" data-size="-1" style="width:24px;height:24px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-primary);border-radius:4px;cursor:pointer;font-size:14px;">A-</button>
      <button class="font-size-btn" data-size="1" style="width:24px;height:24px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-primary);border-radius:4px;cursor:pointer;font-size:14px;">A+</button>
      <span class="font-size-display" style="font-size:11px;color:var(--text-primary);min-width:30px;">13px</span>
      <div style="flex:1;"></div>
      <button class="note-export-single-btn" style="padding:3px 10px;border:1px solid var(--border);background:var(--bg-tertiary);color:var(--text-primary);border-radius:6px;cursor:pointer;font-size:11px;">📄 导出笔记</button>
    </div>
    <textarea id="fileNoteInput" rows="15" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text-primary);font-family:monospace;font-size:13px;resize:vertical;line-height:1.5;" placeholder="在此编写 Markdown 笔记...">${escapeHtml(existingNote)}</textarea>
    <div style="margin-top:6px;font-size:11px;color:var(--text-muted);">支持 Markdown 语法</div>
  `;
  document.getElementById('modalFooter').innerHTML = '';

  let fontSize = 13;
  const textarea = document.getElementById('fileNoteInput');

  // 字体大小调整
  document.getElementById('modalBody').addEventListener('click', (e) => {
    const btn = e.target.closest('.font-size-btn');
    if (btn) {
      fontSize = Math.min(Math.max(9, fontSize + parseInt(btn.dataset.size * 2)), 24);
      textarea.style.fontSize = fontSize + 'px';
      document.querySelector('.font-size-display').textContent = fontSize + 'px';
    }
    const exportBtn = e.target.closest('.note-export-single-btn');
    if (exportBtn) {
      exportSingleNote(entry.path, entry.name, textarea.value);
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'modal-btn primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', async () => {
    const note = textarea.value;
    await api.saveFileNote(entry.path, note);
    closeModal();
    showToast('笔记已保存', 'success');
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'modal-btn secondary';
  deleteBtn.style.borderColor = 'var(--danger)';
  deleteBtn.style.color = 'var(--danger)';
  deleteBtn.textContent = '删除笔记';
  deleteBtn.addEventListener('click', async () => {
    if (!confirm('确定删除该文件的笔记？')) return;
    await api.saveFileNote(entry.path, '');
    closeModal();
    showToast('笔记已删除', 'success');
  });

  document.getElementById('modalFooter').appendChild(deleteBtn);
  document.getElementById('modalFooter').appendChild(cancelBtn);
  document.getElementById('modalFooter').appendChild(saveBtn);
  modal.classList.add('active');
}

async function exportSingleNote(filePath, fileName, noteContent) {
  const dir = await api.selectDirectory('选择导出位置');
  if (!dir) return;
  const noteName = fileName.replace(/[<>:"/\\|?*]/g, '_') + '.md';
  const mdContent = `# ${fileName}\n\n**源文件路径:** \`${filePath}\`\n\n---\n\n${noteContent}\n`;
  const singlePath = dir + '\\' + noteName;
  await api.writeFile(singlePath, mdContent);
  showToast(`已导出: ${noteName}`, 'success');
  api.openPath(dir);
}

async function showNoteList() {
  const notes = await api.getAllNotes();
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '笔记列表';
  
  if (notes.length === 0) {
    document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);"><div style="font-size:32px;margin-bottom:12px;">📝</div>暂无笔记<br><small>右键文件选择"关联笔记"来创建</small></div>';
    document.getElementById('modalFooter').innerHTML = '';
    modal.classList.add('active');
    return;
  }

  let html = `<div style="max-height:500px;overflow-y:auto;">`;
  for (const note of notes) {
    const preview = note.note.replace(/[#*\-_`>\[\]()]/g, '').slice(0, 100);
    const time = note.modified ? new Date(note.modified).toLocaleString('zh-CN') : '';
    html += `
      <div class="note-list-item" data-path="${escapeHtml(note.filePath)}" style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;transition:border-color 0.2s;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <span style="font-weight:600;font-size:13px;">${escapeHtml(note.fileName)}</span>
          <span style="font-size:11px;color:var(--text-muted);">${time}</span>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(preview)}${note.note.length > 100 ? '...' : ''}</div>
      </div>
    `;
  }
  html += '</div>';

  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('modalFooter').innerHTML = '';

  // 点击编辑笔记
  document.getElementById('modalBody').addEventListener('click', async (e) => {
    const item = e.target.closest('.note-list-item');
    if (!item) return;
    const filePath = item.dataset.path;
    const meta = await api.getMeta(filePath);
    const entry = { name: filePath.split(/[/\\]/).pop(), path: filePath };
    closeModal();
    setTimeout(() => openNoteEditor(entry), 200);
  });

  // hover 效果
  document.querySelectorAll('.note-list-item').forEach(item => {
    item.addEventListener('mouseenter', () => { item.style.borderColor = 'var(--accent)'; });
    item.addEventListener('mouseleave', () => { item.style.borderColor = 'var(--border)'; });
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-btn secondary';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', closeModal);
  document.getElementById('modalFooter').appendChild(closeBtn);
  modal.classList.add('active');
}

async function exportNotes() {
  const dir = await api.selectDirectory('选择导出位置');
  if (!dir) return;
  const result = await api.exportNotes(dir);
  if (result.success) {
    showToast(`已导出 ${result.count} 篇笔记`, 'success', 5000);
    api.openPath(result.path);
  } else {
    showToast('导出失败: ' + result.error, 'error');
  }
}

// === 文件对比 ===
let diffFirstFile = null;

function startDiff(entry) {
  if (!diffFirstFile) {
    diffFirstFile = entry;
    showToast(`已选择: ${entry.name}，再右键一个文件进行对比`, 'info', 3000);
  } else {
    const first = diffFirstFile;
    diffFirstFile = null;
    showDiff(first, entry);
  }
}

async function showDiff(fileA, fileB) {
  const contentA = await api.readFileText(fileA.path);
  const contentB = await api.readFileText(fileB.path);

  if (contentA === null || contentB === null) {
    showToast('无法读取文件内容（仅支持文本文件）', 'error');
    return;
  }

  const linesA = contentA.split('\n');
  const linesB = contentB.split('\n');
  const diff = computeDiff(linesA, linesB);

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = `对比: ${fileA.name} ↔ ${fileB.name}`;

  let html = `
    <div style="display:flex;gap:0;font-size:12px;font-family:monospace;border:1px solid var(--border);border-radius:8px;overflow:hidden;">
      <div style="flex:1;border-right:1px solid var(--border);">
        <div style="padding:6px 10px;background:var(--bg-tertiary);font-weight:600;border-bottom:1px solid var(--border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(fileA.path)}">${escapeHtml(fileA.name)}</div>
        <div id="diffLeft" style="max-height:400px;overflow-y:auto;">${renderDiffSide(diff, 'left')}</div>
      </div>
      <div style="flex:1;">
        <div style="padding:6px 10px;background:var(--bg-tertiary);font-weight:600;border-bottom:1px solid var(--border);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(fileB.path)}">${escapeHtml(fileB.name)}</div>
        <div id="diffRight" style="max-height:400px;overflow-y:auto;">${renderDiffSide(diff, 'right')}</div>
      </div>
    </div>
    <div style="margin-top:8px;font-size:11px;color:var(--text-muted);display:flex;gap:12px;">
      <span><span style="display:inline-block;width:10px;height:10px;background:#3b82f6;border-radius:2px;"></span> 修改</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:#22c55e;border-radius:2px;"></span> 新增</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:#ef4444;border-radius:2px;"></span> 删除</span>
      <span>共 ${diff.filter(d => d.type !== 'equal').length} 处差异</span>
    </div>
  `;

  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('modalFooter').innerHTML = '';

  // 同步滚动
  const leftEl = document.getElementById('diffLeft');
  const rightEl = document.getElementById('diffRight');
  let syncing = false;
  leftEl?.addEventListener('scroll', () => { if (!syncing) { syncing = true; rightEl.scrollTop = leftEl.scrollTop; syncing = false; } });
  rightEl?.addEventListener('scroll', () => { if (!syncing) { syncing = true; leftEl.scrollTop = rightEl.scrollTop; syncing = false; } });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-btn secondary';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', closeModal);
  document.getElementById('modalFooter').appendChild(closeBtn);
  modal.classList.add('active');
}

function computeDiff(linesA, linesB) {
  // LCS 动态规划
  const dp = Array(linesA.length + 1).fill(null).map(() => Array(linesB.length + 1).fill(0));
  for (let i = 1; i <= linesA.length; i++) {
    for (let j = 1; j <= linesB.length; j++) {
      if (linesA[i - 1] === linesB[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // 回溯
  let i = linesA.length, j = linesB.length;
  const ops = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      ops.unshift({ type: 'equal', lineA: linesA[i - 1], lineB: linesB[j - 1], numA: i, numB: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'add', lineB: linesB[j - 1], numB: j });
      j--;
    } else {
      ops.unshift({ type: 'del', lineA: linesA[i - 1], numA: i });
      i--;
    }
  }

  // 合并相邻修改
  const merged = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type === 'del' && k + 1 < ops.length && ops[k + 1].type === 'add') {
      merged.push({ type: 'change', lineA: ops[k].lineA, lineB: ops[k + 1].lineB, numA: ops[k].numA, numB: ops[k + 1].numB });
      k++;
    } else {
      merged.push(ops[k]);
    }
  }

  return merged;
}

function renderDiffSide(diff, side) {
  let html = '';
  for (const d of diff) {
    const num = side === 'left' ? (d.numA || '') : (d.numB || '');
    const line = side === 'left' ? (d.lineA || '') : (d.lineB || '');
    
    if (d.type === 'equal') {
      html += `<div style="display:flex;"><span style="width:35px;text-align:right;padding-right:8px;color:var(--text-muted);flex-shrink:0;">${num}</span><span style="padding:1px 4px;white-space:pre;">${escapeHtml(line)}</span></div>`;
    } else if (d.type === 'change') {
      const bg = side === 'left' ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.15)';
      html += `<div style="display:flex;background:${bg};"><span style="width:35px;text-align:right;padding-right:8px;color:var(--text-muted);flex-shrink:0;">${num}</span><span style="padding:1px 4px;white-space:pre;">${escapeHtml(line)}</span></div>`;
    } else if (d.type === 'add' && side === 'right') {
      html += `<div style="display:flex;background:rgba(34,197,94,0.15);"><span style="width:35px;text-align:right;padding-right:8px;color:var(--text-muted);flex-shrink:0;">${num}</span><span style="padding:1px 4px;white-space:pre;">${escapeHtml(line)}</span></div>`;
    } else if (d.type === 'del' && side === 'left') {
      html += `<div style="display:flex;background:rgba(239,68,68,0.15);"><span style="width:35px;text-align:right;padding-right:8px;color:var(--text-muted);flex-shrink:0;">${num}</span><span style="padding:1px 4px;white-space:pre;">${escapeHtml(line)}</span></div>`;
    } else {
      html += `<div style="display:flex;"><span style="width:35px;text-align:right;padding-right:8px;flex-shrink:0;"></span><span style="padding:1px 4px;">&nbsp;</span></div>`;
    }
  }
  return html;
}

// === 批量重命名 ===
async function batchRename(panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const p = panels[panelIdx];
  if (p.selectedFiles.size === 0) return;

  const files = [...p.selectedFiles].map(f => f.split(/[/\\]/).pop());

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = `批量重命名 (${files.length} 个文件)`;
  
  const previewHtml = files.map(f => `<div class="rename-preview-item" data-original="${escapeHtml(f)}">${escapeHtml(f)}</div>`).join('');
  
  document.getElementById('modalBody').innerHTML = `
    <div class="form-group">
      <label>查找（支持正则）</label>
      <input type="text" id="renameFindInput" placeholder="例如: photo_(\\d+)" style="font-family:monospace;">
    </div>
    <div class="form-group">
      <label>替换为</label>
      <input type="text" id="renameReplaceInput" placeholder="例如: vacation_\$1">
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" id="renameRegexToggle" checked> 正则表达式
      </label>
    </div>
    <div class="rename-preview" id="renamePreview" style="max-height:200px;overflow-y:auto;background:var(--bg-tertiary);border-radius:8px;padding:8px;font-size:12px;font-family:monospace;">
      ${previewHtml}
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = '';

  // 实时预览
  const updatePreview = () => {
    const findVal = document.getElementById('renameFindInput').value;
    const replaceVal = document.getElementById('renameReplaceInput').value;
    const isRegex = document.getElementById('renameRegexToggle').checked;
    const items = document.querySelectorAll('#renamePreview .rename-preview-item');
    
    items.forEach(item => {
      const original = item.dataset.original;
      try {
        let newName;
        if (isRegex && findVal) {
          const regex = new RegExp(findVal, 'g');
          newName = original.replace(regex, replaceVal);
        } else if (findVal) {
          newName = original.split(findVal).join(replaceVal);
        } else {
          newName = original;
        }
        
        if (newName !== original) {
          item.innerHTML = `<span style="color:var(--text-muted);text-decoration:line-through;">${escapeHtml(original)}</span> → <span style="color:#22c55e;">${escapeHtml(newName)}</span>`;
        } else {
          item.innerHTML = `<span>${escapeHtml(original)}</span>`;
        }
      } catch (e) {
        item.innerHTML = `<span style="color:var(--danger);">${escapeHtml(original)} (正则错误)</span>`;
      }
    });
  };

  document.getElementById('renameFindInput').addEventListener('input', updatePreview);
  document.getElementById('renameReplaceInput').addEventListener('input', updatePreview);
  document.getElementById('renameRegexToggle').addEventListener('change', updatePreview);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);

  const applyBtn = document.createElement('button');
  applyBtn.className = 'modal-btn primary';
  applyBtn.textContent = '执行重命名';
  const idx = panelIdx;
  applyBtn.addEventListener('click', async () => {
    const findVal = document.getElementById('renameFindInput').value;
    const replaceVal = document.getElementById('renameReplaceInput').value;
    const isRegex = document.getElementById('renameRegexToggle').checked;
    if (!findVal) { showToast('请输入查找内容', 'error'); return; }

    let renamed = 0;
    let failed = 0;
    for (const filePath of p.selectedFiles) {
      const fileName = filePath.split(/[/\\]/).pop();
      const dir = filePath.replace(/[/\\][^/\\]+$/, '');
      
      try {
        let newName;
        if (isRegex) {
          const regex = new RegExp(findVal, 'g');
          newName = fileName.replace(regex, replaceVal);
        } else {
          newName = fileName.split(findVal).join(replaceVal);
        }
        
        if (newName === fileName) continue;
        if (!newName || newName.includes('/') || newName.includes('\\')) { failed++; continue; }
        
        const result = await api.renamePath(filePath, newName);
        if (result) renamed++;
        else failed++;
      } catch (e) {
        failed++;
      }
    }

    closeModal();
    clearSelection(idx);
    if (p.currentDir) await loadDir(p.currentDir, idx);
    const msg = failed > 0
      ? `已重命名 ${renamed} 个，失败 ${failed} 个`
      : `已重命名 ${renamed} 个文件`;
    showToast(msg, failed > 0 ? 'warning' : 'success');
  });

  document.getElementById('modalFooter').appendChild(cancelBtn);
  document.getElementById('modalFooter').appendChild(applyBtn);
  modal.classList.add('active');
}

// === 搜索功能 ===
function clearSearchHighlight() {
  document.querySelectorAll('.tree-node-item').forEach(n => {
    n.style.background = '';
    n.style.color = '';
  });
}

function parseSearchQuery(query) {
  // Normalize Chinese symbols to English
  const q = query.replace(/＃/g, '#').replace(/！/g, '!').replace(/＠/g, '@').replace(/｜/g, '|').replace(/：/g, ':').replace(/　/g, ' ');
  const conditions = { tags: [], exts: [], notes: [], yaml: [], excludeTags: [], excludeExts: [], keywords: [], hasOr: false };
  
  const orParts = q.split('|');
  if (orParts.length > 1) conditions.hasOr = true;
  
  for (const part of orParts) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (token.startsWith('-#')) {
        conditions.excludeTags.push(token.slice(2).toLowerCase());
      } else if (token.startsWith('-!')) {
        conditions.excludeExts.push(token.slice(2).toLowerCase());
      } else if (token.startsWith('#')) {
        conditions.tags.push(token.slice(1).toLowerCase());
      } else if (token.startsWith('!')) {
        conditions.exts.push(token.slice(1).toLowerCase());
      } else if (token.startsWith('@')) {
        conditions.notes.push(token.slice(1).toLowerCase());
      } else if (token.startsWith('yaml:')) {
        conditions.yaml.push(token.slice(5).toLowerCase());
      } else {
        conditions.keywords.push(token.toLowerCase());
      }
    }
  }
  return conditions;
}

function matchFile(entry, conditions, meta) {
  const ext = entry.name.split('.').pop().toLowerCase();
  const name = entry.name.toLowerCase();
  const tags = (meta?.tags || '').toLowerCase();
  const notes = (meta?.notes || '').toLowerCase();
  
  // 检查排除条件（AND逻辑 - 任一排除匹配则拒绝）
  for (const et of conditions.excludeTags) {
    if (tags.includes(et)) return false;
  }
  for (const ee of conditions.excludeExts) {
    if (ext === ee) return false;
  }
  
  // 检查正向条件（组内AND逻辑，组间OR逻辑）
  let matchTag = conditions.tags.length === 0;
  let matchExt = conditions.exts.length === 0;
  let matchNote = conditions.notes.length === 0;
  let matchYaml = conditions.yaml.length === 0;
  let matchKw = conditions.keywords.length === 0;
  
  // 标签匹配
  if (conditions.tags.length > 0) {
    matchTag = conditions.tags.some(t => tags.includes(t));
  }
  
  // 扩展名匹配
  if (conditions.exts.length > 0) {
    matchExt = conditions.exts.some(e => ext === e || (e === 'image' && ['png','jpg','jpeg','gif','bmp','webp','svg','ico'].includes(ext)) || (e === 'code' && ['py','js','ts','java','c','cpp','h','go','rs','rb','php'].includes(ext)) || (e === 'doc' && ['doc','docx','pdf','txt','md'].includes(ext)));
  }
  
  // 备注匹配
  if (conditions.notes.length > 0) {
    matchNote = conditions.notes.some(n => notes.includes(n));
  }
  
  // YAML match (check if notes contain yaml-like key:value)
  if (conditions.yaml.length > 0) {
    const yamlContent = notes + ' ' + tags;
    matchYaml = conditions.yaml.some(y => yamlContent.includes(y));
  }
  
  // 关键词匹配（文件名）
  if (conditions.keywords.length > 0) {
    matchKw = conditions.keywords.some(k => name.includes(k));
  }
  
  // OR mode: any group matches
  if (conditions.hasOr) {
    return matchTag || matchExt || matchNote || matchYaml || matchKw;
  }
  
  // AND mode: all groups must match
  return matchTag && matchExt && matchNote && matchYaml && matchKw;
}

function renderSearchResults(results, title) {
  const tbody = document.getElementById('fileTableBody' + activePanelIndex);
  if (!tbody) return;
  tbody.innerHTML = '';

  const header = document.createElement('tr');
  header.innerHTML = `<td colspan="4" style="padding:8px 12px;font-size:12px;font-weight:600;color:var(--text-muted);">${escapeHtml(title)}</td>`;
  tbody.appendChild(header);

  if (results.length === 0) {
    tbody.innerHTML += '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-muted);">未找到匹配的文件</td></tr>';
    return;
  }

  for (const file of results) {
    const ext = file.name.split('.').pop().toLowerCase();
    const icon = file.isDir ? '📂' : getFileIcon(ext);
    const tr = document.createElement('tr');
    tr.dataset.path = file.path;
    tr.innerHTML = `
      <td><div class="file-name"><span class="file-icon">${icon}</span><span>${escapeHtml(file.name)}</span></div></td>
      <td><span style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;display:block;">${escapeHtml(file.path)}</span></td>
      <td>${file.isDir ? '-' : formatSize(file.size || 0)}</td>
      <td>${file.modified ? formatDate(file.modified) : ''}</td>
    `;
    tr.addEventListener('dblclick', () => {
      if (file.isDir) {
        loadDir(file.path, activePanelIndex);
        highlightTreeNode(file.path);
      } else {
        const dir = file.path.replace(/[/\\][^/\\]+$/, '');
        loadDir(dir, activePanelIndex);
        highlightTreeNode(dir);
      }
    });
    tbody.appendChild(tr);

    // 显示匹配行
    if (file.matchLines && file.matchLines.length > 0) {
      for (const m of file.matchLines) {
        const matchTr = document.createElement('tr');
        matchTr.innerHTML = `<td colspan="4" style="padding:2px 12px 2px 28px;font-size:11px;font-family:monospace;color:var(--text-muted);"><span style="color:var(--accent);">行${m.line}:</span> ${escapeHtml(m.text)}</td>`;
        tbody.appendChild(matchTr);
      }
    }
  }
}

async function globalSearch(query) {
  if (workspaces.length === 0 && !workspaceDir) return;
  
  const results = await api.searchFiles(query);
  renderSearchResults(results, `全局搜索: "${escapeHtml(query)}"`);
}

async function advancedSearch(query) {
  if (workspaces.length === 0 && !workspaceDir) return;
  
  const conditions = parseSearchQuery(query);
  const hasSpecial = conditions.tags.length > 0 || conditions.exts.length > 0 || 
                     conditions.notes.length > 0 || conditions.yaml.length > 0 || 
                     conditions.excludeTags.length > 0 || conditions.excludeExts.length > 0;
  
  // 如果只有关键词，根据范围搜索
  if (!hasSpecial && conditions.keywords.length > 0 && !conditions.hasOr) {
    const scope = document.querySelector('.scope-btn.active')?.dataset.scope;
    if (scope === 'global') {
      return await searchFiles(conditions.keywords.join(' '));
    } else {
      // 本地搜索：文件名 + 全文检索
      const dir = panels[activePanelIndex].currentDir;
      if (!dir) return;
      
      const keyword = conditions.keywords.join(' ');
      const contentResults = await api.searchFileContent(dir, keyword);
      
      // 转换为统一格式
      const results = contentResults.map(r => ({
        name: r.name,
        isDir: false,
        path: r.path,
        size: 0,
        modified: null,
        matchLines: r.matches
      }));
      
      return renderSearchResults(results, `内容搜索: "${keyword}" (${results.length} 个文件匹配)`);
    }
  }
  
  // Otherwise, do client-side filtering
  const results = [];
  
  async function collectFiles(dirPath) {
    try {
      const entries = await api.readDir(dirPath);
      for (const entry of entries) {
        results.push(entry);
        if (entry.isDir && results.length < 2000) {
          await collectFiles(entry.path);
        }
      }
    } catch (e) {
      console.error('collectFiles error:', dirPath, e);
    }
  }
  
  // 收集文件
  const scope = document.querySelector('.scope-btn.active')?.dataset.scope;
  const paths = scope === 'global'
    ? (workspaces.length > 0 ? workspaces.map(w => w.path).filter(Boolean) : [workspaceDir].filter(Boolean))
    : [panels[activePanelIndex].currentDir].filter(Boolean);
  
  for (const p of paths) {
    if (results.length >= 2000) break;
    await collectFiles(p);
  }
  
  // 获取所有文件的元数据
  const filtered = [];
  for (const entry of results) {
    if (filtered.length >= 200) break;
    let meta = { tags: '', notes: '' };
    if (!entry.isDir) {
      try { meta = await api.getMeta(entry.path); } catch (e) {}
    }
    if (matchFile(entry, conditions, meta)) {
      filtered.push({ ...entry, meta });
    }
  }
  
  // 显示结果
  document.getElementById('statusText').textContent = `搜索: ${filtered.length} 个结果`;
  const tbody = document.getElementById('fileTableBody' + activePanelIndex);
  tbody.innerHTML = '';
  
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:40px;">未找到匹配的文件</td></tr>';
    return;
  }
  
  const resultDirs = new Set();
  for (const r of filtered) {
    const dir = r.path.replace(/[/\\][^/\\]+$/, '');
    if (dir !== workspaceDir) resultDirs.add(dir);
  }
  await syncTreeForSearch(resultDirs);
  
  for (const entry of filtered) {
    const tr = document.createElement('tr');
    tr.dataset.path = entry.path;
    const ext = entry.name.split('.').pop().toLowerCase();
    const icon = entry.isDir ? '📂' : getFileIcon(ext);
    const tagsHtml = entry.meta?.tags ? renderTags(entry.meta.tags) : '';
    
    tr.innerHTML = `
      <td><div class="file-name"><span class="file-icon">${icon}</span><span>${entry.name}</span></div></td>
      <td><div class="file-tags">${tagsHtml}</div></td>
      <td>${entry.isDir ? '-' : formatSize(entry.size)}</td>
      <td>${formatDate(entry.modified)}</td>
    `;
    
    tr.addEventListener('click', () => {
      document.querySelectorAll('.file-table tbody tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      if (!entry.isDir) openFileDetail(entry);
    });
    tr.addEventListener('dblclick', () => {
      if (entry.isDir) { loadDir(entry.path, activePanelIndex); buildTree(); }
      else { api.openPath(entry.path); }
    });
    tbody.appendChild(tr);
  }
}

async function searchFiles(keyword) {
  if (!workspaceDir) return;
  const results = await api.searchFiles(keyword);
  document.getElementById('statusText').textContent = `搜索: ${results.length} 个结果`;

  const tbody = document.getElementById('fileTableBody' + activePanelIndex);
  if (!tbody) return;
  tbody.innerHTML = '';

  if (results.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:40px;">未找到匹配的文件</td></tr>';
    return;
  }

  const resultDirs = new Set();
  for (const r of results) {
    const dir = r.path.replace(/[/\\][^/\\]+$/, '');
    if (dir !== workspaceDir) resultDirs.add(dir);
  }
  await syncTreeForSearch(resultDirs);

  for (const entry of results) {
    const tr = document.createElement('tr');
    tr.dataset.path = entry.path;
    const ext = entry.name.split('.').pop().toLowerCase();
    const icon = entry.isDir ? '📂' : getFileIcon(ext);
    const highlight = keyword ? entry.name.replace(new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark style="background:var(--accent);color:white;border-radius:2px;padding:0 2px;">$1</mark>') : entry.name;

    let tagsHtml = '';
    if (!entry.isDir) {
      try {
        const meta = await api.getMeta(entry.path);
        if (meta.tags) tagsHtml = renderTags(meta.tags);
      } catch (e) {}
    }

    tr.innerHTML = `
      <td><div class="file-name"><span class="file-icon">${icon}</span><span>${highlight}</span></div></td>
      <td><div class="file-tags">${tagsHtml}</div></td>
      <td>${entry.isDir ? '-' : formatSize(entry.size)}</td>
      <td>${formatDate(entry.modified)}</td>
    `;
    tr.addEventListener('click', () => {
      document.querySelectorAll('.file-table tbody tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      if (!entry.isDir) openFileDetail(entry);
    });
    tr.addEventListener('dblclick', () => {
      if (entry.isDir) { loadDir(entry.path); buildTree(); }
      else { api.openPath(entry.path); }
    });
    tbody.appendChild(tr);
  }
}

async function syncTreeForSearch(dirPaths) {
  if (dirPaths.size === 0) return;

  // First, collapse all
  document.querySelectorAll('.tree-children').forEach(c => { c.style.display = 'none'; });
  document.querySelectorAll('.tree-arrow').forEach(a => { a.classList.remove('expanded'); });

  // 高亮匹配的目录
  for (const dirPath of dirPaths) {
    const parts = dirPath.replace(workspaceDir, '').split(/[/\\]/).filter(Boolean);
    let accum = workspaceDir;
    for (const part of parts) {
      accum += '\\' + part;
      // 展开这一层
      const node = document.querySelector(`.tree-node-item[data-path="${CSS.escape(accum)}"]`);
      if (node) {
        const arrow = node.querySelector('.tree-arrow');
        const childrenEl = node.nextElementSibling;
        if (childrenEl && childrenEl.classList.contains('tree-children')) {
          if (childrenEl.style.display === 'none') {
            if (childrenEl.querySelectorAll('.tree-node-item').length === 0) {
              const depth = accum.replace(workspaceDir, '').split(/[/\\]/).filter(Boolean).length;
              await loadChildren(childrenEl, accum, depth, false);
            }
            childrenEl.style.display = 'block';
            if (arrow) arrow.classList.add('expanded');
          }
        }
      } else {
        // 先展开父级
        const parentPath = accum.replace(/[/\\][^/\\]+$/, '');
        const parentNode = document.querySelector(`.tree-node-item[data-path="${CSS.escape(parentPath)}"]`);
        if (parentNode) {
          const arrow = parentNode.querySelector('.tree-arrow');
          const childrenEl = parentNode.nextElementSibling;
          if (childrenEl && childrenEl.classList.contains('tree-children') && childrenEl.style.display === 'none') {
            if (childrenEl.querySelectorAll('.tree-node-item').length === 0) {
              const depth = parentPath.replace(workspaceDir, '').split(/[/\\]/).filter(Boolean).length;
              await loadChildren(childrenEl, parentPath, depth, false);
            }
            childrenEl.style.display = 'block';
            if (arrow) arrow.classList.add('expanded');
          }
          // 再次尝试查找节点
          const node2 = document.querySelector(`.tree-node-item[data-path="${CSS.escape(accum)}"]`);
          if (node2) {
            const arrow2 = node2.querySelector('.tree-arrow');
            const childrenEl2 = node2.nextElementSibling;
            if (childrenEl2 && childrenEl2.classList.contains('tree-children')) {
              if (childrenEl2.querySelectorAll('.tree-node-item').length === 0) {
                const depth2 = accum.replace(workspaceDir, '').split(/[/\\]/).filter(Boolean).length;
                await loadChildren(childrenEl2, accum, depth2, false);
              }
              childrenEl2.style.display = 'block';
              if (arrow2) arrow2.classList.add('expanded');
            }
          }
        }
      }
    }
    // 高亮叶子目录
    const leafNode = document.querySelector(`.tree-node-item[data-path="${CSS.escape(dirPath)}"]`);
    if (leafNode) {
      leafNode.style.background = 'var(--bg-active)';
      leafNode.style.color = 'var(--accent)';
    }
  }
}

// === 操作功能 ===
async function navigateToPath(targetPath) {
  // 标准化路径
  const normalized = targetPath.replace(/\//g, '\\');
  
  // 检查路径是否存在
  const pathInfo = await api.checkPath(normalized);
  if (!pathInfo.exists) {
    showToast('路径不存在', 'error');
    return;
  }

  let dirToLoad = normalized;
  
  // 如果是文件，跳转到其所在目录
  if (!pathInfo.isDir) {
    dirToLoad = normalized.replace(/\\[^\\]+$/, '');
    const parentInfo = await api.checkPath(dirToLoad);
    if (!parentInfo.exists) {
      showToast('路径不存在', 'error');
      return;
    }
  }

  // 检查此目录是否在工作区或已链接文件夹内
  let isAccessible = false;
  if (workspaceDir && dirToLoad.startsWith(workspaceDir)) {
    isAccessible = true;
  } else {
    for (const lf of linkedFolders) {
      if (dirToLoad.startsWith(lf.path) || lf.path.startsWith(dirToLoad)) {
        isAccessible = true;
        break;
      }
    }
  }

  // 如果不可访问，自动链接目录（或其父目录）
  if (!isAccessible) {
    const linkTarget = pathInfo.isDir ? normalized : dirToLoad;
    const result = await api.addLinkedFolderPath(linkTarget);
    if (result && !result.alreadyLinked) {
      linkedFolders.push(result);
      await buildTree();
      showToast(`已自动链接: ${result.name}`, 'success');
    } else if (result && result.alreadyLinked) {
      // 已链接，直接跳转
    } else {
      showToast('无法链接该路径', 'error');
      return;
    }
  }

  // 跳转到目标目录
  currentDir = dirToLoad;
  expandedDirs.clear();
  document.getElementById('emptyHint').style.display = 'none';
  document.getElementById('fileTree').style.display = 'block';
  await buildTree();
  await expandTreeToPath(dirToLoad);
  await loadDir(dirToLoad);
  highlightTreeNode(dirToLoad);
  document.getElementById('searchInput').value = '';
  clearSearchHighlight();
  showToast(`已跳转: ${dirToLoad.split(/[/\\]/).pop()}`, 'success');
}

async function goBack() {
  if (!currentDir || !workspaceDir) return;
  if (currentDir === workspaceDir) return;
  const parentPath = currentDir.replace(/[/\\][^/\\]+$/, '');
  if (parentPath === currentDir) return;
  currentDir = parentPath;
  await loadDir(parentPath);
  await buildTree();
  highlightTreeNode(parentPath);
}

async function expandTreeToPath(targetPath) {
  if (!workspaceDir || !targetPath) return;
  
  let accum = workspaceDir;
  const targetParts = targetPath.replace(workspaceDir, '').split(/[/\\]/).filter(Boolean);
  
  // 1. 确保根节点的子节点已加载并展开
  const rootNode = document.querySelector(`.tree-node-item[data-path="${CSS.escape(accum)}"]`);
  if (!rootNode) return;
  await ensureExpanded(rootNode, accum, 1, []);
  
  // 2. 逐层展开到目标路径
  for (let i = 0; i < targetParts.length; i++) {
    accum = accum + '\\' + targetParts[i];
    
    let node = document.querySelector(`.tree-node-item[data-path="${CSS.escape(accum)}"]`);
    if (!node) {
      const parentPath = accum.replace(/[/\\][^/\\]+$/, '');
      const parentNode = document.querySelector(`.tree-node-item[data-path="${CSS.escape(parentPath)}"]`);
      if (parentNode) {
        const depth = i + 1;
        await ensureExpanded(parentNode, parentPath, depth, targetParts);
      }
      node = document.querySelector(`.tree-node-item[data-path="${CSS.escape(accum)}"]`);
    }
    
    if (node) {
      const depth = i + 1;
      await ensureExpanded(node, accum, depth, targetParts);
    }
  }
  
  highlightTreeNode(targetPath);
}

async function ensureExpanded(node, dirPath, depth, targetParts) {
  const arrow = node.querySelector('.tree-arrow');
  const childrenEl = node.nextElementSibling;
  if (!childrenEl || !childrenEl.classList.contains('tree-children')) return;
  
  if (childrenEl.style.display === 'none') {
    if (childrenEl.children.length === 0) {
      await loadChildren(childrenEl, dirPath, depth, false);
    }
    childrenEl.style.display = 'block';
    if (arrow) arrow.classList.add('expanded');
  }
}

function collapseAllChildren(container) {
  container.querySelectorAll('.tree-children').forEach(sc => {
    if (sc.style.display !== 'none') {
      sc.style.display = 'none';
      const sibItem = sc.previousElementSibling;
      if (sibItem) {
        const sibArrow = sibItem.querySelector('.tree-arrow');
        if (sibArrow) sibArrow.classList.remove('expanded');
      }
    }
  });
}

function highlightTreeNode(dirPath) {
  document.querySelectorAll('.tree-node-item').forEach(n => n.classList.remove('active'));
  const node = document.querySelector(`.tree-node-item[data-path="${CSS.escape(dirPath)}"]`);
  if (node) {
    node.classList.add('active');
    node.scrollIntoView({ block: 'nearest' });
  }
}

async function linkNewFolder() {
  const folder = await api.addLinkedFolder();
  if (folder) {
    linkedFolders.push(folder);
    await buildTree();
    showToast(`已链接: ${folder.name}`, 'success');
  }
}

async function createNewFolder() {
  if (!currentDir) { showToast('请先设置工作目录', 'error'); return; }
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '新建文件夹';
  document.getElementById('modalBody').innerHTML = `
    <div class="form-group">
      <label>文件夹名称</label>
      <input type="text" id="newFolderNameInput" placeholder="请输入文件夹名称">
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);
  const createBtn = document.createElement('button');
  createBtn.className = 'modal-btn primary';
  createBtn.textContent = '创建';
  createBtn.addEventListener('click', async () => {
    const name = document.getElementById('newFolderNameInput').value.trim();
    if (!name) return;
    const ok = await api.createFolder(currentDir, name);
    if (ok) {
      closeModal();
      showToast('文件夹已创建', 'success');
      await loadDir(currentDir);
      await buildTree();
    }
  });
  document.getElementById('modalFooter').appendChild(cancelBtn);
  document.getElementById('modalFooter').appendChild(createBtn);
  modal.classList.add('active');
  setTimeout(() => document.getElementById('newFolderNameInput').focus(), 100);
}

async function renameSelected() {
  const sel = document.querySelector('.file-table tbody tr.selected');
  if (!sel) { showToast('请先选择文件', 'error'); return; }
  const oldPath = sel.dataset.path;
  const oldName = oldPath.split(/[/\\]/).pop();
  const newName = prompt('重命名:', oldName);
  if (!newName || newName === oldName) return;
  const newPath = await api.renamePath(oldPath, newName);
  if (newPath) { refresh(); showToast('已重命名', 'success'); }
}

async function deleteSelected() {
  const sel = document.querySelector('.file-table tbody tr.selected');
  if (!sel) { showToast('请先选择文件', 'error'); return; }
  const p = sel.dataset.path;
  const name = p.split(/[/\\]/).pop();
  if (!confirm(`确定删除 "${name}" 吗？`)) return;
  const ok = await api.deletePath(p);
  if (ok) { refresh(); showToast('已删除', 'success'); }
}

function copyPath() {
  const sel = document.querySelector('.file-table tbody tr.selected');
  if (!sel) return;
  navigator.clipboard.writeText(sel.dataset.path);
  showToast('路径已复制', 'success');
}

function positionMenu(menu, e) {
  menu.style.left = '0';
  menu.style.top = '0';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  let x = e.clientX;
  let y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  if (x < 0) x = 8;
  if (y < 0) y = 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function closeMenuOnClick(menu) {
  setTimeout(() => {
    document.addEventListener('click', function handler(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', handler); }
    });
  }, 50);
}

function showLinkedFolderContextMenu(e, lf) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = [
    { icon: '📂', label: '打开', action: () => { currentDir = lf.path; loadDir(lf.path); } },
    { icon: '🪟', label: '在资源管理器中打开', action: () => api.openPath(lf.path) },
    { icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(lf.path); showToast('路径已复制', 'success'); } },
  ];

  if (multiWindow) {
    items.push({ icon: '📑', label: '在新窗口打开', action: () => api.openNewWindow(lf.path) });
  }

  if (clipboard) {
    items.push({ icon: '📌', label: '粘贴到此文件夹', action: () => pasteToFolder(lf.path) });
  }

  items.push({ sep: true });
  items.push({ icon: '🗑️', label: '解除链接', cls: 'danger', action: async () => {
    if (confirm(`确定解除链接 "${lf.name}" 吗？`)) {
      await api.removeLinkedFolder(lf.id);
      linkedFolders = linkedFolders.filter(f => f.id !== lf.id);
      await buildTree();
      showToast('链接已解除', 'success');
    }
  }});

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = `ctx-menu-item ${item.cls || ''}`;
      btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(btn);
    }
  }

  positionMenu(menu, e);
  closeMenuOnClick(menu);
}

function showWorkspaceContextMenu(e, ws) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = [
    { icon: '📂', label: '打开', action: () => { currentDir = ws.path; loadDir(ws.path); } },
    { icon: '🪟', label: '在资源管理器中打开', action: () => api.openPath(ws.path) },
    { icon: '⬛', label: '在终端中打开', action: () => api.openTerminal(ws.path) },
    { icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(ws.path); showToast('路径已复制', 'success'); } },
    { icon: '📝', label: '文件夹备注', action: () => showFolderNoteModal(ws.path, ws.name) },
    { icon: isFavorite(ws.path) ? '💛' : '⭐', label: isFavorite(ws.path) ? '取消收藏' : '收藏', action: () => { isFavorite(ws.path) ? removeFavorite(ws.path) : addFavorite(ws.path); } },
  ];

  if (!ws.isPrimary) {
    items.push({ sep: true });
    items.push({ icon: '⭐', label: '设为主目录', action: async () => {
      await api.setPrimaryWorkspace(ws.id);
      workspaces = await api.getWorkspaces();
      workspaceDir = workspaces.find(w => w.isPrimary)?.path;
      await buildTree();
      showToast('已设为主目录', 'success');
    }});
  }

  if (!ws.isPrimary) {
    items.push({ icon: '🗑️', label: '移除此目录', cls: 'danger', action: async () => {
      if (confirm(`确定移除工作目录 "${ws.name}" 吗？`)) {
        await api.removeWorkspace(ws.id);
        workspaces = await api.getWorkspaces();
        await buildTree();
        showToast('已移除', 'success');
      }
    }});
  }

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = `ctx-menu-item ${item.cls || ''}`;
      btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(btn);
    }
  }

  positionMenu(menu, e);
  closeMenuOnClick(menu);
}

function showTreeContextMenu(e, dirPath, dirName) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = [
    { icon: '📂', label: '打开', action: () => { currentDir = dirPath; loadDir(dirPath); } },
    { icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(dirPath); showToast('路径已复制', 'success'); } },
    { icon: '🪟', label: '在资源管理器中打开', action: () => api.openPath(dirPath) },
    { icon: '⬛', label: '在终端中打开', action: () => api.openTerminal(dirPath) },
    { icon: '📝', label: '文件夹备注', action: () => showFolderNoteModal(dirPath, dirName) },
    { icon: isFavorite(dirPath) ? '💛' : '⭐', label: isFavorite(dirPath) ? '取消收藏' : '收藏', action: () => { isFavorite(dirPath) ? removeFavorite(dirPath) : addFavorite(dirPath); } },
  ];

  if (multiWindow) {
    items.splice(1, 0, { icon: '📑', label: '在新标签页打开', action: () => openTab(dirPath) });
  }

  if (multiWindow) {
    items.push({ icon: '🪟', label: '在新窗口打开', action: () => api.openNewWindow(dirPath) });
  }

  if (clipboard) {
    items.push({ icon: '📌', label: '粘贴到此文件夹', action: () => pasteToFolder(dirPath) });
  }

  if (dirPath !== workspaceDir) {
    items.push({ sep: true });
    items.push({ icon: '✏️', label: '重命名', action: async () => {
      const newName = prompt('重命名:', dirName);
      if (newName && newName !== dirName) {
        const result = await api.renamePath(dirPath, newName);
        if (result) { showToast('已重命名', 'success'); await buildTree(); if (currentDir) await loadDir(currentDir); }
      }
    }});
    items.push({ icon: '🗑️', label: '删除文件夹', cls: 'danger', action: async () => {
      if (confirm(`确定删除文件夹 "${dirName}" 吗？`)) {
        const ok = await api.deletePath(dirPath);
        if (ok) { showToast('已删除', 'success'); await buildTree(); if (currentDir) await loadDir(currentDir); }
      }
    }});
  }

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = `ctx-menu-item ${item.cls || ''}`;
      btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(btn);
    }
  }

  positionMenu(menu, e);
  closeMenuOnClick(menu);
}

function showFileContextMenu(e, entry) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = [];
  if (entry.isDir) {
    items.push({ icon: '📂', label: '打开', action: () => loadDir(entry.path) });
    items.push({ icon: '🪟', label: '在资源管理器中打开', action: () => api.openPath(entry.path) });
    items.push({ icon: '⬛', label: '在终端中打开', action: () => api.openTerminal(entry.path) });
    if (multiWindow) {
      items.splice(1, 0, { icon: '📑', label: '在新标签页打开', action: () => openTab(entry.path) });
    }
    if (multiWindow) {
      items.push({ icon: '🖥️', label: '在新窗口打开', action: () => api.openNewWindow(entry.path) });
    }
  } else {
    items.push({ icon: '🚀', label: '打开文件', action: () => api.openPath(entry.path) });
    items.push({ icon: '👁', label: '预览', action: () => openFileDetail(entry) });
    items.push({ icon: '📂', label: '打开所在文件夹', action: () => api.openPath(entry.path.replace(/[/\\][^/\\]+$/, '')) });
  }
  items.push({ icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(entry.path); showToast('路径已复制', 'success'); } });
  items.push({ icon: '📋', label: '复制文件名', action: () => { navigator.clipboard.writeText(entry.name); showToast('文件名已复制', 'success'); } });
  if (!entry.isDir) {
    const textExts = ['txt', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sql', 'py', 'js', 'ts', 'jsx', 'tsx', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'sh', 'bat', 'cmd', 'ps1', 'swift', 'kt', 'dart', 'lua', 'r'];
    const ext = entry.name.split('.').pop().toLowerCase();
    if (textExts.includes(ext)) {
      items.push({ icon: '🔍', label: '对比文件（文本）', action: () => startDiff(entry) });
    }
    items.push({ icon: '📝', label: '关联笔记', action: () => openNoteEditor(entry) });
  }
  if (!entry.isDir) {
    items.push({ sep: true });
    items.push({ icon: '💾', label: '备份到同目录', action: () => backupFile(entry) });
  }
  items.push({ icon: '📋', label: '复制', action: () => { clipboard = { action: 'copy', entry }; sysCopyFiles([entry]); showToast(`已复制: ${entry.name}`, 'success'); } });
  items.push({ icon: '✂️', label: '剪切', action: () => { clipboard = { action: 'cut', entry }; sysCopyFiles([entry]); showToast(`已剪切: ${entry.name}`, 'success'); } });
  if (clipboard) {
    const targetDir = entry.isDir ? entry.path : entry.path.replace(/[/\\][^/\\]+$/, '');
    items.push({ icon: '📌', label: '粘贴', action: () => pasteToFolder(targetDir) });
  } else {
    const targetDir = entry.isDir ? entry.path : entry.path.replace(/[/\\][^/\\]+$/, '');
    items.push({ icon: '📌', label: '粘贴', action: () => pasteFromSystemClipboard() });
  }
  items.push({ sep: true });
  items.push({ icon: '✏️', label: '重命名', action: () => renameEntry(entry) });
  items.push({ icon: '🗑️', label: '删除', cls: 'danger', action: () => deleteEntry(entry) });

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = `ctx-menu-item ${item.cls || ''}`;
      btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(btn);
    }
  }

  positionMenu(menu, e);
  closeMenuOnClick(menu);
}

async function backupFile(entry) {
  const dir = entry.path.replace(/[/\\][^/\\]+$/, '');
  const ext = entry.name.split('.').pop();
  const base = ext ? entry.name.slice(0, -(ext.length + 1)) : entry.name;
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const backupName = ext ? `${base}_备份_${ts}.${ext}` : `${base}_备份_${ts}`;
  const backupPath = `${dir}\\${backupName}`;

  const ok = await api.backupFile(entry.path, backupPath);
  if (ok) {
    showToast(`已备份: ${backupName}`, 'success');
    if (currentDir) await loadDir(currentDir);
  } else {
    showToast('备份失败', 'error');
  }
}

async function renameEntry(entry) {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '重命名';
  document.getElementById('modalBody').innerHTML = `
    <div class="form-group">
      <label>新名称</label>
      <input type="text" id="renameInput">
    </div>
  `;
  const renameInput = document.getElementById('renameInput');
  renameInput.value = entry.name;

  document.getElementById('modalFooter').innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);
  const renameBtn = document.createElement('button');
  renameBtn.className = 'modal-btn primary';
  renameBtn.textContent = '确定';
  renameBtn.addEventListener('click', async () => {
    const newName = renameInput.value.trim();
    if (!newName || newName === entry.name) return;
    const result = await api.renamePath(entry.path, newName);
    if (result) {
      closeModal();
      showToast('已重命名', 'success');
      if (currentDir) await loadDir(currentDir);
      await buildTree();
    }
  });
  document.getElementById('modalFooter').appendChild(cancelBtn);
  document.getElementById('modalFooter').appendChild(renameBtn);
  modal.classList.add('active');
  renameInput.focus();
  renameInput.select();
}

async function deleteEntry(entry) {
  if (!confirm(`确定删除 "${entry.name}" 吗？`)) return;
  const ok = await api.deletePath(entry.path);
  if (ok) {
    showToast('已删除', 'success');
    if (currentDir) await loadDir(currentDir);
    await buildTree();
  }
}

async function pasteToFolder(destDir) {
  if (!clipboard) return;
  const { action, entry } = clipboard;
  const fileName = entry.name;
  const destPath = `${destDir}\\${fileName}`;

  // 检查同名文件是否存在
  const pathInfo = await api.checkPath(destPath);
  if (pathInfo.exists) {
    if (!confirm(`目标位置已存在同名文件 "${fileName}"，是否覆盖？`)) return;
  }

  let ok;
  if (action === 'cut') {
    ok = await api.moveFile(entry.path, destPath);
    clipboard = null;
  } else {
    ok = await api.copyFile(entry.path, destPath);
  }

  if (ok) {
    showToast(action === 'cut' ? '已移动' : '已粘贴', 'success');
    if (currentDir) await loadDir(currentDir);
    await buildTree();
  } else {
    showToast('操作失败', 'error');
  }
}

async function pasteFromSystemClipboard() {
  if (!currentDir) return;
  const sysFiles = await sysPasteFiles();
  if (sysFiles.length === 0) {
    showToast('剪切板中没有文件', 'error');
    return;
  }

  let count = 0;
  let skipped = 0;
  for (const srcPath of sysFiles) {
    const fileName = srcPath.split(/[/\\]/).pop();
    const destPath = `${currentDir}\\${fileName}`;
    
    // 检查同名文件
    const pathInfo = await api.checkPath(destPath);
    if (pathInfo.exists) {
      if (!confirm(`目标位置已存在同名文件 "${fileName}"，是否覆盖？`)) {
        skipped++;
        continue;
      }
    }
    
    const ok = await api.copyFile(srcPath, destPath);
    if (ok) count++;
  }

  if (count > 0) {
    showToast(`已从资源管理器粘贴 ${count} 个文件`, 'success');
    if (currentDir) await loadDir(currentDir);
  } else if (skipped > 0) {
    showToast('已跳过重复文件', 'info');
  }
}

async function refresh() {
  if (!currentDir) return;
  // 记住哪些文件夹已展开
  const expanded = new Set();
  document.querySelectorAll('.tree-node-item').forEach(item => {
    const arrow = item.querySelector('.tree-arrow');
    const next = item.nextElementSibling;
    if (arrow && arrow.classList.contains('expanded') && next && next.classList.contains('tree-children')) {
      expanded.add(item.dataset.path);
    }
  });

  await loadDir(currentDir);
  await buildTree();

  // 恢复展开状态
  for (const path of expanded) {
    const node = document.querySelector(`.tree-node-item[data-path="${CSS.escape(path)}"]`);
    if (node) {
      const arrow = node.querySelector('.tree-arrow');
      const childrenEl = node.nextElementSibling;
      if (arrow && childrenEl && childrenEl.classList.contains('tree-children')) {
        if (childrenEl.querySelectorAll('.tree-node-item').length === 0) {
          const depth = (path.replace(workspaceDir, '').split(/[/\\]/).filter(Boolean).length);
          await loadChildren(childrenEl, path, depth, false);
        }
        childrenEl.style.display = 'block';
        arrow.classList.add('expanded');
      }
    }
  }

  showToast('已刷新', 'success');
}

function toggleSort(by) {
  const p = panels[activePanelIndex];
  if (!p) return;
  if (by === 'custom') {
    p.sortBy = 'custom';
  } else if (p.sortBy === by) {
    p.sortDir = p.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    p.sortBy = by;
    p.sortDir = 'asc';
  }
  if (p.currentDir) loadDir(p.currentDir, activePanelIndex);
}

// === 面包屑导航 ===
function updateBreadcrumb(dirPath, panelIdx) {
  if (panelIdx === undefined) panelIdx = activePanelIndex;
  const bc = document.getElementById('breadcrumb' + panelIdx);
  if (!bc) return;
  if (!workspaceDir || !dirPath) { bc.innerHTML = ''; return; }

  const rel = dirPath.replace(workspaceDir, '').replace(/[/\\]/, '').split(/[/\\]/).filter(Boolean);
  let html = `<span class="bc-item" data-path="${workspaceDir}">${workspaceDir.split(/[/\\]/).pop()}</span>`;

  let accum = workspaceDir;
  for (const part of rel) {
    accum += '\\' + part;
    html += `<span class="bc-sep">›</span><span class="bc-item" data-path="${accum}">${part}</span>`;
  }

  bc.innerHTML = html;
  const idx = panelIdx;
  bc.querySelectorAll('.bc-item').forEach(item => {
    item.addEventListener('click', () => {
      const p = item.dataset.path;
      loadDir(p, idx);
    });
  });
}

// === 文件夹备注 ===
const FOLDER_COLORS = [
  { name: '无', value: '' },
  { name: '红', value: '#ef4444' },
  { name: '橙', value: '#f97316' },
  { name: '黄', value: '#eab308' },
  { name: '绿', value: '#22c55e' },
  { name: '蓝', value: '#3b82f6' },
  { name: '紫', value: '#a855f7' },
  { name: '粉', value: '#ec4899' },
];

async function showFolderNoteModal(dirPath, dirName) {
  const meta = await api.getMeta(dirPath);
  const folderNote = meta.folderNote || '';
  const folderColor = meta.folderColor || '';

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = `文件夹备注 - ${dirName}`;
  
  let colorButtonsHtml = FOLDER_COLORS.map(c => 
    `<button class="color-pick-btn ${folderColor === c.value ? 'active' : ''}" data-color="${c.value}" style="background:${c.value || 'var(--bg-tertiary)'}; ${!c.value ? 'border:2px dashed var(--border);' : ''}">${c.name}</button>`
  ).join('');

  document.getElementById('modalBody').innerHTML = `
    <div class="form-group">
      <label>备注内容</label>
      <textarea id="folderNoteInput" rows="3" placeholder="输入文件夹备注...">${escapeHtml(folderNote)}</textarea>
    </div>
    <div class="form-group">
      <label>标记颜色</label>
      <div class="color-pick-row" id="colorPickRow">${colorButtonsHtml}</div>
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = '';

  let selectedColor = folderColor;
  document.getElementById('colorPickRow').addEventListener('click', (e) => {
    const btn = e.target.closest('.color-pick-btn');
    if (!btn) return;
    selectedColor = btn.dataset.color;
    document.querySelectorAll('.color-pick-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'modal-btn primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', async () => {
    const note = document.getElementById('folderNoteInput').value.trim();
    await api.saveMeta(dirPath, { ...meta, folderNote: note, folderColor: selectedColor });
    closeModal();
    showToast('已保存文件夹备注', 'success');
    await buildTree();
  });

  const clearBtn = document.createElement('button');
  clearBtn.className = 'modal-btn secondary';
  clearBtn.textContent = '清除';
  clearBtn.addEventListener('click', async () => {
    await api.saveMeta(dirPath, { ...meta, folderNote: '', folderColor: '' });
    closeModal();
    showToast('已清除文件夹备注', 'success');
    await buildTree();
  });

  document.getElementById('modalFooter').appendChild(clearBtn);
  document.getElementById('modalFooter').appendChild(cancelBtn);
  document.getElementById('modalFooter').appendChild(saveBtn);
  modal.classList.add('active');
}

// === 设置面板 ===
async function showSettings() {
  const settings = getSettings();
  const appVersion = await api.getAppVersion();
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '设置';
  document.getElementById('modalBody').innerHTML = `
    <div class="settings-group">
      <div class="settings-group-title">外观</div>
      <div class="settings-row">
        <label>主题</label>
        <select id="settingTheme"><option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>暗色</option><option value="light" ${settings.theme === 'light' ? 'selected' : ''}>亮色</option></select>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">目录树</div>
      <div class="settings-row">
        <label>自动收缩未浏览的文件夹</label>
        <div class="toggle-switch ${autoCollapse ? 'on' : ''}" id="settingAutoCollapse"></div>
      </div>
      <div class="settings-row">
        <label>多窗口模式</label>
        <div class="toggle-switch ${multiWindow ? 'on' : ''}" id="settingMultiWindow"></div>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">窗口行为</div>
      <div class="settings-row">
        <label>关闭时缩小到托盘</label>
        <div class="toggle-switch ${settings.closeToTray === true ? 'on' : ''}" id="settingCloseToTray"></div>
      </div>
      <div class="settings-row">
        <label style="font-size:11px;color:var(--text-muted);">关闭后询问</label>
        <button class="modal-btn secondary" id="resetCloseChoice" style="font-size:11px;padding:4px 10px;">重置</button>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">系统与操作任务</div>
      <div class="settings-row">
        <label>查看任务日志</label>
        <button class="modal-btn secondary" id="viewLogBtn" style="font-size:12px;padding:6px 12px;">查看日志</button>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">导入导出</div>
      <div class="settings-row">
        <label>导出配置</label>
        <button class="modal-btn secondary" id="exportConfigBtn" style="font-size:12px;padding:6px 12px;">导出</button>
      </div>
      <div class="settings-row">
        <label>导入配置</label>
        <button class="modal-btn secondary" id="importConfigBtn" style="font-size:12px;padding:6px 12px;">导入</button>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">API 服务 (供 AI Agent 调用)</div>
      <div class="settings-row">
        <label>服务状态</label>
        <span id="apiStatus" style="font-size:12px;color:var(--success);">运行中 :${settings.apiPort || 5000}</span>
      </div>
      <div class="settings-row">
        <button class="modal-btn secondary" style="width:100%;" id="openApiSettingsBtn">API 服务设置</button>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">快捷键</div>
      <div class="settings-row">
        <label>自定义快捷键</label>
        <button class="modal-btn secondary" id="openShortcutSettingsBtn" style="font-size:12px;padding:6px 12px;">配置</button>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">主目录</div>
      <div class="settings-row">
        <label>当前主目录</label>
        <span style="font-size:11px;color:var(--text-muted);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${workspaceDir || ''}">${workspaceDir ? workspaceDir.split(/[/\\]/).pop() : '未设置'}</span>
      </div>
      <div class="settings-row">
        <button class="modal-btn primary" style="width:100%;" onclick="closeModal();window._setWorkspace();">更换主目录</button>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">关于</div>
      <div class="settings-row">
        <label>版本</label>
        <span style="font-size:12px;color:var(--text-secondary);">v${appVersion}</span>
      </div>
      <div class="settings-row">
        <label>作者</label>
        <span style="font-size:12px;color:var(--text-secondary);">EZdrang</span>
      </div>
      <div class="settings-row">
        <button class="modal-btn secondary" style="width:100%;" id="checkUpdateBtn">检查更新</button>
      </div>
      <div id="updateResult" style="font-size:11px;color:var(--text-muted);text-align:center;padding:4px;"></div>
    </div>
  `;

  document.getElementById('viewLogBtn').addEventListener('click', showLogViewer);
  document.getElementById('exportConfigBtn').addEventListener('click', exportConfig);
  document.getElementById('importConfigBtn').addEventListener('click', importConfig);
  document.getElementById('openApiSettingsBtn').addEventListener('click', showApiSettings);
  document.getElementById('openShortcutSettingsBtn').addEventListener('click', showShortcutSettings);
  
  document.getElementById('checkUpdateBtn').addEventListener('click', async () => {
    const btn = document.getElementById('checkUpdateBtn');
    const result = document.getElementById('updateResult');
    btn.textContent = '检查中...';
    btn.disabled = true;
    result.textContent = '';
    
    const info = await api.checkUpdate();
    btn.textContent = '检查更新';
    btn.disabled = false;
    
    if (info.error) {
      result.textContent = `检查失败: ${info.error}`;
      result.style.color = 'var(--danger)';
    } else if (info.hasUpdate) {
      result.innerHTML = `发现新版本 v${info.latestVersion}，<a href="#" onclick="require('electron').shell.openExternal('${info.releaseUrl}');return false;" style="color:var(--accent);">前往下载</a>`;
      result.style.color = 'var(--success)';
    } else {
      result.textContent = `已是最新版本 v${info.currentVersion}`;
      result.style.color = 'var(--success)';
    }
  });

  const toggleEl = document.getElementById('settingAutoCollapse');
  toggleEl.addEventListener('click', function(e) { e.stopPropagation(); this.classList.toggle('on'); });

  const mwToggle = document.getElementById('settingMultiWindow');
  mwToggle.addEventListener('click', function(e) { e.stopPropagation(); this.classList.toggle('on'); });

  const ctToggle = document.getElementById('settingCloseToTray');
  ctToggle.addEventListener('click', function(e) { e.stopPropagation(); this.classList.toggle('on'); });

  document.getElementById('resetCloseChoice').addEventListener('click', () => {
    const s = getSettings(); delete s.closeToTray; localStorage.setItem('settings', JSON.stringify(s));
    showToast('已重置，关闭时将再次询问', 'success');
  });

  document.getElementById('modalFooter').innerHTML = '';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn secondary';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeModal);
  const saveBtn = document.createElement('button');
  saveBtn.className = 'modal-btn primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', saveSettings);
  document.getElementById('modalFooter').appendChild(cancelBtn);
  document.getElementById('modalFooter').appendChild(saveBtn);

  modal.classList.add('active');
}

window._setWorkspace = setWorkspace;

async function exportConfig() {
  const ok = await api.exportConfig();
  if (ok) showToast('配置已导出', 'success');
  else showToast('导出失败', 'error');
}

async function importConfig() {
  const data = await api.importConfig();
  if (data) {
    showToast('配置已导入，重启后生效', 'success');
    // 重新加载设置
    loadSettings();
    applyTheme(getSettings().theme || 'dark');
    if (data.workspace) {
      workspaceDir = data.workspace;
      currentDir = data.workspace;
    }
    if (data.linkedFolders) linkedFolders = data.linkedFolders;
    await buildTree();
    if (currentDir) await loadDir(currentDir);
    updateTitle();
  } else {
    showToast('导入失败', 'error');
  }
}

async function showLogViewer() {
  closeModal();
  const logContent = await api.getLog(500);
  const logSize = await api.getLogSize();
  const sizeStr = formatSize(logSize);

  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '系统与操作任务';
  document.getElementById('modalBody').innerHTML = `
    <div style="margin-bottom:8px;font-size:12px;color:var(--text-muted);">
      日志文件: .资料管理系统.log | 大小: ${sizeStr} / 5.0 MB
    </div>
    <pre id="logContentPre" tabindex="0" style="background:var(--bg-tertiary);padding:12px;border-radius:8px;max-height:400px;overflow:auto;font-size:12px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-all;outline:none;user-select:text;cursor:text;">${logContent || '暂无日志'}</pre>
  `;

  // Right-click context menu for log area
  const logPre = document.getElementById('logContentPre');
  logPre.addEventListener('contextmenu', (e) => {
    const sel = window.getSelection().toString();
    const existing = document.querySelector('.context-menu');
    if (existing) existing.remove();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    const items = [];
    if (sel) {
      items.push({ icon: '📋', label: '复制选中', action: () => { navigator.clipboard.writeText(sel); showToast('已复制选中内容', 'success'); } });
    }
    items.push({ icon: '📄', label: '复制全部', action: () => { navigator.clipboard.writeText(logContent || ''); showToast('已复制全部日志', 'success'); } });
    items.push({ icon: '📎', label: '全选', action: () => { const r = document.createRange(); r.selectNodeContents(logPre); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } });
    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'ctx-menu-item';
      btn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(btn);
    }
    positionMenu(menu, e);
    closeMenuOnClick(menu);
  });

  // 日志查看器键盘快捷键
  logPre.addEventListener('keydown', (e) => {
    if (e.ctrlKey) {
      if (e.key === 'a') {
        e.preventDefault();
        const r = document.createRange();
        r.selectNodeContents(logPre);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
      if (e.key === 'c') {
        const sel = window.getSelection().toString();
        if (sel) {
          e.preventDefault();
          navigator.clipboard.writeText(sel);
          showToast('已复制', 'success');
        }
      }
    }
  });

  document.getElementById('modalFooter').innerHTML = '';
  const copyAllBtn = document.createElement('button');
  copyAllBtn.className = 'modal-btn secondary';
  copyAllBtn.textContent = '复制全部';
  copyAllBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(logContent || '');
    showToast('已复制全部日志', 'success');
  });
  const clearBtn = document.createElement('button');
  clearBtn.className = 'modal-btn secondary';
  clearBtn.textContent = '清空日志';
  clearBtn.addEventListener('click', async () => {
    await api.clearLog();
    showToast('日志已清空', 'success');
    showLogViewer();
  });
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-btn primary';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', closeModal);
  document.getElementById('modalFooter').appendChild(copyAllBtn);
  document.getElementById('modalFooter').appendChild(clearBtn);
  document.getElementById('modalFooter').appendChild(closeBtn);
  modal.classList.add('active');
}

function getSettings() {
  try { return JSON.parse(localStorage.getItem('settings') || '{}'); } catch (e) { return {}; }
}

function loadSettings() {
  const s = getSettings();
  if (s.theme) applyTheme(s.theme);
  if (s.autoCollapse !== undefined) autoCollapse = s.autoCollapse;
  if (s.multiWindow !== undefined) multiWindow = s.multiWindow;
}

async function saveSettings() {
  const s = {
    theme: document.getElementById('settingTheme').value,
    autoCollapse: document.getElementById('settingAutoCollapse').classList.contains('on'),
    multiWindow: document.getElementById('settingMultiWindow').classList.contains('on'),
    closeToTray: document.getElementById('settingCloseToTray').classList.contains('on'),
    apiPort: parseInt(document.getElementById('settingApiPort')?.value) || getSettings().apiPort || 5000
  };
  localStorage.setItem('settings', JSON.stringify(s));
  
  // 保存API端口到config.json
  if (s.apiPort) {
    await api.saveApiPort(s.apiPort);
  }
  
  autoCollapse = s.autoCollapse;
  multiWindow = s.multiWindow;
  applyTheme(s.theme);
  renderTabs();
  closeModal();
  showToast('设置已保存', 'success');
}

function showAbout() {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '关于';
  document.getElementById('modalBody').innerHTML = `
    <div style="text-align:center;padding:20px;">
      <div style="font-size:48px;margin-bottom:16px;">📁</div>
      <h3 style="margin-bottom:8px;">资料管理系统</h3>
      <p style="color:var(--text-muted);font-size:13px;margin-top:8px;">现代化本地文件管理工具</p>
      <p style="color:var(--text-muted);font-size:13px;">EZdrang 出品</p>
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = `<button class="modal-btn primary" onclick="closeModal()">确定</button>`;
  modal.classList.add('active');
}

function showApiDocs() {
  const port = getSettings().apiPort || 5000;
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = 'API 文档 (供 AI Agent 调用)';
  document.getElementById('modalBody').innerHTML = `
    <div class="api-docs-content">
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">基础地址: <code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;">http://127.0.0.1:${port}</code></p>
      <div style="margin-bottom:16px;">
        <h4 style="font-size:13px;color:var(--accent);margin-bottom:8px;">GET 端点</h4>
        <pre style="background:var(--bg-tertiary);padding:12px;border-radius:8px;font-size:11px;color:var(--text-secondary);white-space:pre-wrap;line-height:1.6;user-select:text;cursor:text;">GET /api/health          健康检查
GET /api/workspace       工作目录信息
GET /api/files           列出文件 (?path=&depth=)
GET /api/files/*         读取文件/目录 (?info=1)
GET /api/stats           统计信息 (?path=)
GET /api/docs            本页文档</pre>
      </div>
      <div style="margin-bottom:16px;">
        <h4 style="font-size:13px;color:var(--accent);margin-bottom:8px;">POST 端点</h4>
        <pre style="background:var(--bg-tertiary);padding:12px;border-radius:8px;font-size:11px;color:var(--text-secondary);white-space:pre-wrap;line-height:1.6;user-select:text;cursor:text;">POST /api/search         搜索 {keyword, maxResults}
POST /api/meta           获取标签 {path}
POST /api/create-folder  新建文件夹 {path, name}
POST /api/delete         删除 {path}
POST /api/rename         重命名 {path, newName}</pre>
      </div>
      <div style="margin-bottom:16px;">
        <h4 style="font-size:13px;color:var(--accent);margin-bottom:8px;">PUT 端点</h4>
        <pre style="background:var(--bg-tertiary);padding:12px;border-radius:8px;font-size:11px;color:var(--text-secondary);white-space:pre-wrap;line-height:1.6;user-select:text;cursor:text;">PUT /api/meta            保存标签 {path, tags, notes}</pre>
      </div>
      <div>
        <h4 style="font-size:13px;color:var(--accent);margin-bottom:8px;">调用示例</h4>
        <pre style="background:var(--bg-tertiary);padding:12px;border-radius:8px;font-size:11px;color:var(--text-secondary);white-space:pre-wrap;line-height:1.6;user-select:text;cursor:text;"># EZdrang / Claude Code 调用
curl http://127.0.0.1:${port}/api/workspace

# 搜索文件
curl -X POST http://127.0.0.1:${port}/api/search \\
  -H "Content-Type: application/json" \\
  -d '{"keyword": "main.js"}'

# 读取文件内容
curl http://127.0.0.1:${port}/api/files/main.js

# 给文件打标签
curl -X PUT http://127.0.0.1:${port}/api/meta \\
  -H "Content-Type: application/json" \\
  -d '{"path": "main.js", "tags": "重要,核心"}'</pre>
      </div>
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = `<button class="modal-btn primary" onclick="closeModal()">关闭</button>`;
  modal.classList.add('active');
}

function showApiSettings() {
  const settings = getSettings();
  const port = settings.apiPort || 5000;
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = 'API 服务设置';
  document.getElementById('modalBody').innerHTML = `
    <div class="settings-group">
      <div class="settings-group-title">服务配置</div>
      <div class="settings-row">
        <label>端口号</label>
        <input type="text" id="settingApiPortDetail" value="${port}" style="width:100px;text-align:center;">
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">修改端口需重启软件生效</div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">服务信息</div>
      <div class="settings-row">
        <label>基础地址</label>
        <code style="background:var(--bg-tertiary);padding:2px 6px;border-radius:4px;font-size:12px;">http://127.0.0.1:${port}</code>
      </div>
      <div class="settings-row">
        <label>允许来源</label>
        <span style="font-size:12px;color:var(--text-secondary);">* (全部)</span>
      </div>
      <div class="settings-row">
        <label>端点数量</label>
        <span style="font-size:12px;color:var(--text-secondary);">12 个</span>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">端点列表</div>
      <pre style="background:var(--bg-tertiary);padding:12px;border-radius:8px;font-size:11px;color:var(--text-secondary);white-space:pre-wrap;line-height:1.8;max-height:200px;overflow:auto;user-select:text;cursor:text;">GET  /api/health          健康检查
GET  /api/workspace       工作目录信息
GET  /api/files           列出文件
GET  /api/files/*         读取文件内容
GET  /api/stats           统计信息
GET  /api/docs            API文档
POST /api/search          搜索文件
POST /api/meta            获取标签
PUT  /api/meta            保存标签
POST /api/create-folder   新建文件夹
POST /api/delete          删除
POST /api/rename          重命名</pre>
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = '';
  const docsBtn = document.createElement('button');
  docsBtn.className = 'modal-btn secondary';
  docsBtn.textContent = '查看完整文档';
  docsBtn.addEventListener('click', () => { closeModal(); showApiDocs(); });
  const saveBtn = document.createElement('button');
  saveBtn.className = 'modal-btn primary';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => {
    const s = getSettings();
    s.apiPort = parseInt(document.getElementById('settingApiPortDetail').value) || 5000;
    localStorage.setItem('settings', JSON.stringify(s));
    closeModal();
    showToast('API端口已保存，重启后生效', 'success');
  });
  document.getElementById('modalFooter').appendChild(docsBtn);
  document.getElementById('modalFooter').appendChild(saveBtn);
  modal.classList.add('active');
}

function closeModal() { document.getElementById('modal').classList.remove('active'); }

function closeFullscreen() {
  const overlay = document.getElementById('fullscreenOverlay');
  overlay.style.display = 'none';
  document.getElementById('fullscreenContent').innerHTML = '';
}

function initPreviewRotate() {
  const bar = document.querySelector('.preview-rotate-bar');
  if (!bar) return;
  const container = document.getElementById('previewZoom');
  const img = container?.querySelector('img');
  if (!img) return;
  window._previewRotation = 0;

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.preview-rotate-btn');
    if (!btn) return;
    window._previewRotation = (window._previewRotation + parseInt(btn.dataset.deg)) % 360;
    if (window._previewRotation < 0) window._previewRotation += 360;
    img.style.transition = 'transform 0.3s ease';
    img.style.transformOrigin = 'center center';
    img.style.transform = `rotate(${window._previewRotation}deg)`;
  });
}

async function loadExifInfo(filePath, previewArea) {
  const exif = await api.readExif(filePath);
  if (!exif) return;
  
  // 在详情面板的备注区域上方显示
  const detailPanel = document.getElementById('detailPanel');
  // 移除旧的 EXIF 面板
  const oldExif = document.getElementById('exifPanel');
  if (oldExif) oldExif.remove();
  
  let exifHtml = '';
  for (const [key, val] of Object.entries(exif)) {
    exifHtml += `<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;"><span style="color:var(--text-muted);">${key}</span><span>${escapeHtml(String(val))}</span></div>`;
  }
  
  const exifPanel = document.createElement('div');
  exifPanel.id = 'exifPanel';
  exifPanel.style.cssText = 'margin:0 16px;padding:8px 12px;background:var(--bg-tertiary);border-radius:8px;';
  exifPanel.innerHTML = `<div style="font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-muted);">📷 EXIF 信息</div>${exifHtml}`;
  
  const editSection = detailPanel.querySelector('.edit-section');
  if (editSection) {
    editSection.parentNode.insertBefore(exifPanel, editSection);
  }
}

function initPreviewZoom() {
  const container = document.getElementById('previewZoom');
  if (!container) return;
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let startX, startY;

  const applyTransform = () => {
    const inner = container.firstElementChild;
    if (inner) {
      const rot = window._previewRotation || 0;
      inner.style.transform = `rotate(${rot}deg) scale(${scale}) translate(${panX}px, ${panY}px)`;
      inner.style.transition = isPanning ? 'none' : 'transform 0.15s ease';
    }
  };

  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    scale = Math.min(Math.max(0.2, scale + delta), 5);
    if (scale <= 1) { panX = 0; panY = 0; }
    applyTransform();
  });

  container.addEventListener('mousedown', (e) => {
    if (scale <= 1) return;
    isPanning = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
    container.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    panX = (e.clientX - startX) * 0.5;
    panY = (e.clientY - startY) * 0.5;
    applyTransform();
  });

  document.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      container.style.cursor = scale > 1 ? 'grab' : 'default';
    }
  });

  container.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    scale = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  });

  container.style.cursor = 'default';
}

function showCloseDialog() {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = '关闭确认';
  document.getElementById('modalBody').innerHTML = `
    <div style="text-align:center;padding:10px 0;">
      <p style="font-size:14px;color:var(--text-primary);margin-bottom:16px;">选择关闭方式</p>
      <label style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;color:var(--text-secondary);cursor:pointer;">
        <input type="checkbox" id="closeRememberChoice"> 不再询问，记住选择
      </label>
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = '';
  const hideBtn = document.createElement('button');
  hideBtn.className = 'modal-btn secondary';
  hideBtn.textContent = '缩小到托盘';
  hideBtn.addEventListener('click', () => {
    const remember = document.getElementById('closeRememberChoice').checked;
    if (remember) {
      const s = getSettings(); s.closeToTray = true; localStorage.setItem('settings', JSON.stringify(s));
    }
    closeModal();
    api.hideToTray();
    showToast('已缩小到托盘', 'success');
  });
  const quitBtn = document.createElement('button');
  quitBtn.className = 'modal-btn primary';
  quitBtn.textContent = '关闭软件';
  quitBtn.addEventListener('click', () => {
    const remember = document.getElementById('closeRememberChoice').checked;
    if (remember) {
      const s = getSettings(); s.closeToTray = false; localStorage.setItem('settings', JSON.stringify(s));
    }
    closeModal();
    api.quitApp();
  });
  document.getElementById('modalFooter').appendChild(hideBtn);
  document.getElementById('modalFooter').appendChild(quitBtn);
  modal.classList.add('active');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✓' : '✕'}</span> ${message}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function getFileIcon(type) {
  const icons = {
    png: '🖼', jpg: '📷', jpeg: '📷', gif: '🎞', bmp: '🖼', webp: '🌐', ico: '🔷',
    svg: '✏', tiff: '🖼', tif: '🖼', psd: '🎨', ai: '🎨',
    txt: '📄', md: '📝', log: '📋', rtf: '📄', csv: '📊',
    py: '🐍', js: '📜', ts: '📜', jsx: '⚛', tsx: '⚛',
    java: '☕', c: '⚙', cpp: '⚙', h: '⚙', cs: '🔷', go: '🔵', rs: '🦀', rb: '💎', php: '🐘',
    html: '🌐', htm: '🌐', css: '🎨', scss: '🎨', less: '🎨', vue: '💚',
    json: '📋', xml: '📋', yaml: '📋', yml: '📋', toml: '📋',
    sql: '🗄',
    pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵',
    mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬', wmv: '🎬',
    ttf: '🔤', otf: '🔤', woff: '🔤',
    exe: '⚡', msi: '⚡', bat: '🖥', cmd: '🖥', sh: '🖥',
  };
  return icons[type] || '📄';
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function highlightScript(code, ext) {
  let html = escapeHtml(code);

  // 注释
  if (ext === 'sh') {
    html = html.replace(/(#[^\n]*)/g, '<span style="color:#6a9955;">$1</span>');
  } else if (ext === 'bat' || ext === 'cmd') {
    html = html.replace(/^(\s*rem\s[^\n]*)/gim, '<span style="color:#6a9955;">$1</span>');
    html = html.replace(/^(\s*::[^\n]*)/gim, '<span style="color:#6a9955;">$1</span>');
  } else if (ext === 'ps1') {
    html = html.replace(/(#[^\n]*)/g, '<span style="color:#6a9955;">$1</span>');
  }

  // 字符串
  html = html.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|"[^"]*?"|'[^']*?')/g, '<span style="color:#ce9178;">$1</span>');

  // 关键字
  const keywords = ext === 'sh'
    ? ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'exit', 'echo', 'read', 'export', 'source', 'local', 'in']
    : ext === 'ps1'
    ? ['if', 'else', 'elseif', 'for', 'while', 'do', 'until', 'function', 'filter', 'param', 'return', 'break', 'continue', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'throw', 'New-Object', 'Write-Host', 'Set-Location', 'Get-ChildItem']
    : ['if', 'else', 'for', 'goto', 'call', 'echo', 'set', 'exit', 'pause', 'title', 'cls', 'cd', 'dir', 'copy', 'move', 'del', 'ren', 'md', 'rd', 'type', 'find', 'findstr', 'start', 'choice', 'setlocal', 'endlocal', 'enabledelayedexpansion', 'errorlevel', 'not', 'exist', 'defined'];

  const kwRegex = new RegExp('\\b(' + keywords.join('|') + ')\\b', 'gi');
  html = html.replace(kwRegex, '<span style="color:#569cd6;">$1</span>');

  // 变量
  if (ext === 'sh') {
    html = html.replace(/(\$\w+|\$\{[^}]+\})/g, '<span style="color:#4ec9b0;">$1</span>');
  } else if (ext === 'ps1') {
    html = html.replace(/(\$\w+)/g, '<span style="color:#4ec9b0;">$1</span>');
  } else {
    html = html.replace(/(%\w+%)/g, '<span style="color:#4ec9b0;">$1</span>');
  }

  return html;
}

function linkifyText(text) {
  const urlRegex = /(https?:\/\/[^\s<>"')\]]+)/g;
  return text.replace(urlRegex, (url) => {
    const cleanUrl = url.replace(/[.,;:!?)\]]+$/, '');
    return `<a class="text-link" data-url="${cleanUrl}" href="#" style="color:var(--accent);text-decoration:underline;cursor:pointer;">${url}</a>`;
  });
}

function getTagColor(tag) {
  const colors = [
    { bg: '#fee2e2', text: '#dc2626' },
    { bg: '#fef3c7', text: '#d97706' },
    { bg: '#d1fae5', text: '#059669' },
    { bg: '#dbeafe', text: '#2563eb' },
    { bg: '#ede9fe', text: '#7c3aed' },
    { bg: '#fce7f3', text: '#db2777' },
    { bg: '#ccfbf1', text: '#0d9488' },
    { bg: '#fef9c3', text: '#ca8a04' },
    { bg: '#e0e7ff', text: '#4f46e5' },
    { bg: '#f3e8ff', text: '#9333ea' },
    { bg: '#ffe4e6', text: '#e11d48' },
    { bg: '#ecfdf5', text: '#047857' },
    { bg: '#f0f9ff', text: '#0369a1' },
    { bg: '#fdf4ff', text: '#a21caf' },
    { bg: '#fff7ed', text: '#c2410c' },
  ];
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function renderTags(tagsStr) {
  if (!tagsStr) return '';
  const tags = tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean);
  if (tags.length === 0) return '';
  return tags.map(t => {
    const c = getTagColor(t);
    return `<span class="tag-badge" style="background:${c.bg};color:${c.text};">${t}</span>`;
  }).join('');
}

// === 主题系统 ===
function initTheme() { applyTheme(getSettings().theme || 'dark'); }

function toggleTheme() {
  const next = (localStorage.getItem('theme') || 'dark') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  const s = getSettings(); s.theme = next; localStorage.setItem('settings', JSON.stringify(s));
  applyTheme(next);
}

function applyTheme(theme) {
  const tb = document.querySelector('.titlebar');
  const mb = document.querySelector('.menubar');
  const tt = document.querySelector('.titlebar-title');
  const btns = document.querySelectorAll('.titlebar-btn');
  const cb = document.querySelector('.titlebar-btn.close');
  if (!tb) return;

  if (theme === 'light') {
    document.body.classList.add('light-theme');
    document.getElementById('themeIcon').textContent = '☀️';
    document.getElementById('themeText').textContent = '亮色主题';
    tb.style.background = '#ffffff'; tb.style.borderBottom = '1px solid #d2d2d7';
    if (mb) { mb.style.background = '#ffffff'; mb.style.borderBottom = '1px solid #d2d2d7'; }
    tt.style.color = '#515154'; btns.forEach(b => b.style.color = '#515154');
    cb.onmouseover = function () { this.style.background = '#ef4444'; this.style.color = 'white'; };
    cb.onmouseout = function () { this.style.background = 'transparent'; this.style.color = '#515154'; };
  } else {
    document.body.classList.remove('light-theme');
    document.getElementById('themeIcon').textContent = '🌙';
    document.getElementById('themeText').textContent = '暗色主题';
    tb.style.background = '#12121a'; tb.style.borderBottom = '1px solid #2a2a3a';
    if (mb) { mb.style.background = '#12121a'; mb.style.borderBottom = '1px solid #2a2a3a'; }
    tt.style.color = '#a0a0b0'; btns.forEach(b => b.style.color = '#a0a0b0');
    cb.onmouseover = function () { this.style.background = '#ef4444'; this.style.color = 'white'; };
    cb.onmouseout = function () { this.style.background = 'transparent'; this.style.color = '#a0a0b0'; };
  }
  document.body.style.background = theme === 'light' ? '#f5f5f7' : '#0a0a0f';
}

window.closeModal = closeModal;
window.saveSettings = saveSettings;
window._toast = showToast;

// === 首次运行向导 ===
let wizardStep = 1;
let wizardWorkspace = null;
let wizardImported = false;
let wizardTheme = 'dark';

api.onCheckFirstRun && api.onCheckFirstRun((isFirstRun) => {
  if (isFirstRun) showWizard();
});

function showWizard() {
  document.getElementById('wizardOverlay').style.display = 'flex';
  wizardStep = 1;
  wizardWorkspace = null;
  wizardImported = false;
  wizardTheme = 'dark';
  updateWizardUI();
}

function hideWizard() {
  document.getElementById('wizardOverlay').style.display = 'none';
}

function updateWizardUI() {
  document.querySelectorAll('.wizard-step').forEach(s => s.classList.remove('active'));
  const step = document.querySelector(`.wizard-step[data-step="${wizardStep}"]`);
  if (step) step.classList.add('active');

  document.querySelectorAll('.wizard-dots .dot').forEach((d, i) => {
    d.classList.toggle('active', i === wizardStep - 1);
  });

  const prev = document.getElementById('wizardPrev');
  const next = document.getElementById('wizardNext');
  prev.style.visibility = wizardStep === 1 ? 'hidden' : 'visible';

  if (wizardStep === 5) {
    next.textContent = '开始使用';
    const summary = document.getElementById('wizardSummary');
    summary.innerHTML = `
      <div><strong>工作目录:</strong> ${wizardWorkspace || '未设置'}</div>
      <div><strong>导入配置:</strong> ${wizardImported ? '已导入' : '跳过'}</div>
      <div><strong>主题:</strong> ${wizardTheme === 'dark' ? '暗色' : '亮色'}</div>
    `;
  } else {
    next.textContent = '下一步';
  }
}

document.getElementById('wizardNext').addEventListener('click', () => {
  if (wizardStep === 5) {
    finishWizard();
    return;
  }
  if (wizardStep === 2 && !wizardWorkspace) {
    showToast('请先选择工作目录', 'error');
    return;
  }
  wizardStep++;
  updateWizardUI();
});

document.getElementById('wizardPrev').addEventListener('click', () => {
  if (wizardStep > 1) { wizardStep--; updateWizardUI(); }
});

function wizardSelectDirHandler() {
  api.setWorkspace().then(dir => {
    if (dir) {
      wizardWorkspace = dir;
      const area = document.getElementById('wizardWorkspaceArea');
      area.innerHTML = `<p class="wizard-workspace-path">${dir}</p><button class="wizard-btn secondary" id="wizardSelectDir">更换目录</button>`;
      document.getElementById('wizardSelectDir').addEventListener('click', wizardSelectDirHandler);
    }
  });
}
document.getElementById('wizardSelectDir').addEventListener('click', wizardSelectDirHandler);

document.getElementById('wizardImportConfig').addEventListener('click', wizardImportHandler);

function wizardImportHandler() {
  api.importConfig().then(data => {
    if (data) {
      wizardImported = true;
      document.querySelector('.wizard-import-area').innerHTML = `
        <p class="wizard-import-status">✓ 配置已导入成功</p>
        <button class="wizard-btn secondary" id="wizardImportConfig">重新选择</button>
      `;
      document.getElementById('wizardImportConfig').addEventListener('click', wizardImportHandler);
    }
  });
}

document.getElementById('wizardThemeDark').addEventListener('click', () => {
  wizardTheme = 'dark';
  document.getElementById('wizardThemeDark').classList.add('active');
  document.getElementById('wizardThemeLight').classList.remove('active');
});

document.getElementById('wizardThemeLight').addEventListener('click', () => {
  wizardTheme = 'light';
  document.getElementById('wizardThemeLight').classList.add('active');
  document.getElementById('wizardThemeDark').classList.remove('active');
});

async function finishWizard() {
  // 重置所有设置为默认值
  const s = {
    theme: wizardTheme,
    autoCollapse: true,
    multiWindow: false,
    closeToTray: null,
    apiPort: 5000
  };
  localStorage.setItem('settings', JSON.stringify(s));
  
  applyTheme(s.theme);
  autoCollapse = s.autoCollapse;
  multiWindow = s.multiWindow;

  if (wizardWorkspace) {
    workspaceDir = wizardWorkspace;
    currentDir = wizardWorkspace;
    expandedDirs.clear();
    document.getElementById('emptyHint').style.display = 'none';
    document.getElementById('fileTree').style.display = 'block';
    workspaces = await api.getWorkspaces();
    buildTree().then(() => {
      expandTreeToPath(wizardWorkspace);
      highlightTreeNode(wizardWorkspace);
      tabs = [{ path: wizardWorkspace, name: wizardWorkspace.split(/[/\\]/).pop() || '根目录', scrollY: 0 }];
      activeTabIndex = 0;
      renderTabs();
      loadDir(wizardWorkspace);
      updateTitle();
    });
  }

  hideWizard();
  showToast('设置完成，欢迎使用！', 'success');
}
