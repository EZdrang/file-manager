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
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openTerminal: (dirPath) => ipcRenderer.invoke('open-terminal', dirPath),
  mountRemote: (config) => ipcRenderer.invoke('mount-remote', config),
  unmountRemote: (driveLetter) => ipcRenderer.invoke('unmount-remote', driveLetter),
  listMounts: () => ipcRenderer.invoke('list-mounts'),
  undo: () => ipcRenderer.invoke('undo'),
  redo: () => ipcRenderer.invoke('redo'),

  watchDir: (dirPath) => ipcRenderer.invoke('watch-dir', dirPath),
  unwatchDir: () => ipcRenderer.invoke('unwatch-dir'),
  onFileChanged: (callback) => ipcRenderer.on('file-changed', (e, data) => callback(data)),

  readDir: (dirPath) => ipcRenderer.invoke('read-dir', dirPath),
  readFileText: (filePath) => ipcRenderer.invoke('read-file-text', filePath),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
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
  getAllNotes: () => ipcRenderer.invoke('get-all-notes'),
  saveFileNote: (filePath, note) => ipcRenderer.invoke('save-file-note', filePath, note),
  exportNotes: (exportPath) => ipcRenderer.invoke('export-notes', exportPath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  readExif: (filePath) => ipcRenderer.invoke('read-exif', filePath),

  getStats: (dirPath) => ipcRenderer.invoke('get-stats', dirPath),
  getDirSize: (dirPath) => ipcRenderer.invoke('get-dir-size', dirPath),
  findDuplicates: (dirPath) => ipcRenderer.invoke('find-duplicates', dirPath),
  getTypeStats: (dirPath) => ipcRenderer.invoke('get-type-stats', dirPath),
  readZip: (filePath) => ipcRenderer.invoke('read-zip', filePath),
  searchFileContent: (dirPath, keyword) => ipcRenderer.invoke('search-file-content', dirPath, keyword),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),

  getLinkedFolders: () => ipcRenderer.invoke('get-linked-folders'),
  addLinkedFolder: () => ipcRenderer.invoke('add-linked-folder'),
  addLinkedFolderPath: (folderPath) => ipcRenderer.invoke('add-linked-folder-path', folderPath),
  removeLinkedFolder: (id) => ipcRenderer.invoke('remove-linked-folder', id),
  checkPath: (targetPath) => ipcRenderer.invoke('check-path', targetPath),
  
  // 工作目录管理
  getWorkspaces: () => ipcRenderer.invoke('get-workspaces'),
  addWorkspace: () => ipcRenderer.invoke('add-workspace'),
  addWorkspacePath: (path) => ipcRenderer.invoke('add-workspace-path', path),
  selectDirectory: (title) => ipcRenderer.invoke('select-directory', title),
  removeWorkspace: (id) => ipcRenderer.invoke('remove-workspace', id),
  setPrimaryWorkspace: (id) => ipcRenderer.invoke('set-primary-workspace', id),
  saveWorkspaceOrder: (order) => ipcRenderer.invoke('save-workspace-order', order),

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
