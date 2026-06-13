const api = window.electronAPI;

let workspaceDir = null;
let currentDir = null;
let currentFile = null;
let fileList = [];
let expandedDirs = new Set();
let sortBy = 'name';
let sortDir = 'asc';
let searchTimeout = null;
let linkedFolders = [];
let dirHistory = [];
let historyIndex = -1;
let autoCollapse = true;
let clipboard = null; // { action: 'copy'|'cut', entry: {...} }
let multiWindow = false;
let tabs = [];
let activeTabIndex = -1;

async function sysCopyFiles(entries) {
  const paths = entries.map(e => e.path);
  await api.clipboardWriteFiles(paths);
}

async function sysPasteFiles() {
  const sysFiles = await api.clipboardReadFiles();
  return sysFiles;
}

document.addEventListener('DOMContentLoaded', async () => {
  initEventListeners();
  initTheme();
  loadSettings();
  initTabBar();

  // Listen for close action from main process
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
    await buildTree();
    tabs = [{ path: workspaceDir, name: workspaceDir.split(/[/\\]/).pop() || '根目录', scrollY: 0 }];
    activeTabIndex = 0;
    renderTabs();
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
});

function initEventListeners() {
  document.getElementById('minimize').addEventListener('click', () => api.minimize());
  document.getElementById('maximize').addEventListener('click', () => api.maximize());
  document.getElementById('close').addEventListener('click', () => api.close());

  document.getElementById('newFolderBtn').addEventListener('click', linkNewFolder);
  document.getElementById('settingsBtn').addEventListener('click', showSettings);
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  document.getElementById('setWorkspaceHint').addEventListener('click', setWorkspace);
  document.getElementById('backBtn').addEventListener('click', goBack);

  document.getElementById('menuSetWorkspace').addEventListener('click', setWorkspace);
  document.getElementById('menuOpenFolder').addEventListener('click', () => { if (currentDir) api.openPath(currentDir); });
  document.getElementById('menuNewFolder').addEventListener('click', createNewFolder);
  document.getElementById('menuRename').addEventListener('click', renameSelected);
  document.getElementById('menuDelete').addEventListener('click', deleteSelected);
  document.getElementById('menuCopyPath').addEventListener('click', copyPath);
  document.getElementById('menuRefresh').addEventListener('click', refresh);
  document.getElementById('menuSortName').addEventListener('click', () => toggleSort('name'));
  document.getElementById('menuSortSize').addEventListener('click', () => toggleSort('size'));
  document.getElementById('menuSortDate').addEventListener('click', () => toggleSort('modified'));
  document.getElementById('menuAbout').addEventListener('click', showAbout);

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
        try { await advancedSearch(q); } catch (e) { console.error('Search error:', e); }
      }, 300);
    } else {
      clearSearchHighlight();
      if (currentDir) loadDir(currentDir);
    }
  });

  document.getElementById('searchClear').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    clearSearchHighlight();
    if (currentDir) loadDir(currentDir);
  });

  document.getElementById('searchInput').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    document.getElementById('searchInput').value = '';
    clearSearchHighlight();
    if (currentDir) loadDir(currentDir);
  });

  document.addEventListener('contextmenu', (e) => {
    // Any pre element (preview area, modal docs, API settings, log viewer)
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
    currentFile = null;
  });

  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  document.addEventListener('keydown', async (e) => {
    if (e.target.closest('input,textarea,pre,#logContentPre')) return;

    if (e.key === 'F5') { e.preventDefault(); refresh(); }
    if (e.key === 'F2') { e.preventDefault(); renameSelected(); }
    if (e.key === 'Delete') { deleteSelected(); }
    if (e.key === 'Backspace') { e.preventDefault(); goBack(); }
    if (e.key === 'Enter') {
      const sel = document.querySelector('.file-table tbody tr.selected');
      if (sel) {
        const entry = fileList.find(f => f.path === sel.dataset.path);
        if (entry) {
          if (entry.isDir) loadDir(entry.path);
          else api.openPath(entry.path);
        }
      }
    }
    if (e.key === 'Escape') { document.getElementById('detailPanel').style.display = 'none'; currentFile = null; }

    if (e.ctrlKey) {
      if (e.key === 'n') { e.preventDefault(); createNewFolder(); }
      if (e.key === 'c') {
        const sel = document.querySelector('.file-table tbody tr.selected');
        if (sel) {
          const entry = fileList.find(f => f.path === sel.dataset.path);
          if (entry) {
            clipboard = { action: 'copy', entry };
            sysCopyFiles([entry]);
            showToast(`已复制: ${entry.name}`, 'success');
          }
        }
      }
      if (e.key === 'x') {
        const sel = document.querySelector('.file-table tbody tr.selected');
        if (sel) {
          const entry = fileList.find(f => f.path === sel.dataset.path);
          if (entry) {
            clipboard = { action: 'cut', entry };
            sysCopyFiles([entry]);
            showToast(`已剪切: ${entry.name}`, 'success');
          }
        }
      }
      if (e.key === 'v') {
        // Always try system clipboard first (Explorer files)
        const sysFiles = await api.clipboardReadFiles();
        if (sysFiles && sysFiles.length > 0) {
          pasteFromSystemClipboard();
        } else if (clipboard && currentDir) {
          pasteToFolder(currentDir);
        }
      }
      if (e.key === 'a') {
        document.querySelectorAll('.file-table tbody tr').forEach(tr => tr.classList.add('selected'));
      }
    }
  });

  // Drag-and-drop from Explorer into app
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, true);

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    const container = document.querySelector('.file-table-container');
    if (container) {
      container.style.background = 'rgba(99, 102, 241, 0.1)';
      container.style.border = '2px dashed var(--accent)';
    }
  }, true);

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const container = document.querySelector('.file-table-container');
    if (container) {
      container.style.background = '';
      container.style.border = '';
    }

    if (!currentDir) return;

    const files = Array.from(e.dataTransfer.files);
    
    if (files.length === 0) {
      const items = Array.from(e.dataTransfer.items);
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file && file.path) {
            const srcPath = file.path;
            const fileName = srcPath.split(/[/\\]/).pop();
            const destPath = `${currentDir}\\${fileName}`;
            await api.copyFile(srcPath, destPath);
          }
        }
      }
      if (currentDir) await loadDir(currentDir);
      await buildTree();
      return;
    }

    let count = 0;
    for (const file of files) {
      const srcPath = file.path;
      if (!srcPath) continue;
      const fileName = srcPath.split(/[/\\]/).pop();
      const destPath = `${currentDir}\\${fileName}`;
      const ok = await api.copyFile(srcPath, destPath);
      if (ok) count++;
    }

    if (count > 0) {
      showToast(`已拖入 ${count} 个文件`, 'success');
      if (currentDir) await loadDir(currentDir);
      await buildTree();
    }
  }, true);

  window.addEventListener('dragend', (e) => {
    const container = document.querySelector('.file-table-container');
    if (container) {
      container.style.background = '';
      container.style.border = '';
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

  // Save current tab scroll position
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
    await buildTree();
    await loadDir(dir);
    updateTitle();
    showToast(`工作目录: ${dir.split(/[/\\]/).pop()}`, 'success');
  }
}

function updateTitle() {
  const name = workspaceDir ? workspaceDir.split(/[/\\]/).pop() : '未选择目录';
  document.getElementById('titlebarTitle').textContent = `资料管理系统2.0 - ${name}`;
}

// === 文件树（左侧边栏）===
async function buildTree() {
  const tree = document.getElementById('fileTree');
  if (!tree) return;
  tree.innerHTML = '';

  try {
    // Workspace root
    if (workspaceDir) {
      const rootName = workspaceDir.split(/[/\\]/).pop();
      const rootItem = document.createElement('div');
      rootItem.className = 'tree-node-item';
      rootItem.style.paddingLeft = '8px';
      rootItem.dataset.path = workspaceDir;
      rootItem.innerHTML = `<span class="tree-arrow">▶</span><span class="tree-file-icon">📂</span><span class="tree-file-name">${rootName}</span>`;

      const rootChildren = document.createElement('div');
      rootChildren.className = 'tree-children';
      rootChildren.style.display = 'none';

      rootItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        document.querySelectorAll('.tree-node-item').forEach(n => n.classList.remove('active'));
        rootItem.classList.add('active');
        const arrow = rootItem.querySelector('.tree-arrow');
        const isOpen = rootChildren.style.display !== 'none';
        if (isOpen) {
          rootChildren.style.display = 'none';
          arrow.classList.remove('expanded');
        } else {
          if (rootChildren.children.length === 0) {
            await loadChildren(rootChildren, workspaceDir, 1, false);
          }
          rootChildren.style.display = 'block';
          arrow.classList.add('expanded');
        }
        currentDir = workspaceDir;
        tabs[activeTabIndex] = { ...tabs[activeTabIndex], path: workspaceDir, name: workspaceDir.split(/[/\\]/).pop() || '根目录' };
        renderTabs();
        await loadDir(workspaceDir);
        updateBreadcrumb(workspaceDir);
      });

      rootItem.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTreeContextMenu(e, workspaceDir, rootName);
      });

      rootItem.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTreeContextMenu(e, workspaceDir, workspaceDir.split(/[/\\]/).pop());
      });

      tree.appendChild(rootItem);
      tree.appendChild(rootChildren);
    }

    // Linked folders mixed in
    if (linkedFolders.length > 0) {
      for (const lf of linkedFolders) {
        const item = document.createElement('div');
        item.className = 'tree-node-item';
        item.style.paddingLeft = '8px';
        item.dataset.path = lf.path;
        item.innerHTML = `<span class="tree-arrow">▶</span><span class="tree-file-icon">🔗</span><span class="tree-file-name">${lf.name}</span>`;

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
            if (childrenEl.children.length === 0) {
              await loadChildren(childrenEl, lf.path, 1, true);
            }
            childrenEl.style.display = 'block';
            arrow.classList.add('expanded');
          }
          currentDir = lf.path;
          tabs[activeTabIndex] = { ...tabs[activeTabIndex], path: lf.path, name: lf.name };
          renderTabs();
          await loadDir(lf.path);
          updateBreadcrumb(lf.path);
        });

        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showLinkedFolderContextMenu(e, lf);
        });

        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showLinkedFolderContextMenu(e, lf);
        });

        tree.appendChild(item);
        tree.appendChild(childrenEl);
      }
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

