const API_BASE = 'http://localhost:5000';

let currentFileId = null;
let currentFolderId = null;

async function loadFolders() {
  const res = await fetch(`${API_BASE}/api/folders`);
  const data = await res.json();
  renderFolders(data.folders);
}

function renderFolders(folders) {
  const list = document.getElementById('folderList');
  list.innerHTML = '';
  
  folders.forEach(folder => {
    if (folder.name === 'All Files') return;
    
    const item = document.createElement('button');
    item.className = `sidebar-item ${currentFolderId === folder.id ? 'active' : ''}`;
    item.innerHTML = `
      <span class="item-icon">📂</span>
      <span>${folder.name}</span>
    `;
    item.onclick = () => selectFolder(folder.id);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      showFolderMenu(e, folder);
    };
    list.appendChild(item);
  });
}

async function selectFolder(folderId) {
  currentFolderId = folderId === 'all' ? null : folderId;
  
  document.querySelectorAll('.sidebar-item').forEach(item => item.classList.remove('active'));
  event.target.closest('.sidebar-item').classList.add('active');
  
  await loadFiles();
}

async function loadFiles(search = '') {
  let url = `${API_BASE}/api/files`;
  const params = new URLSearchParams();
  
  if (currentFolderId) params.append('folder_id', currentFolderId);
  if (search) params.append('search', search);
  
  if (params.toString()) url += '?' + params.toString();
  
  const res = await fetch(url);
  const data = await res.json();
  renderFiles(data.files);
  
  const totalSize = data.files.reduce((sum, f) => sum + (f.file_size || 0), 0);
  document.getElementById('statusText').textContent = `${data.files.length} files · ${formatSize(totalSize)}`;
}

function renderFiles(files) {
  const tbody = document.getElementById('fileTableBody');
  tbody.innerHTML = '';
  
  files.forEach(file => {
    const tr = document.createElement('tr');
    tr.dataset.id = file.id;
    if (currentFileId === file.id) tr.classList.add('selected');
    
    tr.innerHTML = `
      <td>${file.id}</td>
      <td>
        <div class="file-name">
          <span class="file-icon">${getFileIcon(file.file_type)}</span>
          <span>${file.filename}</span>
        </div>
      </td>
      <td><span class="file-type-badge">${file.file_type.toUpperCase()}</span></td>
      <td>${formatSize(file.file_size)}</td>
      <td>${file.tags || '-'}</td>
      <td>${formatDate(file.created_at)}</td>
    `;
    
    tr.onclick = () => selectFile(file.id);
    tbody.appendChild(tr);
  });
}

async function selectFile(fileId) {
  currentFileId = fileId;
  
  document.querySelectorAll('.file-table tbody tr').forEach(tr => {
    tr.classList.toggle('selected', tr.dataset.id == fileId);
  });
  
  const res = await fetch(`${API_BASE}/api/files/${fileId}`);
  const file = await res.json();
  
  document.getElementById('detailPanel').style.display = 'flex';
  document.getElementById('tagsInput').value = file.tags || '';
  document.getElementById('notesInput').value = file.notes || '';
  
  document.getElementById('fileInfo').innerHTML = `
    <p><strong>Filename:</strong> ${file.filename}</p>
    <p><strong>Type:</strong> ${file.file_type.toUpperCase()}</p>
    <p><strong>Size:</strong> ${formatSize(file.file_size)}</p>
    <p><strong>Created:</strong> ${formatDate(file.created_at)}</p>
  `;
  
  const previewArea = document.getElementById('previewArea');
  
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(file.file_type)) {
    previewArea.innerHTML = `<img src="${API_BASE}/api/files/${fileId}/preview" alt="Preview">`;
  } else if (['txt', 'md', 'py', 'js', 'json', 'xml', 'html', 'css'].includes(file.file_type)) {
    const previewRes = await fetch(`${API_BASE}/api/files/${fileId}/preview`);
    const previewData = await previewRes.json();
    if (previewData.content) {
      previewArea.innerHTML = `<pre>${escapeHtml(previewData.content)}</pre>`;
    }
  } else {
    previewArea.innerHTML = `<span class="preview-placeholder">No preview available</span>`;
  }
}

