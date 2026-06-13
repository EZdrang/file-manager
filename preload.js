const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('minimize-window'),
  maximize: () => ipcRenderer.send('maximize-window'),
  close: () => ipcRenderer.send('close-window'),
  hideToTray: () => ipcRenderer.send('hide-to-tray'),
  quitApp: () => ipcRenderer.send('quit-app'),
  onAskCloseAction: (callback) => ipcRenderer.on('ask-close-action', () => callback()),

  getWorkspace: () => ipcRenderer.invoke('get-workspace'),
  setWorkspace: () => ipcRenderer.invoke('set-workspace'),
  openPath: (p) => ipcRenderer.invoke('open-workspace-path', p),

  readDir: (dirPath) => ipcRenderer.invoke('read-dir', dirPath),
  readFileText: (filePath) => ipcRenderer.invoke('read-file-text', filePath),
  getFileStat: (filePath) => ipcRenderer.invoke('get-file-stat', filePath),
  searchFiles: (keyword) => ipcRenderer.invoke('search-files', keyword),

  createFolder: (dirPath, name) => ipcRenderer.invoke('create-folder', dirPath, name),
  deletePath: (p) => ipcRenderer.invoke('delete-path', p),
  renamePath: (oldPath, newName) => ipcRenderer.invoke('rename-path', oldPath, newName),
  backupFile: (sourcePath, backupPath) => ipcRenderer.invoke('backup-file', sourcePath, backupPath),
  copyFile: (sourcePath, destPath) => ipcRenderer.invoke('copy-file', sourcePath, destPath),
  moveFile: (sourcePath, destPath) => ipcRenderer.invoke('move-file', sourcePath, destPath),

  clipboardWriteFiles: (filePaths) => ipcRenderer.invoke('clipboard-write-files', filePaths),
  clipboardReadFiles: () => ipcRenderer.invoke('clipboard-read-files'),
  clipboardHasFiles: () => ipcRenderer.invoke('clipboard-has-files'),
  startDrag: (filePath) => ipcRenderer.send('start-drag', filePath),

  getMeta: (filePath) => ipcRenderer.invoke('get-meta', filePath),
  saveMeta: (filePath, data) => ipcRenderer.invoke('save-meta', filePath, data),

  getStats: (dirPath) => ipcRenderer.invoke('get-stats', dirPath),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),

  getLinkedFolders: () => ipcRenderer.invoke('get-linked-folders'),
  addLinkedFolder: () => ipcRenderer.invoke('add-linked-folder'),
  addLinkedFolderPath: (folderPath) => ipcRenderer.invoke('add-linked-folder-path', folderPath),
  removeLinkedFolder: (id) => ipcRenderer.invoke('remove-linked-folder', id),
  checkPath: (targetPath) => ipcRenderer.invoke('check-path', targetPath),
  
  // 工作目录管理
  getWorkspaces: () => ipcRenderer.invoke('get-workspaces'),
  addWorkspace: () => ipcRenderer.invoke('add-workspace'),
  removeWorkspace: (id) => ipcRenderer.invoke('remove-workspace', id),
  setPrimaryWorkspace: (id) => ipcRenderer.invoke('set-primary-workspace', id),

  getLog: (maxLines) => ipcRenderer.invoke('get-log', maxLines),
  getLogSize: () => ipcRenderer.invoke('get-log-size'),
  clearLog: () => ipcRenderer.invoke('clear-log'),

  openNewWindow: (dirPath) => ipcRenderer.invoke('open-new-window', dirPath),
  onOpenDir: (callback) => ipcRenderer.on('open-dir', (e, dirPath) => callback(dirPath)),

  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
  saveApiPort: (port) => ipcRenderer.invoke('save-api-port', port),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  onCheckFirstRun: (callback) => ipcRenderer.on('check-first-run', (e, isFirstRun) => callback(isFirstRun))
});