function createChildNode(container, name, fullPath, depth, isLinked) {
  const item = document.createElement('div');
  item.className = 'tree-node-item';
  item.style.paddingLeft = (depth * 16 + 8) + 'px';
  item.dataset.path = fullPath;

  item.innerHTML = `<span class="tree-arrow">▶</span><span class="tree-file-icon">📂</span><span class="tree-file-name">${name}</span>`;

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

  container.appendChild(item);
  container.appendChild(childrenEl);
}

// === 文件列表（右侧面板）===
async function loadDir(dirPath) {
  if (!dirPath) return;
  currentDir = dirPath;

  // Track history
  if (historyIndex < dirHistory.length - 1) {
    dirHistory = dirHistory.slice(0, historyIndex + 1);
  }
  if (dirHistory[dirHistory.length - 1] !== dirPath) {
    dirHistory.push(dirPath);
    historyIndex = dirHistory.length - 1;
  }

  const entries = await api.readDir(dirPath);

  // Sort
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let va, vb;
    switch (sortBy) {
      case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
      case 'size': va = a.size || 0; vb = b.size || 0; break;
      case 'modified': va = a.modified || ''; vb = b.modified || ''; break;
      default: va = a.name.toLowerCase(); vb = b.name.toLowerCase();
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  fileList = entries;
  renderFileList(entries);

  const dirs = entries.filter(e => e.isDir).length;
  const files = entries.filter(e => !e.isDir).length;
  document.getElementById('statusText').textContent = `${dirs} 个文件夹，${files} 个文件`;

  updateBreadcrumb(dirPath);

  // Sync tree highlight
  if (!searchTimeout) highlightTreeNode(dirPath);
}

function renderFileList(entries) {
  const tbody = document.getElementById('fileTableBody');
  tbody.innerHTML = '';

  // Go up button
  if (currentDir && currentDir !== workspaceDir) {
    const parentDir = currentDir.replace(/[/\\][^/\\]+$/, '');
    const upRow = document.createElement('tr');
    upRow.innerHTML = `<td colspan="4"><div class="file-name"><span class="file-icon">⬆️</span><span>..</span></div></td>`;
    upRow.style.cursor = 'pointer';
    upRow.addEventListener('click', async () => {
      currentDir = parentDir;
      tabs[activeTabIndex] = { ...tabs[activeTabIndex], path: parentDir, name: parentDir.split(/[/\\]/).pop() || '根目录' };
      renderTabs();
      await loadDir(parentDir);
      await buildTree();
      await expandTreeToPath(parentDir);
      highlightTreeNode(parentDir);
    });
    tbody.appendChild(upRow);
  }

  // Right-click on empty area
  const tableContainer = document.querySelector('.file-table-container');
  if (tableContainer) {
    tableContainer.addEventListener('contextmenu', (e) => {
      if (e.target.closest('tr')) return;
      e.preventDefault();
      showFileListBgContextMenu(e);
    });
  }

  // Load tags in background
  loadTagsForEntries(entries, tbody);
}

async function loadTagsForEntries(entries, tbody) {
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

    tr.addEventListener('click', () => {
      document.querySelectorAll('.file-table tbody tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      if (!entry.isDir) openFileDetail(entry);
    });

    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      document.querySelectorAll('.file-table tbody tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      showFileContextMenu(e, entry);
    });

    tr.addEventListener('dblclick', () => {
      if (entry.isDir) {
        currentDir = entry.path;
        tabs[activeTabIndex] = { ...tabs[activeTabIndex], path: entry.path, name: entry.name };
        renderTabs();
        loadDir(entry.path);
        buildTree();
      } else {
        api.openPath(entry.path);
      }
    });

    // Drag to Explorer
    tr.setAttribute('draggable', 'true');
    tr.addEventListener('dragstart', (e) => {
      e.preventDefault();
      api.startDrag(entry.path);
    });

    tbody.appendChild(tr);
  }
}