async function saveFile() {
  if (!currentFileId) return;
  
  await fetch(`${API_BASE}/api/files/${currentFileId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tags: document.getElementById('tagsInput').value,
      notes: document.getElementById('notesInput').value,
      folder_id: currentFolderId
    })
  });
  
  showToast('File updated', 'success');
  loadFiles();
}

async function deleteFile() {
  if (!currentFileId) return;
  
  if (confirm('Delete this file?')) {
    await fetch(`${API_BASE}/api/files/${currentFileId}`, { method: 'DELETE' });
    document.getElementById('detailPanel').style.display = 'none';
    currentFileId = null;
    loadFiles();
    showToast('File deleted', 'success');
  }
}

function closePanel() {
  document.getElementById('detailPanel').style.display = 'none';
  currentFileId = null;
}

async function importFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async (e) => {
    for (const file of e.target.files) {
      const formData = new FormData();
      formData.append('file', file);
      if (currentFolderId) formData.append('folder_id', currentFolderId);
      
      await fetch(`${API_BASE}/api/files`, {
        method: 'POST',
        body: formData
      });
    }
    loadFiles();
    showToast(`Imported ${e.target.files.length} file(s)`, 'success');
  };
  input.click();
}

async function importFolder() {
  showToast('Use drag & drop or import files individually', 'success');
}

function searchFiles(query) {
  loadFiles(query);
}

function showNewFolderModal() {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = 'New Folder';
  document.getElementById('modalBody').innerHTML = `
    <div class="form-group">
      <label>Folder Name</label>
      <input type="text" id="folderNameInput" placeholder="Enter folder name">
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = `
    <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
    <button class="modal-btn primary" onclick="createFolder()">Create</button>
  `;
  modal.classList.add('active');
  setTimeout(() => document.getElementById('folderNameInput').focus(), 100);
}

async function createFolder() {
  const name = document.getElementById('folderNameInput').value.trim();
  if (!name) return;
  
  await fetch(`${API_BASE}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  
  closeModal();
  loadFolders();
  showToast('Folder created', 'success');
}

function showFolderMenu(e, folder) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();
  
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.cssText = `
    position: fixed; left: ${e.clientX}px; top: ${e.clientY}px;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 8px; padding: 4px; z-index: 1000; box-shadow: var(--shadow);
  `;
  
  menu.innerHTML = `
    <button class="menu-item" onclick="renameFolder(${folder.id}, '${folder.name}');this.parentElement.remove();">Rename</button>
    <button class="menu-item danger" onclick="deleteFolder(${folder.id});this.parentElement.remove();">Delete</button>
  `;
  
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 100);
}

async function renameFolder(id, oldName) {
  const newName = prompt('New name:', oldName);
  if (newName && newName !== oldName) {
    await fetch(`${API_BASE}/api/folders/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    loadFolders();
    showToast('Folder renamed', 'success');
  }
}

async function deleteFolder(id) {
  if (confirm('Delete this folder?')) {
    await fetch(`${API_BASE}/api/folders/${id}`, { method: 'DELETE' });
    if (currentFolderId === id) {
      currentFolderId = null;
      selectFolder('all');
    }
    loadFolders();
    showToast('Folder deleted', 'success');
  }
}

function showApiDocs() {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = 'API Documentation';
  document.getElementById('modalBody').innerHTML = `
    <div class="api-docs-content">
      <pre>Base URL: http://localhost:5000

FILE ENDPOINTS:
GET    /api/files          - Get file list
GET    /api/files/:id      - Get file details
POST   /api/files          - Upload file (multipart)
PUT    /api/files/:id      - Update file info
DELETE /api/files/:id      - Delete file
GET    /api/files/:id/download - Download file

FOLDER ENDPOINTS:
GET    /api/folders        - Get folder list
POST   /api/folders        - Create folder
PUT    /api/folders/:id    - Update folder
DELETE /api/folders/:id    - Delete folder

STATS:
GET    /api/stats          - Get statistics

QUERY PARAMETERS:
- folder_id: Filter by folder
- search: Search keyword
- limit: Result limit (default: 100)
- offset: Pagination offset

EXAMPLES:
# Get all files
curl http://localhost:5000/api/files

# Search files
curl "http://localhost:5000/api/files?search=test"

# Upload file
curl -X POST -F "file=@test.txt" http://localhost:5000/api/files

# Create folder
curl -X POST -H "Content-Type: application/json" \\
     -d '{"name":"New Folder"}' \\
     http://localhost:5000/api/folders</pre>
    </div>
  `;
  document.getElementById('modalFooter').innerHTML = `
    <button class="modal-btn primary" onclick="closeModal()">Close</button>
  `;
  modal.classList.add('active');
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✓' : '✕'}</span> ${message}`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function getFileIcon(type) {
  const icons = {
    png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼',
    txt: '📄', md: '📄',
    py: '💻', js: '💻', ts: '💻',
    html: '🌐', css: '🌐',
    json: '📋', xml: '📋',
    pdf: '📕', doc: '📘',
    zip: '📦', rar: '📦',
  };
  return icons[type] || '📄';
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('zh-CN');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

document.getElementById('newFolderBtn').onclick = showNewFolderModal;

document.getElementById('dropZone').ondragover = (e) => {
  e.preventDefault();
  e.currentTarget.classList.add('dragover');
};

document.getElementById('dropZone').ondragleave = (e) => {
  e.currentTarget.classList.remove('dragover');
};

document.getElementById('dropZone').ondrop = async (e) => {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  
  for (const file of e.dataTransfer.files) {
    const formData = new FormData();
    formData.append('file', file);
    if (currentFolderId) formData.append('folder_id', currentFolderId);
    
    await fetch(`${API_BASE}/api/files`, {
      method: 'POST',
      body: formData
    });
  }
  
  loadFiles();
  showToast(`Imported ${e.dataTransfer.files.length} file(s)`, 'success');
};

loadFolders();
loadFiles();