async function openFileDetail(entry) {
  currentFile = entry;
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
  const textTypes = [
    'txt', 'md', 'log', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sql',
    'py', 'js', 'ts', 'jsx', 'tsx', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'dart', 'lua', 'r',
    'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
    'sh', 'bat', 'cmd', 'ps1', 'makefile', 'dockerfile', 'gitignore'
  ];

  if (imageTypes.includes(ext)) {
    previewArea.innerHTML = `<img src="file:///${entry.path.replace(/\\/g, '/')}" alt="预览">`;
  } else if (textTypes.includes(ext)) {
    const content = await api.readFileText(entry.path);
    if (content !== null) {
      previewArea.innerHTML = `<pre tabindex="0">${escapeHtml(content)}</pre>`;
    } else {
      previewArea.innerHTML = `<span class="preview-placeholder">无法读取</span>`;
    }
  } else {
    previewArea.innerHTML = `<span class="preview-placeholder"><span style="font-size:32px;display:block;margin-bottom:8px;">${fileType.icon}</span>暂不支持预览<br><small>${fileType.label}</small></span>`;
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
    doc: { lang: null, label: 'Word 文档' },
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
  if (currentDir) await loadDir(currentDir);
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

  // Always show paste from Explorer option
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
  
  // Check exclude conditions (AND logic - if any exclude matches, reject)
  for (const et of conditions.excludeTags) {
    if (tags.includes(et)) return false;
  }
  for (const ee of conditions.excludeExts) {
    if (ext === ee) return false;
  }
  
  // Check positive conditions (AND logic within group, OR between groups)
  let matchTag = conditions.tags.length === 0;
  let matchExt = conditions.exts.length === 0;
  let matchNote = conditions.notes.length === 0;
  let matchYaml = conditions.yaml.length === 0;
  let matchKw = conditions.keywords.length === 0;
  
  // Tag match
  if (conditions.tags.length > 0) {
    matchTag = conditions.tags.some(t => tags.includes(t));
  }
  
  // Extension match
  if (conditions.exts.length > 0) {
    matchExt = conditions.exts.some(e => ext === e || (e === 'image' && ['png','jpg','jpeg','gif','bmp','webp','svg','ico'].includes(ext)) || (e === 'code' && ['py','js','ts','java','c','cpp','h','go','rs','rb','php'].includes(ext)) || (e === 'doc' && ['doc','docx','pdf','txt','md'].includes(ext)));
  }
  
  // Note match
  if (conditions.notes.length > 0) {
    matchNote = conditions.notes.some(n => notes.includes(n));
  }
  
  // YAML match (check if notes contain yaml-like key:value)
  if (conditions.yaml.length > 0) {
    const yamlContent = notes + ' ' + tags;
    matchYaml = conditions.yaml.some(y => yamlContent.includes(y));
  }
  
  // Keyword match (filename)
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

async function advancedSearch(query) {
  if (!workspaceDir) return;
  
  const conditions = parseSearchQuery(query);
  const hasSpecial = conditions.tags.length > 0 || conditions.exts.length > 0 || 
                     conditions.notes.length > 0 || conditions.yaml.length > 0 || 
                     conditions.excludeTags.length > 0 || conditions.excludeExts.length > 0;
  
  // If only keywords, use the backend search for speed
  if (!hasSpecial && conditions.keywords.length > 0 && !conditions.hasOr) {
    return await searchFiles(conditions.keywords.join(' '));
  }
  
  // Otherwise, do client-side filtering
  const allEntries = await api.readDir(workspaceDir);
  const results = [];
  
  // Get all files recursively for filtering
  async function collectFiles(dirPath) {
    const entries = await api.readDir(dirPath);
    for (const entry of entries) {
      results.push(entry);
      if (entry.isDir && results.length < 2000) {
        await collectFiles(entry.path);
      }
    }
  }
  
  await collectFiles(workspaceDir);
  
  // Get metadata for all files
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
  
  // Display results
  document.getElementById('statusText').textContent = `搜索: ${filtered.length} 个结果`;
  const tbody = document.getElementById('fileTableBody');
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
      if (entry.isDir) { loadDir(entry.path); buildTree(); }
      else { api.openPath(entry.path); }
    });
    tbody.appendChild(tr);
  }
}

async function searchFiles(keyword) {
  if (!workspaceDir) return;
  const results = await api.searchFiles(keyword);
  document.getElementById('statusText').textContent = `搜索: ${results.length} 个结果`;

  const tbody = document.getElementById('fileTableBody');
  tbody.innerHTML = '';

  if (results.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:40px;">未找到匹配的文件</td></tr>';
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

  // Highlight matching directories
  for (const dirPath of dirPaths) {
    const parts = dirPath.replace(workspaceDir, '').split(/[/\\]/).filter(Boolean);
    let accum = workspaceDir;
    for (const part of parts) {
      accum += '\\' + part;
      // Expand this level
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
        // Expand parent first
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
          // Now try to find the node again
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
    // Highlight the leaf directory
    const leafNode = document.querySelector(`.tree-node-item[data-path="${CSS.escape(dirPath)}"]`);
    if (leafNode) {
      leafNode.style.background = 'var(--bg-active)';
      leafNode.style.color = 'var(--accent)';
    }
  }
}

// === 操作功能 ===
async function navigateToPath(targetPath) {
  // Normalize path
  const normalized = targetPath.replace(/\//g, '\\');
  
  // Check if path exists
  const pathInfo = await api.checkPath(normalized);
  if (!pathInfo.exists) {
    showToast('路径不存在', 'error');
    return;
  }

  let dirToLoad = normalized;
  
  // If it's a file, navigate to its parent directory
  if (!pathInfo.isDir) {
    dirToLoad = normalized.replace(/\\[^\\]+$/, '');
    const parentInfo = await api.checkPath(dirToLoad);
    if (!parentInfo.exists) {
      showToast('路径不存在', 'error');
      return;
    }
  }

  // Check if this dir is within workspace or linked folders
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

  // If not accessible, auto-link the directory (or its parent if it's a file)
  if (!isAccessible) {
    const linkTarget = pathInfo.isDir ? normalized : dirToLoad;
    const result = await api.addLinkedFolderPath(linkTarget);
    if (result && !result.alreadyLinked) {
      linkedFolders.push(result);
      await buildTree();
      showToast(`已自动链接: ${result.name}`, 'success');
    } else if (result && result.alreadyLinked) {
      // Already linked, just navigate
    } else {
      showToast('无法链接该路径', 'error');
      return;
    }
  }

  // Navigate to the directory
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
  // Expand to the target path in the tree
  await expandTreeToPath(parentPath);
  highlightTreeNode(parentPath);
}

async function expandTreeToPath(targetPath) {
  if (!workspaceDir || !targetPath) return;
  const rel = targetPath.replace(workspaceDir, '').split(/[/\\]/).filter(Boolean);
  let accum = workspaceDir;

  for (const part of rel) {
    accum += '\\' + part;
    const node = document.querySelector(`.tree-node-item[data-path="${CSS.escape(accum)}"]`);
    if (!node) continue;

    const arrow = node.querySelector('.tree-arrow');
    const childrenEl = node.nextElementSibling;
    if (!childrenEl || !childrenEl.classList.contains('tree-children')) continue;

    if (childrenEl.style.display === 'none') {
      if (childrenEl.querySelectorAll('.tree-node-item').length === 0) {
        const depth = accum.replace(workspaceDir, '').split(/[/\\]/).filter(Boolean).length;
        await loadChildren(childrenEl, accum, depth, false);
      }
      childrenEl.style.display = 'block';
      if (arrow) arrow.classList.add('expanded');
    }

    // Auto-collapse: collapse siblings at this level
    if (autoCollapse) {
      const parentContainer = childrenEl.parentElement;
      if (parentContainer) {
        parentContainer.querySelectorAll(':scope > .tree-children').forEach(sc => {
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
    }
  }
}

function highlightTreeNode(dirPath) {
  document.querySelectorAll('.tree-node-item').forEach(n => n.classList.remove('active'));
  const node = document.querySelector(`.tree-node-item[data-path="${CSS.escape(dirPath)}"]`);
  if (node) {
    node.classList.add('active');
    node.scrollIntoView({ block: 'nearest' });
  }
}

async function loadDirRaw(dirPath) {
  if (!dirPath) return;
  const entries = await api.readDir(dirPath);
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let va, vb;
    switch (sortBy) {
      case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
      case 'size': va = a.size || 0; vb = b.size || 0; break;
      case 'modified': va = a.modified || ''; vb = b.modified || ''; break;
      default: va = a.name.toLowerCase(); vb = b.name.toLowerCase();
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  fileList = entries;
  renderFileList(entries);
  const dirs = entries.filter(e => e.isDir).length;
  const files = entries.filter(e => !e.isDir).length;
  document.getElementById('statusText').textContent = `${dirs} 个文件夹，${files} 个文件`;
  updateBreadcrumb(dirPath);
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
    { icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(lf.path); showToast('路径已复制', 'success'); } },
    { icon: '🪟', label: '在资源管理器中打开', action: () => api.openPath(lf.path) },
    { sep: true },
    { icon: '🔗', label: '解除链接', cls: 'danger', action: async () => {
      if (confirm(`确定解除链接 "${lf.name}" 吗？`)) {
        await api.removeLinkedFolder(lf.id);
        linkedFolders = linkedFolders.filter(f => f.id !== lf.id);
        await buildTree();
        loadStats();
        showToast('链接已解除', 'success');
      }
    }},
  ];

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

function showLinkedFolderContextMenu(e, lf) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = [
    { icon: '📂', label: '打开', action: () => { currentDir = lf.path; loadDir(lf.path); } },
    { icon: '🔗', label: '在资源管理器中打开', action: () => api.openLinkedFolder(lf.path) },
    { icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(lf.path); showToast('路径已复制', 'success'); } },
  ];

  if (multiWindow) {
    items.push({ icon: '🪟', label: '在新窗口打开', action: () => api.openNewWindow(lf.path) });
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
      loadStats();
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

function showTreeContextMenu(e, dirPath, dirName) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = [
    { icon: '📂', label: '打开', action: () => { currentDir = dirPath; loadDir(dirPath); } },
    { icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(dirPath); showToast('路径已复制', 'success'); } },
    { icon: '🪟', label: '在资源管理器中打开', action: () => api.openPath(dirPath) },
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

async function copyFile(entry) {
  const dir = entry.path.replace(/[/\\][^/\\]+$/, '');
  const ext = entry.name.split('.').pop();
  const base = ext ? entry.name.slice(0, -(ext.length + 1)) : entry.name;
  const copyName = ext ? `${base}_副本.${ext}` : `${base}_副本`;
  const destPath = `${dir}\\${copyName}`;

  const ok = await api.copyFile(entry.path, destPath);
  if (ok) {
    showToast(`已复制: ${copyName}`, 'success');
    if (currentDir) await loadDir(currentDir);
  } else {
    showToast('复制失败', 'error');
  }
}

async function pasteToFolder(destDir) {
  if (!clipboard) return;
  const { action, entry } = clipboard;
  const fileName = entry.name;
  const destPath = `${destDir}\\${fileName}`;

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
  for (const srcPath of sysFiles) {
    const fileName = srcPath.split(/[/\\]/).pop();
    const destPath = `${currentDir}\\${fileName}`;
    const ok = await api.copyFile(srcPath, destPath);
    if (ok) count++;
  }

  if (count > 0) {
    showToast(`已从资源管理器粘贴 ${count} 个文件`, 'success');
    if (currentDir) await loadDir(currentDir);
  }
}

async function refresh() {
  if (!currentDir) return;
  // Remember which folders are expanded
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

  // Restore expanded state
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
  if (sortBy === by) { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; }
  else { sortBy = by; sortDir = 'asc'; }
  if (currentDir) loadDir(currentDir);
}

// === 面包屑导航 ===
function updateBreadcrumb(dirPath) {
  const bc = document.getElementById('breadcrumb');
  if (!workspaceDir || !dirPath) { bc.innerHTML = ''; return; }

  const rel = dirPath.replace(workspaceDir, '').replace(/[/\\]/, '').split(/[/\\]/).filter(Boolean);
  let html = `<span class="bc-item" data-path="${workspaceDir}">${workspaceDir.split(/[/\\]/).pop()}</span>`;

  let accum = workspaceDir;
  for (const part of rel) {
    accum += '\\' + part;
    html += `<span class="bc-sep">›</span><span class="bc-item" data-path="${accum}">${part}</span>`;
  }

  bc.innerHTML = html;
  bc.querySelectorAll('.bc-item').forEach(item => {
    item.addEventListener('click', () => {
      const p = item.dataset.path;
      loadDir(p);
      buildTree();
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = item.dataset.path;
      const menu = document.createElement('div');
      menu.className = 'context-menu';

      const items = [
        { icon: '📂', label: '打开', action: () => { currentDir = p; loadDir(p); buildTree(); } },
        { icon: '📋', label: '复制路径', action: () => { navigator.clipboard.writeText(p); showToast('路径已复制', 'success'); } },
      ];
      if (clipboard) {
        items.push({ icon: '📌', label: '粘贴到此文件夹', action: () => pasteToFolder(p) });
      }

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
  });
}

// === 设置面板 ===
function showSettings() {
  const settings = getSettings();
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
      <div class="settings-group-title">工作目录</div>
      <div class="settings-row">
        <label>当前目录</label>
        <span style="font-size:11px;color:var(--text-muted);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${workspaceDir || ''}">${workspaceDir ? workspaceDir.split(/[/\\]/).pop() : '未设置'}</span>
      </div>
      <div class="settings-row">
        <button class="modal-btn primary" style="width:100%;" onclick="closeModal();window._setWorkspace();">更换工作目录</button>
      </div>
    </div>
  `;

  document.getElementById('viewLogBtn').addEventListener('click', showLogViewer);
  document.getElementById('exportConfigBtn').addEventListener('click', exportConfig);
  document.getElementById('importConfigBtn').addEventListener('click', importConfig);
  document.getElementById('openApiSettingsBtn').addEventListener('click', showApiSettings);

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
    // Reload settings
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

  // Keyboard shortcuts for log viewer
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

function saveSettings() {
  const s = {
    theme: document.getElementById('settingTheme').value,
    autoCollapse: document.getElementById('settingAutoCollapse').classList.contains('on'),
    multiWindow: document.getElementById('settingMultiWindow').classList.contains('on'),
    closeToTray: document.getElementById('settingCloseToTray').classList.contains('on'),
    apiPort: parseInt(document.getElementById('settingApiPort')?.value) || getSettings().apiPort || 5000
  };
  localStorage.setItem('settings', JSON.stringify(s));
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
      <h3 style="margin-bottom:8px;">资料管理系统2.0</h3>
      <p style="color:var(--text-muted);font-size:13px;">版本 2.0.0</p>
      <p style="color:var(--text-muted);font-size:13px;margin-top:8px;">Electron + 文件系统模式</p>
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
        <pre style="background:var(--bg-tertiary);padding:12px;border-radius:8px;font-size:11px;color:var(--text-secondary);white-space:pre-wrap;line-height:1.6;user-select:text;cursor:text;"># MiMo Code / Claude Code 调用
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

function finishWizard() {
  // Reset all settings to defaults
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
    buildTree().then(() => {
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
