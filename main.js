const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const APP_VERSION = '3.2';
const CONFIG_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const META_PATH = path.join(CONFIG_DIR, 'metadata.json');

// 旧版日志路径（带版本号）和新版通用日志路径
const LEGACY_LOG_NAME = '.资料管理系统2.0.log';
const UNIVERSAL_LOG_NAME = '.资料管理系统.log';

let mainWindow;
let tray = null;
let workspaceDir = null; // 主工作目录（保持兼容）
let workspaces = []; // 所有工作目录 [{id, name, path, isPrimary}]

// === 撤销系统 ===
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 20;
const UNDO_BACKUP_DIR = path.join(os.tmpdir(), 'file-manager-undo');
let undoCount = 0;

function pushUndo(action) {
  undoStack.push(action);
  redoStack.length = 0; // 新操作清空重做栈
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  undoCount++;
  if (undoCount >= 3) {
    undoCount = 0;
    try { fs.rmSync(UNDO_BACKUP_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}

function ensureUndoDir() {
  if (!fs.existsSync(UNDO_BACKUP_DIR)) fs.mkdirSync(UNDO_BACKUP_DIR, { recursive: true });
}

function copyDirRecursiveSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function performUndo() {
  if (undoStack.length === 0) return { success: false, message: '没有可撤销的操作' };
  const action = undoStack.pop();

  try {
    switch (action.type) {
      case 'delete': {
        const backupPath = action.backupPath;
        const originalPath = action.originalPath;
        if (!fs.existsSync(backupPath)) return { success: false, message: '备份已过期，无法恢复' };
        const stat = fs.statSync(backupPath);
        if (stat.isDirectory()) {
          copyDirRecursiveSync(backupPath, originalPath);
        } else {
          fs.copyFileSync(backupPath, originalPath);
        }
        fs.rmSync(backupPath, { recursive: true, force: true });
        // 推入重做栈
        ensureUndoDir();
        const backupId = Date.now() + '_' + action.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const newBackup = path.join(UNDO_BACKUP_DIR, backupId);
        const origStat = fs.statSync(originalPath);
        if (origStat.isDirectory()) {
          copyDirRecursiveSync(originalPath, newBackup);
        } else {
          fs.copyFileSync(originalPath, newBackup);
        }
        redoStack.push({ ...action, backupPath: newBackup });
        writeLog('撤销删除', action.name);
        return { success: true, message: `已恢复: ${action.name}` };
      }
      case 'move': {
        fs.renameSync(action.destPath, action.sourcePath);
        redoStack.push({ ...action });
        writeLog('撤销移动', action.sourcePath.split(/[/\\]/).pop());
        return { success: true, message: `已恢复: ${action.sourcePath.split(/[/\\]/).pop()}` };
      }
      case 'rename': {
        fs.renameSync(action.newPath, action.oldPath);
        redoStack.push({ ...action });
        writeLog('撤销重命名', action.oldPath.split(/[/\\]/).pop());
        return { success: true, message: `已恢复: ${action.oldPath.split(/[/\\]/).pop()}` };
      }
      default:
        return { success: false, message: '未知操作类型' };
    }
  } catch (e) {
    return { success: false, message: `撤销失败: ${e.message}` };
  }
}

async function performRedo() {
  if (redoStack.length === 0) return { success: false, message: '没有可重做的操作' };
  const action = redoStack.pop();

  try {
    switch (action.type) {
      case 'delete': {
        const name = action.name;
        const escaped = action.originalPath.replace(/'/g, "''").replace(/"/g, '""');
        const stat = fs.statSync(action.originalPath);
        const method = stat.isDirectory() ? 'DeleteDirectory' : 'DeleteFile';
        // 先备份再删除
        ensureUndoDir();
        const backupId = Date.now() + '_' + name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const newBackup = path.join(UNDO_BACKUP_DIR, backupId);
        if (stat.isDirectory()) {
          copyDirRecursiveSync(action.originalPath, newBackup);
        } else {
          fs.copyFileSync(action.originalPath, newBackup);
        }
        const cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')"`;
        execSync(cmd, { encoding: 'utf-8', timeout: 10000, windowsHide: true });
        undoStack.push({ ...action, backupPath: newBackup });
        writeLog('重做删除', name);
        return { success: true, message: `已重做删除: ${name}` };
      }
      case 'move': {
        fs.renameSync(action.sourcePath, action.destPath);
        undoStack.push({ ...action });
        writeLog('重做移动', action.destPath.split(/[/\\]/).pop());
        return { success: true, message: `已重做移动: ${action.destPath.split(/[/\\]/).pop()}` };
      }
      case 'rename': {
        fs.renameSync(action.oldPath, action.newPath);
        undoStack.push({ ...action });
        writeLog('重做重命名', action.newPath.split(/[/\\]/).pop());
        return { success: true, message: `已重做重命名: ${action.newPath.split(/[/\\]/).pop()}` };
      }
      default:
        return { success: false, message: '未知操作类型' };
    }
  } catch (e) {
    return { success: false, message: `重做失败: ${e.message}` };
  }
}

// === 文件监听系统 ===
const fileWatchers = new Map(); // dirPath -> watcher
const filePollers = new Map(); // dirPath -> { timer, lastMtime }
let watchDebounceTimer = null;
let watchIgnoreCount = 0;

function ignoreSelfOperations(callback) {
  watchIgnoreCount++;
  try {
    const result = callback();
    setTimeout(() => { watchIgnoreCount = Math.max(0, watchIgnoreCount - 1); }, 300);
    return result;
  } catch (e) {
    watchIgnoreCount = Math.max(0, watchIgnoreCount - 1);
    throw e;
  }
}

function startWatching(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  if (fileWatchers.has(dirPath)) return;
  
  // fs.watch
  try {
    const watcher = fs.watch(dirPath, { persistent: false }, (eventType, filename) => {
      notifyChange(dirPath, eventType, filename);
    });
    watcher.on('error', () => {
      fileWatchers.delete(dirPath);
    });
    fileWatchers.set(dirPath, watcher);
  } catch (e) {}

  // 轮询兜底：每2秒检查目录修改时间
  try {
    let lastMtime = fs.statSync(dirPath).mtimeMs;
    const timer = setInterval(() => {
      if (watchIgnoreCount > 0) return;
      try {
        const currentMtime = fs.statSync(dirPath).mtimeMs;
        if (currentMtime !== lastMtime) {
          lastMtime = currentMtime;
          notifyChange(dirPath, 'poll', '');
        }
      } catch (e) {}
    }, 2000);
    filePollers.set(dirPath, { timer, lastMtime });
  } catch (e) {}
}

function stopWatching(dirPath) {
  if (dirPath) {
    const watcher = fileWatchers.get(dirPath);
    if (watcher) { watcher.close(); fileWatchers.delete(dirPath); }
    const poller = filePollers.get(dirPath);
    if (poller) { clearInterval(poller.timer); filePollers.delete(dirPath); }
  } else {
    for (const [, watcher] of fileWatchers) watcher.close();
    fileWatchers.clear();
    for (const [, poller] of filePollers) clearInterval(poller.timer);
    filePollers.clear();
    if (watchDebounceTimer) { clearTimeout(watchDebounceTimer); watchDebounceTimer = null; }
  }
}

function ignoreSelfOperations(callback) {
  watchIgnoreCount++;
  try {
    const result = callback();
    setTimeout(() => { watchIgnoreCount = Math.max(0, watchIgnoreCount - 1); }, 300);
    return result;
  } catch (e) {
    watchIgnoreCount = Math.max(0, watchIgnoreCount - 1);
    throw e;
  }
}

// === 日志系统 ===
function getLogPath() {
  if (!workspaceDir) return null;
  const universal = path.join(workspaceDir, UNIVERSAL_LOG_NAME);
  const legacy = path.join(workspaceDir, LEGACY_LOG_NAME);
  // 迁移旧版日志到新版文件名
  if (fs.existsSync(legacy) && !fs.existsSync(universal)) {
    try {
      fs.renameSync(legacy, universal);
      execSync(`attrib +h "${universal}"`, { stdio: 'ignore' });
    } catch (e) {}
  }
  // 确保隐藏属性
  if (fs.existsSync(universal)) {
    try { execSync(`attrib +h "${universal}"`, { stdio: 'ignore' }); } catch (e) {}
  }
  return universal;
}

let logWriteCount = 0;

function writeLog(action, detail) {
  const logPath = getLogPath();
  if (!logPath) return;
  try {
    const now = new Date().toLocaleString('zh-CN');
    const line = `[${now}] [系统与操作任务] ${action}: ${detail}\n`;
    fs.appendFileSync(logPath, line, 'utf-8');
    
    logWriteCount++;
    // 每100次写入检查一次大小和隐藏属性
    if (logWriteCount >= 100) {
      logWriteCount = 0;
      // 设置Windows隐藏属性
      try { execSync(`attrib +h "${logPath}"`, { stdio: 'ignore' }); } catch (e) {}
      // 检查大小超过5MB则清理
      const stat = fs.statSync(logPath);
      if (stat.size > 5 * 1024 * 1024) {
        const content = fs.readFileSync(logPath, 'utf-8');
        const lines = content.split('\n');
        const half = Math.floor(lines.length / 2);
        fs.writeFileSync(logPath, lines.slice(half).join('\n'), 'utf-8');
      }
    }
  } catch (e) {}
}

function readLog(maxLines = 500) {
  const logPath = getLogPath();
  if (!logPath || !fs.existsSync(logPath)) return '';
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-maxLines).join('\n');
  } catch (e) {
    return '';
  }
}

function getLogSize() {
  const logPath = getLogPath();
  if (!logPath || !fs.existsSync(logPath)) return 0;
  try { return fs.statSync(logPath).size; } catch (e) { return 0; }
}

function clearLog() {
  const logPath = getLogPath();
  if (logPath && fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '', 'utf-8');
  }
}

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    // 未来版本迁移逻辑可在此添加
    // if (cfg.version === '1.0') { migrateV1toV2(cfg); }
    return cfg;
  } catch (e) { return {}; }
}

function saveConfig(cfg) {
  try {
    cfg.version = APP_VERSION;
    cfg.lastModified = new Date().toISOString();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('保存配置失败:', e.message);
  }
}

function loadLinkedFolders() {
  const cfg = loadConfig();
  return cfg.linkedFolders || [];
}

function saveLinkedFolders(folders) {
  const cfg = loadConfig();
  cfg.linkedFolders = folders;
  saveConfig(cfg);
}

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf-8')); } catch (e) { return {}; }
}

function saveMeta(meta) {
  try {
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  } catch (e) {
    console.error('保存元数据失败:', e.message);
  }
}

// === 工作目录管理 ===
function loadWorkspaces() {
  const cfg = loadConfig();
  // 兼容旧版：将linkedFolders转为workspaces
  if (cfg.linkedFolders && cfg.linkedFolders.length > 0) {
    if (!cfg.workspaces || cfg.workspaces.length === 0) {
      cfg.workspaces = [
        ...(cfg.workspace ? [{ id: 1, name: cfg.workspace.split(/[/\\]/).pop(), path: cfg.workspace, isPrimary: true }] : []),
        ...cfg.linkedFolders.map((lf, i) => ({ ...lf, id: Date.now() + i, isPrimary: false }))
      ];
    }
    delete cfg.linkedFolders;
    saveConfig(cfg);
  }
  return cfg.workspaces || [];
}

function saveWorkspaces(ws) {
  const cfg = loadConfig();
  cfg.workspaces = ws;
  // 同步更新主目录
  const primary = ws.find(w => w.isPrimary);
  if (primary) {
    cfg.workspace = primary.path;
    workspaceDir = primary.path;
  }
  saveConfig(cfg);
}

function getWorkspacePaths() {
  return workspaces.map(w => w.path).filter(p => p && fs.existsSync(p));
}

function createWindow(dirPath) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, 'web', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'web', 'electron.html'));

  // 关闭时隐藏到托盘而非退出
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.webContents.send('ask-close-action');
    }
  });

  if (dirPath) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('open-dir', dirPath);
    });
  }
  return win;
}

app.whenReady().then(() => {
  const cfg = loadConfig();
  if (cfg.workspace) workspaceDir = cfg.workspace;
  
  // 初始化工作目录列表
  workspaces = loadWorkspaces();
  if (workspaces.length === 0 && workspaceDir) {
    workspaces = [{ id: 1, name: workspaceDir.split(/[/\\]/).pop(), path: workspaceDir, isPrimary: true }];
    saveWorkspaces(workspaces);
  }
  
  mainWindow = createWindow();
  createTray();
  mainWindow.webContents.on('did-finish-load', () => {
    const isFirstRun = !cfg.workspace;
    mainWindow.webContents.send('check-first-run', isFirstRun);
  });
  app.on('activate', () => {
    if (mainWindow) { mainWindow.show(); }
    else { mainWindow = createWindow(); }
  });
});

app.on('before-quit', () => {
  stopWatching();
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  // 不退出，保持在托盘运行
});

// === 窗口控制 ===
ipcMain.on('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('maximize-window', () => { if (mainWindow) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
ipcMain.on('close-window', () => { if (mainWindow) mainWindow.webContents.send('ask-close-action'); });
ipcMain.on('hide-to-tray', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('quit-app', () => { app.isQuitting = true; app.quit(); });

// === 系统托盘 ===
function createTray() {
  const iconPath = path.join(__dirname, 'web', 'icon-16.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    // 备用方案：创建空图标
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('资料管理系统');

  const contextMenu = Menu.buildFromTemplate([
    { 
      label: '打开主界面', 
      click: () => { 
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      }
    },
    { type: 'separator' },
    { 
      label: '退出', 
      click: () => { 
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// === 工作目录 ===
ipcMain.handle('get-workspace', () => workspaceDir);

ipcMain.handle('set-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择工作目录'
  });
  if (result.canceled || !result.filePaths[0]) return null;
  workspaceDir = result.filePaths[0];
  const existing = workspaces.find(w => w.path === workspaceDir);
  if (existing) {
    workspaces = workspaces.map(w => ({ ...w, isPrimary: w.id === existing.id }));
  } else {
    workspaces = [
      { id: Date.now(), name: workspaceDir.split(/[/\\]/).pop(), path: workspaceDir, isPrimary: true },
      ...workspaces.map(w => ({ ...w, isPrimary: false }))
    ];
  }
  saveWorkspaces(workspaces);
  return workspaceDir;
});

ipcMain.handle('get-workspaces', () => workspaces);

ipcMain.handle('add-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择要添加的工作目录'
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const folderPath = result.filePaths[0];
  if (workspaces.some(w => w.path === folderPath)) return null;
  const name = folderPath.split(/[/\\]/).pop();
  const entry = { id: Date.now(), name, path: folderPath, isPrimary: workspaces.length === 0 };
  workspaces.push(entry);
  saveWorkspaces(workspaces);
  return entry;
});

ipcMain.handle('add-workspace-path', (e, folderPath) => {
  if (typeof folderPath !== 'string' || !folderPath.trim()) return null;
  if (!fs.existsSync(folderPath)) return null;
  if (workspaces.some(w => w.path === folderPath)) return null;
  const name = folderPath.split(/[/\\]/).pop();
  const entry = { id: Date.now(), name, path: folderPath, isPrimary: workspaces.length === 0 };
  workspaces.push(entry);
  saveWorkspaces(workspaces);
  return entry;
});

ipcMain.handle('select-directory', async (e, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: title || '选择文件夹'
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('remove-workspace', (e, id) => {
  const ws = workspaces.find(w => w.id === id);
  if (ws && ws.isPrimary) return false; // 不能删除主目录
  workspaces = workspaces.filter(w => w.id !== id);
  saveWorkspaces(workspaces);
  return true;
});

ipcMain.handle('set-primary-workspace', (e, id) => {
  workspaces = workspaces.map(w => ({ ...w, isPrimary: w.id === id }));
  saveWorkspaces(workspaces);
  return true;
});

ipcMain.handle('save-workspace-order', (e, newOrder) => {
  if (!Array.isArray(newOrder)) return false;
  // 校验每个元素必须有 id, name, path
  const valid = newOrder.every(w => w && typeof w.id === 'number' && typeof w.name === 'string' && typeof w.path === 'string');
  if (!valid) return false;
  workspaces = newOrder;
  saveWorkspaces(workspaces);
  return true;
});

ipcMain.handle('open-workspace-path', (e, p) => {
  shell.openPath(p);
});

ipcMain.handle('open-terminal', (e, dirPath) => {
  try {
    const safePath = dirPath.replace(/'/g, "''").replace(/"/g, '""');
    execSync(`start powershell -NoExit -Command "cd '${safePath}'"`, { windowsHide: false });
  } catch (e) {}
});

// === 远程目录挂载 ===
ipcMain.handle('mount-remote', (e, { type, host, share, user, password, driveLetter }) => {
  try {
    // 校验参数
    if (typeof host !== 'string' || !host.trim()) return { success: false, error: '无效的服务器地址' };
    if (type === 'smb' && typeof share !== 'string') return { success: false, error: '无效的共享名称' };
    const letter = (typeof driveLetter === 'string' && /^[A-Z]$/i.test(driveLetter)) ? driveLetter.toUpperCase() : 'Z';
    
    let uncPath;
    if (type === 'smb') {
      uncPath = `\\\\${host.trim()}\\${share.trim()}`;
    } else if (type === 'webdav') {
      uncPath = host.startsWith('http') ? host.trim() : `http://${host.trim()}`;
    } else {
      return { success: false, error: '不支持的类型' };
    }

    let cmd;
    if (type === 'smb' && user) {
      const safeUser = String(user).replace(/"/g, '""');
      const safePass = String(password || '').replace(/"/g, '""');
      cmd = `net use ${letter}: "${uncPath}" /user:"${safeUser}" "${safePass}" /persistent:no`;
    } else {
      cmd = `net use ${letter}: "${uncPath}" /persistent:no`;
    }

    execSync(cmd, { encoding: 'utf-8', timeout: 15000, windowsHide: true });
    const mountPath = `${letter}:\\`;
    return { success: true, path: mountPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('unmount-remote', (e, driveLetter) => {
  try {
    const letter = (typeof driveLetter === 'string' && /^[A-Z]$/i.test(driveLetter)) ? driveLetter.toUpperCase() : null;
    if (!letter) return { success: false, error: '无效的盘符' };
    execSync(`net use ${letter}: /delete /y`, { encoding: 'utf-8', timeout: 10000, windowsHide: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('list-mounts', () => {
  try {
    const output = execSync('net use', { encoding: 'utf-8', timeout: 5000, windowsHide: true });
    const mounts = [];
    const regex = /([A-Z]):\s+\\\\(\S+)/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      mounts.push({ letter: match[1], path: match[2] });
    }
    return mounts;
  } catch (e) {
    return [];
  }
});

ipcMain.handle('open-external', (e, url) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

ipcMain.handle('undo', () => {
  return performUndo();
});

ipcMain.handle('redo', () => {
  return performRedo();
});

ipcMain.handle('watch-dir', (e, dirPath) => {
  startWatching(dirPath);
});

ipcMain.handle('unwatch-dir', () => {
  stopWatching();
});

// === 文件系统 ===
ipcMain.handle('read-dir', (e, dirPath) => {
  let target = dirPath || workspaceDir;
  if (dirPath) {
    const resolved = resolveFilePath(dirPath);
    if (!resolved) return [];
    target = resolved;
  }
  if (!target || !fs.existsSync(target)) return [];

  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return entries
      .map(e => {
        const fullPath = path.join(target, e.name);
        let stat = {};
        try { stat = fs.statSync(fullPath); } catch (ex) {}
        return {
          name: e.name,
          isDir: e.isDirectory(),
          path: fullPath,
          size: stat.size || 0,
          modified: stat.mtime || null,
          birthtime: stat.birthtime || null
        };
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
  } catch (e) {
    return [];
  }
});

ipcMain.handle('read-file-text', (e, filePath) => {
  try {
    const resolved = resolveFilePath(filePath);
    if (!resolved) return null;
    return fs.readFileSync(resolved, 'utf-8').slice(0, 20000);
  } catch (e) {
    return null;
  }
});

ipcMain.handle('read-file-buffer', (e, filePath) => {
  try {
    const resolved = resolveFilePath(filePath);
    if (!resolved) return null;
    const data = fs.readFileSync(resolved);
    return data.toString('base64');
  } catch (e) {
    return null;
  }
});

ipcMain.handle('get-file-stat', (e, filePath) => {
  try {
    const resolved = resolveFilePath(filePath);
    if (!resolved) return null;
    const stat = fs.statSync(resolved);
    return { size: stat.size, modified: stat.mtime, birthtime: stat.birthtime, isFile: stat.isFile() };
  } catch (e) {
    return null;
  }
});

ipcMain.handle('search-files', (e, keyword) => {
  if (!keyword) return [];
  const results = [];
  const maxResults = 200;

  function walk(dir, depth) {
    if (depth > 8 || results.length >= maxResults) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.name.toLowerCase().includes(keyword.toLowerCase())) {
          let stat = {};
          try { stat = fs.statSync(fullPath); } catch (ex) {}
          results.push({
            name: entry.name,
            isDir: entry.isDirectory(),
            path: fullPath,
            size: stat.size || 0,
            modified: stat.mtime || null
          });
        }
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        }
      }
    } catch (e) {}
  }

  // 搜索所有工作目录
  const paths = getWorkspacePaths();
  for (const p of paths) {
    if (results.length >= maxResults) break;
    walk(p, 0);
  }

  return results;
});

ipcMain.handle('create-folder', (e, dirPath, name) => {
  try {
    const target = path.join(dirPath, name);
    ignoreSelfOperations(() => fs.mkdirSync(target, { recursive: true }));
    writeLog('创建文件夹', target);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('delete-path', async (e, targetPath) => {
  try {
    const name = targetPath.split(/[/\\]/).pop();
    const escaped = targetPath.replace(/'/g, "''").replace(/"/g, '""');
    const stat = fs.statSync(targetPath);
    const method = stat.isDirectory() ? 'DeleteDirectory' : 'DeleteFile';
    const cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')"`;
    execSync(cmd, { encoding: 'utf-8', timeout: 10000, windowsHide: true });
    pushUndo({ type: 'delete', name, originalPath: targetPath });
    writeLog('删除(回收站)', name);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('rename-path', (e, oldPath, newName) => {
  try {
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    ignoreSelfOperations(() => fs.renameSync(oldPath, newPath));
    pushUndo({ type: 'rename', oldPath, newPath });
    writeLog('重命名', `${oldPath.split(/[/\\]/).pop()} → ${newName}`);
    return newPath;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('backup-file', (e, sourcePath, backupPath) => {
  try {
    const data = fs.readFileSync(sourcePath);
    ignoreSelfOperations(() => fs.writeFileSync(backupPath, data));
    writeLog('备份文件', `${sourcePath.split(/[/\\]/).pop()} → ${backupPath.split(/[/\\]/).pop()}`);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('copy-file', (e, sourcePath, destPath) => {
  try {
    ignoreSelfOperations(() => fs.copyFileSync(sourcePath, destPath));
    // 继承标签和备注
    const meta = loadMeta();
    if (meta[sourcePath]) {
      meta[destPath] = { ...meta[sourcePath] };
      saveMeta(meta);
    }
    writeLog('复制文件', `${sourcePath.split(/[/\\]/).pop()} → ${destPath.split(/[/\\]/).pop()}`);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('move-file', (e, sourcePath, destPath) => {
  try {
    ignoreSelfOperations(() => fs.renameSync(sourcePath, destPath));
    // 迁移标签和备注
    const meta = loadMeta();
    if (meta[sourcePath]) {
      meta[destPath] = meta[sourcePath];
      delete meta[sourcePath];
      saveMeta(meta);
    }
    pushUndo({ type: 'move', sourcePath, destPath });
    writeLog('移动文件', `${sourcePath.split(/[/\\]/).pop()} → ${destPath.split(/[/\\]/).pop()}`);
    return true;
  } catch (e) {
    return false;
  }
});

// === 系统剪贴板（Windows资源管理器）===
function runPs(script) {
  const tmpFile = path.join(os.tmpdir(), `clip_${Date.now()}.ps1`);
  // 不使用BOM - PowerShell可以正常处理UTF-8
  // 使用Buffer避免Node.js的UTF-8 BOM行为
  const buf = Buffer.from(script, 'utf-8');
  fs.writeFileSync(tmpFile, buf);
  try {
    const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { encoding: 'utf-8', timeout: 5000 });
    return result.trim();
  } catch (e) {
    return '';
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

ipcMain.handle('clipboard-write-files', (e, filePaths) => {
  try {
    // 将路径写入临时文件，然后用PowerShell读取并添加到剪贴板
    const listFile = path.join(os.tmpdir(), `clip_paths_${Date.now()}.txt`);
    fs.writeFileSync(listFile, filePaths.join('\n'), 'utf-16le');
    
    const script = `Add-Type -AssemblyName System.Windows.Forms
$paths = Get-Content "${listFile}" -Encoding Unicode
$files = New-Object System.Collections.Specialized.StringCollection
foreach ($p in $paths) { $files.Add($p) | Out-Null }
[System.Windows.Forms.Clipboard]::SetFileDropList($files)`;
    
    writeLog('剪贴板写入', filePaths.join(', '));
    runPs(script);
    
    // 清理临时文件
    try { fs.unlinkSync(listFile); } catch (e) {}
    return true;
  } catch (err) {
    writeLog('剪贴板写入失败', err.message);
    return false;
  }
});

ipcMain.handle('clipboard-read-files', () => {
  try {
    const listFile = path.join(os.tmpdir(), `clip_read_${Date.now()}.txt`);
    
    const script = `Add-Type -AssemblyName System.Windows.Forms
$list = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($list -and $list.Count -gt 0) {
  $list | Out-File "${listFile}" -Encoding Unicode
  Write-Output "OK"
} else {
  Write-Output "EMPTY"
}`;
    
    const result = runPs(script);
    writeLog('剪贴板读取结果', result);
    
    let files = [];
    if (result.includes('OK') && fs.existsSync(listFile)) {
      const content = fs.readFileSync(listFile, 'utf-16le');
      files = content.split(/\r?\n/).filter(p => p && p.trim() && fs.existsSync(p.trim())).map(f => f.trim());
      try { fs.unlinkSync(listFile); } catch (e) {}
    }
    
    writeLog('剪贴板读取', files.length + ' 个文件');
    return files;
  } catch (err) {
    writeLog('剪贴板读取失败', err.message);
    return [];
  }
});

ipcMain.handle('clipboard-has-files', () => {
  try {
    const script = `Add-Type -AssemblyName System.Windows.Forms
$list = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($list -and $list.Count -gt 0) { Write-Output 'yes' } else { Write-Output 'no' }`;
    const result = runPs(script);
    return result === 'yes';
  } catch (e) {
    return false;
  }
});

// === 拖拽文件到资源管理器 ===
ipcMain.on('start-drag', (e, filePath) => {
  try {
    e.sender.startDrag({ file: filePath, icon: path.join(__dirname, 'web', 'icon-32.png') });
  } catch (err) {
    writeLog('拖拽失败', err.message);
  }
});

ipcMain.handle('get-home-dir', () => os.homedir());

// === 日志操作 ===
ipcMain.handle('get-log', (e, maxLines) => readLog(maxLines));
ipcMain.handle('get-log-size', () => getLogSize());
ipcMain.handle('clear-log', () => { clearLog(); return true; });

// === 配置导入导出 ===
ipcMain.handle('save-api-port', (e, port) => {
  const cfg = loadConfig();
  cfg.apiPort = port;
  saveConfig(cfg);
  return true;
});

ipcMain.handle('export-config', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出配置',
    defaultPath: '资料管理系统_配置.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled) return false;

  try {
    const cfg = loadConfig();
    const meta = loadMeta();
    const exportData = {
      formatVersion: '2.0',
      appVersion: APP_VERSION,
      exportTime: new Date().toISOString(),
      workspace: cfg.workspace || null,
      linkedFolders: cfg.linkedFolders || [],
      settings: { theme: cfg.settings?.theme, autoCollapse: cfg.settings?.autoCollapse, multiWindow: cfg.settings?.multiWindow, apiPort: cfg.settings?.apiPort },
      metadata: meta
    };
    fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8');
    writeLog('导出配置', result.filePath);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('import-config', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入配置',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled) return null;

  try {
    const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
    const formatVer = data.formatVersion || data.version;
    if (!formatVer) return null;

    // 恢复设置（向前兼容：读取能识别的字段，忽略其他）
    const cfg = loadConfig();
    if (data.workspace) cfg.workspace = data.workspace;
    if (data.linkedFolders) cfg.linkedFolders = data.linkedFolders;
    if (data.settings) {
      cfg.settings = cfg.settings || {};
      if (data.settings.theme) cfg.settings.theme = data.settings.theme;
      if (data.settings.autoCollapse !== undefined) cfg.settings.autoCollapse = data.settings.autoCollapse;
      if (data.settings.multiWindow !== undefined) cfg.settings.multiWindow = data.settings.multiWindow;
    }
    saveConfig(cfg);

    // 恢复元数据
    if (data.metadata) {
      saveMeta(data.metadata);
    }

    writeLog('导入配置', result.filePaths[0]);
    return data;
  } catch (e) {
    return null;
  }
});
ipcMain.handle('get-linked-folders', () => loadLinkedFolders());

ipcMain.handle('open-new-window', (e, dirPath) => {
  createWindow(dirPath);
  return true;
});

ipcMain.handle('add-linked-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择要链接的文件夹'
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const folderPath = result.filePaths[0];
  const name = folderPath.split(/[/\\]/).pop();
  const linked = loadLinkedFolders();
  if (linked.some(l => l.path === folderPath)) return null;
  const entry = { id: Date.now(), name, path: folderPath };
  linked.push(entry);
  saveLinkedFolders(linked);
  return entry;
});

ipcMain.handle('remove-linked-folder', (e, id) => {
  const linked = loadLinkedFolders().filter(l => l.id !== id);
  saveLinkedFolders(linked);
  return true;
});

ipcMain.handle('check-path', (e, targetPath) => {
  try {
    if (!fs.existsSync(targetPath)) return { exists: false };
    const stat = fs.statSync(targetPath);
    return { exists: true, isDir: stat.isDirectory(), name: targetPath.split(/[/\\]/).pop() };
  } catch (e) {
    return { exists: false };
  }
});

ipcMain.handle('add-linked-folder-path', (e, folderPath) => {
  try {
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return null;
    const linked = loadLinkedFolders();
    if (linked.some(l => l.path === folderPath)) return { id: linked.find(l => l.path === folderPath).id, alreadyLinked: true };
    const name = folderPath.split(/[/\\]/).pop();
    const entry = { id: Date.now(), name, path: folderPath };
    linked.push(entry);
    saveLinkedFolders(linked);
    writeLog('自动链接文件夹', folderPath);
    return entry;
  } catch (e) {
    return null;
  }
});

// === 元数据（标签、备注）===
ipcMain.handle('get-meta', (e, filePath) => {
  const meta = loadMeta();
  return meta[filePath] || { tags: '', notes: '' };
});

ipcMain.handle('save-meta', (e, filePath, data) => {
  const meta = loadMeta();
  meta[filePath] = data;
  saveMeta(meta);
  return true;
});

// === 笔记系统 ===
ipcMain.handle('get-all-notes', () => {
  const meta = loadMeta();
  const notes = [];
  for (const [filePath, data] of Object.entries(meta)) {
    if (data.fileNote) {
      notes.push({ filePath, fileName: filePath.split(/[/\\]/).pop(), note: data.fileNote, modified: data.noteModified || null });
    }
  }
  return notes.sort((a, b) => (b.modified || 0) - (a.modified || 0));
});

ipcMain.handle('save-file-note', (e, filePath, note) => {
  const meta = loadMeta();
  if (!meta[filePath]) meta[filePath] = { tags: '', notes: '' };
  meta[filePath].fileNote = note;
  meta[filePath].noteModified = Date.now();
  saveMeta(meta);
  return true;
});

ipcMain.handle('write-file', (e, filePath, content) => {
  try {
    const resolved = resolveFilePath(filePath);
    if (!resolved) return false;
    fs.writeFileSync(resolved, content, 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('read-exif', async (e, filePath) => {
  try {
    const exifr = require('exifr');
    const data = await exifr.parse(filePath, true);
    if (!data) return null;
    
    const result = {};
    if (data.Make) result.设备 = `${data.Make} ${data.Model || ''}`.trim();
    if (data.LensModel || data.LensMake) result.镜头 = `${data.LensMake || ''} ${data.LensModel || ''}`.trim();
    if (data.FocalLength) result.焦距 = `${data.FocalLength}mm`;
    if (data.FNumber) result.光圈 = `f/${data.FNumber}`;
    if (data.ExposureTime) result.快门 = data.ExposureTime >= 1 ? `${data.ExposureTime}s` : `1/${Math.round(1/data.ExposureTime)}s`;
    if (data.ISO) result.ISO = data.ISO;
    if (data.DateTimeOriginal || data.CreateDate) result.拍摄时间 = new Date(data.DateTimeOriginal || data.CreateDate).toLocaleString('zh-CN');
    if (data.ImageWidth) result.宽度 = `${data.ImageWidth}px`;
    if (data.ImageHeight) result.高度 = `${data.ImageHeight}px`;
    if (data.GPSLatitude && data.GPSLongitude) {
      const lat = data.GPSLatitude;
      const lng = data.GPSLongitude;
      result.位置 = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }
    if (data.Software) result.软件 = data.Software;
    
    return Object.keys(result).length > 0 ? result : null;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('export-notes', async (e, exportPath) => {
  try {
    const meta = loadMeta();
    const notesDir = exportPath || path.join(os.homedir(), 'Desktop', '文件笔记导出');
    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
    
    let indexMd = '# 文件笔记索引\n\n';
    let count = 0;
    
    for (const [filePath, data] of Object.entries(meta)) {
      if (!data.fileNote) continue;
      const fileName = filePath.split(/[/\\]/).pop();
      const noteName = fileName.replace(/[<>:"/\\|?*]/g, '_') + '.md';
      
      const mdContent = `# ${fileName}\n\n**源文件路径:** \`${filePath}\`\n**标签:** ${data.tags || '无'}\n**修改时间:** ${data.noteModified ? new Date(data.noteModified).toLocaleString('zh-CN') : '未知'}\n\n---\n\n${data.fileNote}\n`;
      
      fs.writeFileSync(path.join(notesDir, noteName), mdContent, 'utf-8');
      indexMd += `- [${fileName}](${noteName}) - ${data.tags || '无标签'}\n`;
      count++;
    }
    
    fs.writeFileSync(path.join(notesDir, 'README.md'), indexMd, 'utf-8');
    return { success: true, count, path: notesDir };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// === 文件内容搜索 ===
ipcMain.handle('search-file-content', (e, dirPath, keyword) => {
  if (!dirPath || !keyword || !fs.existsSync(dirPath)) return [];
  const textExts = new Set(['txt','md','log','csv','json','xml','yaml','yml','toml','ini','cfg','conf','sql','py','js','ts','jsx','tsx','java','c','cpp','h','cs','go','rs','rb','php','html','htm','css','scss','less','vue','svelte','sh','bat','cmd','ps1','swift','kt','dart','lua','r','rtf']);
  const results = [];
  const maxResults = 200;
  const kw = keyword.toLowerCase();

  function walk(dir, depth) {
    if (depth > 6 || results.length >= maxResults) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith('.')) continue;
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fp, depth + 1);
        } else {
          const ext = path.extname(entry.name).toLowerCase().replace('.', '');
          if (!textExts.has(ext)) continue;
          try {
            const content = fs.readFileSync(fp, 'utf-8');
            const lines = content.split('\n');
            const matches = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(kw)) {
                matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
                if (matches.length >= 3) break;
              }
            }
            if (matches.length > 0) {
              results.push({ path: fp, name: entry.name, matches });
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  walk(dirPath, 0);
  return results;
});
ipcMain.handle('read-zip', (e, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  
  // ZIP 文件用 yauzl
  if (ext === '.zip') {
    return new Promise((resolve) => {
      try {
        const yauzl = require('yauzl');
        yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
          if (err) return resolve(null);
          const entries = [];
          zipfile.readEntry();
          zipfile.on('entry', (entry) => {
            entries.push({
              name: entry.fileName,
              size: entry.uncompressedSize,
              compressedSize: entry.compressedSize,
              isDir: entry.fileName.endsWith('/')
            });
            zipfile.readEntry();
          });
          zipfile.on('end', () => resolve(entries));
          zipfile.on('error', () => resolve(null));
        });
      } catch (e) {
        resolve(null);
      }
    });
  }
  
  // RAR/7Z/TAR/GZ 用 7zip-min
  return new Promise((resolve) => {
    try {
      const _7z = require('7zip-min');
      _7z.list(filePath, (err, result) => {
        if (err || !result) return resolve(null);
        const entries = result.map(e => ({
          name: e.name,
          size: e.size || 0,
          compressedSize: e.compressedSize || 0,
          isDir: e.name.endsWith('/') || e.isDir
        }));
        resolve(entries);
      });
    } catch (e) {
      resolve(null);
    }
  });
});
ipcMain.handle('get-stats', (e, dirPath) => {
  const target = dirPath || workspaceDir;
  if (!target || !fs.existsSync(target)) return { files: 0, dirs: 0, totalSize: 0 };

  let files = 0, dirs = 0, totalSize = 0;

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          dirs++;
          walk(fp);
        } else {
          files++;
          try { totalSize += fs.statSync(fp).size; } catch (e) {}
        }
      }
    } catch (e) {}
  }

  walk(target);
  return { files, dirs, totalSize };
});

ipcMain.handle('get-dir-size', (e, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) return 0;
  let totalSize = 0;
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fp);
        } else {
          try { totalSize += fs.statSync(fp).size; } catch (e) {}
        }
      }
    } catch (e) {}
  }
  walk(dirPath);
  return totalSize;
});

// === REST API服务器（供AI Agent调用）===
const http = require('http');

const DEFAULT_API_PORT = 5000;

function getApiPort() {
  const cfg = loadConfig();
  return cfg.apiPort || DEFAULT_API_PORT;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data, null, 2));
}

function resolveFilePath(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  // 检查是否在任何工作目录内
  const allDirs = [workspaceDir, ...workspaces.map(w => w.path)].filter(Boolean);
  for (const dir of allDirs) {
    if (resolved.startsWith(dir)) return resolved;
  }
  return null;
}

function walkDir(dir, depth, maxDepth) {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      let stat = {};
      try { stat = fs.statSync(fullPath); } catch (e) {}
      const item = {
        name: entry.name,
        isDir: entry.isDirectory(),
        path: path.relative(workspaceDir, fullPath).replace(/\\/g, '/'),
        size: stat.size || 0,
        modified: stat.mtime || null
      };
      if (entry.isDirectory()) {
        item.children = walkDir(fullPath, depth + 1, maxDepth);
      }
      results.push(item);
    }
  } catch (e) {}
  return results.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

function searchDir(dir, keyword, results, maxResults) {
  if (results.length >= maxResults) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(keyword.toLowerCase())) {
        let stat = {};
        try { stat = fs.statSync(fullPath); } catch (e) {}
        results.push({
          name: entry.name,
          isDir: entry.isDirectory(),
          path: path.relative(workspaceDir, fullPath).replace(/\\/g, '/'),
          size: stat.size || 0,
          modified: stat.mtime || null
        });
      }
      if (entry.isDirectory()) searchDir(fullPath, keyword, results, maxResults);
    }
  } catch (e) {}
}

const API_ROUTES = {
  'GET /api/workspace': '获取工作目录信息',
  'GET /api/files': '列出文件 (?path=子路径&depth=递归深度,默认0)',
  'GET /api/files/*': '读取文件内容或信息 (?info=1 返回元信息)',
  'POST /api/search': '搜索文件 {keyword, maxResults}',
  'POST /api/meta': '获取文件标签/备注 {path}',
  'PUT /api/meta': '保存文件标签/备注 {path, tags, notes}',
  'POST /api/create-folder': '创建文件夹 {path, name}',
  'POST /api/delete': '删除文件/文件夹 {path}',
  'POST /api/rename': '重命名 {path, newName}',
  'GET /api/stats': '统计信息 (?path=子路径)',
  'GET /api/docs': 'API文档',
  'GET /api/health': '健康检查'
};

let apiServer = null;

function startApiServer() {
  const port = getApiPort();

  if (apiServer) {
    try { apiServer.close(); } catch (e) {}
  }

  apiServer = http.createServer(async (req, res) => {
    // CORS预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      // 健康检查
      if (pathname === '/api/health') {
        return sendJson(res, 200, { status: 'ok', version: APP_VERSION, workspace: workspaceDir, port });
      }

      // API文档
      if (pathname === '/api/docs') {
        return sendJson(res, 200, { endpoints: API_ROUTES, example: 'curl http://localhost:' + port + '/api/workspace' });
      }

      // 工作目录信息
      if (pathname === '/api/workspace' && req.method === 'GET') {
        if (!workspaceDir) return sendJson(res, 200, { workspace: null, message: '未设置工作目录' });
        const meta = loadMeta();
        return sendJson(res, 200, { workspace: workspaceDir, workspaces: workspaces.map(w => ({ name: w.name, path: w.path, isPrimary: w.isPrimary })), metaCount: Object.keys(meta).length });
      }

      // 列出文件
      if (pathname === '/api/files' && req.method === 'GET') {
        if (!workspaceDir) return sendJson(res, 400, { error: '未设置工作目录' });
        const subPath = url.searchParams.get('path') || '';
        const depth = parseInt(url.searchParams.get('depth') || '0');
        const target = subPath ? path.resolve(workspaceDir, subPath) : workspaceDir;
        if (!target.startsWith(workspaceDir)) return sendJson(res, 403, { error: '禁止访问工作目录之外的路径' });
        if (!fs.existsSync(target)) return sendJson(res, 404, { error: '路径不存在' });
        const files = walkDir(target, 0, depth);
        return sendJson(res, 200, { path: subPath || '.', files });
      }

      // 读取文件/获取文件信息
      if (pathname.startsWith('/api/files/') && req.method === 'GET') {
        const filePath = decodeURIComponent(pathname.slice('/api/files/'.length));
        const fullPath = resolveFilePath(filePath);
        if (!fullPath) return sendJson(res, 403, { error: '禁止访问' });
        if (!fs.existsSync(fullPath)) return sendJson(res, 404, { error: '文件不存在' });
        const stat = fs.statSync(fullPath);
        if (url.searchParams.get('info') === '1') {
          const meta = loadMeta();
          return sendJson(res, 200, {
            name: path.basename(fullPath),
            path: filePath,
            isDir: stat.isDirectory(),
            size: stat.size,
            modified: stat.mtime,
            created: stat.birthtime,
            meta: meta[fullPath] || { tags: '', notes: '' }
          });
        }
        if (stat.isDirectory()) {
          const files = walkDir(fullPath, 0, 0);
          return sendJson(res, 200, { path: filePath, files });
        }
        if (stat.size > 2 * 1024 * 1024) return sendJson(res, 200, { path: filePath, size: stat.size, content: null, message: '文件过大(>2MB)，请使用info=1获取信息' });
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          return sendJson(res, 200, { path: filePath, size: stat.size, content });
        } catch (e) {
          return sendJson(res, 200, { path: filePath, size: stat.size, content: null, message: '二进制文件，无法以文本读取' });
        }
      }

      // 搜索文件
      if (pathname === '/api/search' && req.method === 'POST') {
        if (!workspaceDir) return sendJson(res, 400, { error: '未设置工作目录' });
        const body = await parseBody(req);
        const keyword = body.keyword || '';
        if (!keyword) return sendJson(res, 400, { error: '请提供keyword参数' });
        const maxResults = Math.min(body.maxResults || 100, 500);
        const results = [];
        searchDir(workspaceDir, keyword, results, maxResults);
        return sendJson(res, 200, { keyword, count: results.length, results });
      }

      // 获取元数据
      if (pathname === '/api/meta' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.path) return sendJson(res, 400, { error: '请提供path参数' });
        const fullPath = resolveFilePath(body.path);
        if (!fullPath) return sendJson(res, 403, { error: '禁止访问' });
        const meta = loadMeta();
        return sendJson(res, 200, { path: body.path, meta: meta[fullPath] || { tags: '', notes: '' } });
      }

      // 保存元数据
      if (pathname === '/api/meta' && req.method === 'PUT') {
        const body = await parseBody(req);
        if (!body.path) return sendJson(res, 400, { error: '请提供path参数' });
        const fullPath = resolveFilePath(body.path);
        if (!fullPath) return sendJson(res, 403, { error: '禁止访问' });
        const meta = loadMeta();
        meta[fullPath] = { tags: body.tags || '', notes: body.notes || '' };
        saveMeta(meta);
        writeLog('API更新标签', body.path);
        return sendJson(res, 200, { success: true });
      }

      // 创建文件夹
      if (pathname === '/api/create-folder' && req.method === 'POST') {
        if (!workspaceDir) return sendJson(res, 400, { error: '未设置工作目录' });
        const body = await parseBody(req);
        const target = body.path ? resolveFilePath(body.path) : workspaceDir;
        if (!target) return sendJson(res, 403, { error: '禁止访问' });
        const folderPath = path.join(target, body.name);
        if (!folderPath.startsWith(workspaceDir)) return sendJson(res, 403, { error: '禁止访问' });
        fs.mkdirSync(folderPath, { recursive: true });
        writeLog('API创建文件夹', folderPath);
        return sendJson(res, 200, { success: true, path: path.relative(workspaceDir, folderPath).replace(/\\/g, '/') });
      }

      // 删除文件
      if (pathname === '/api/delete' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.path) return sendJson(res, 400, { error: '请提供path参数' });
        const fullPath = resolveFilePath(body.path);
        if (!fullPath) return sendJson(res, 403, { error: '禁止访问' });
        if (!fs.existsSync(fullPath)) return sendJson(res, 404, { error: '不存在' });
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true });
        else fs.unlinkSync(fullPath);
        writeLog('API删除', body.path);
        return sendJson(res, 200, { success: true });
      }

      // 重命名
      if (pathname === '/api/rename' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.path || !body.newName) return sendJson(res, 400, { error: '请提供path和newName参数' });
        const fullPath = resolveFilePath(body.path);
        if (!fullPath) return sendJson(res, 403, { error: '禁止访问' });
        if (!fs.existsSync(fullPath)) return sendJson(res, 404, { error: '不存在' });
        const newPath = path.join(path.dirname(fullPath), body.newName);
        if (!newPath.startsWith(workspaceDir)) return sendJson(res, 403, { error: '禁止访问' });
        fs.renameSync(fullPath, newPath);
        writeLog('API重命名', `${body.path} → ${body.newName}`);
        return sendJson(res, 200, { success: true, newPath: path.relative(workspaceDir, newPath).replace(/\\/g, '/') });
      }

      // 统计信息
      if (pathname === '/api/stats' && req.method === 'GET') {
        if (!workspaceDir) return sendJson(res, 400, { error: '未设置工作目录' });
        const subPath = url.searchParams.get('path') || '';
        const target = subPath ? path.resolve(workspaceDir, subPath) : workspaceDir;
        if (!target.startsWith(workspaceDir)) return sendJson(res, 403, { error: '禁止访问' });
        let files = 0, dirs = 0, totalSize = 0;
        function walkStats(dir) {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.')) continue;
              const fp = path.join(dir, entry.name);
              if (entry.isDirectory()) { dirs++; walkStats(fp); }
              else { files++; try { totalSize += fs.statSync(fp).size; } catch (e) {} }
            }
          } catch (e) {}
        }
        walkStats(target);
        return sendJson(res, 200, { path: subPath || '.', files, dirs, totalSize });
      }

      sendJson(res, 404, { error: '未知端点', docs: '/api/docs' });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });

  apiServer.listen(port, '127.0.0.1', () => {
    console.log(`[API] 资料管理系统 API 服务器已启动: http://127.0.0.1:${port}`);
    console.log(`[API] 文档: http://127.0.0.1:${port}/api/docs`);
  });

  apiServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`[API] 端口 ${port} 被占用，尝试 ${port + 1}`);
      apiServer.listen(port + 1, '127.0.0.1');
    }
  });
}

app.whenReady().then(() => {
  startApiServer();
  
  // 全局错误日志
  process.on('uncaughtException', (err) => {
    const logPath = path.join(app.getPath('userData'), 'error.log');
    const msg = `[${new Date().toISOString()}] ${err.stack || err.message}\n`;
    try { fs.appendFileSync(logPath, msg, 'utf-8'); } catch (e) {}
  });
  process.on('unhandledRejection', (err) => {
    const logPath = path.join(app.getPath('userData'), 'error.log');
    const msg = `[${new Date().toISOString()}] Unhandled: ${err}\n`;
    try { fs.appendFileSync(logPath, msg, 'utf-8'); } catch (e) {}
  });
});

// === GitHub更新检查 ===
ipcMain.handle('check-update', async () => {
  try {
    const https = require('https');
    const url = 'https://api.github.com/repos/EZdrang/file-manager/releases/latest';
    
    function compareVersions(a, b) {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
      }
      return 0;
    }
    
    return new Promise((resolve) => {
      const req = https.get(url, { 
        headers: { 'User-Agent': 'FileManager-App' },
        timeout: 8000,
        rejectUnauthorized: false
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const release = JSON.parse(data);
            const latestVersion = (release.tag_name || '').replace('v', '');
            const currentVersion = APP_VERSION;
            const hasUpdate = latestVersion && compareVersions(latestVersion, currentVersion) > 0;
            resolve({
              hasUpdate,
              currentVersion,
              latestVersion,
              releaseUrl: release.html_url,
              releaseNotes: release.body || '',
              publishedAt: release.published_at
            });
          } catch (e) {
            resolve({ hasUpdate: false, error: '解析失败' });
          }
        });
      });
      req.on('error', (e) => resolve({ hasUpdate: false, error: '网络错误: ' + e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ hasUpdate: false, error: '连接超时，可能是网络问题或 GitHub 访问受限' }); });
    });
  } catch (e) {
    return { hasUpdate: false, error: e.message };
  }
});

ipcMain.handle('get-app-version', () => APP_VERSION);

// === 文件类型统计 ===
ipcMain.handle('get-type-stats', (e, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) return {};
  const stats = {};
  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(fp); }
        else {
          const ext = path.extname(entry.name).toLowerCase().replace('.', '') || '无扩展名';
          if (!stats[ext]) stats[ext] = { count: 0, size: 0 };
          stats[ext].count++;
          try { stats[ext].size += fs.statSync(fp).size; } catch (e) {}
        }
      }
    } catch (e) {}
  }
  walk(dirPath);
  return stats;
});

// === 重复文件检测 ===
ipcMain.handle('find-duplicates', async (e, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const crypto = require('crypto');
  
  const filesBySize = new Map();
  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(fp); }
        else {
          try {
            const stat = fs.statSync(fp);
            if (stat.size === 0) continue;
            const key = stat.size;
            if (!filesBySize.has(key)) filesBySize.set(key, []);
            filesBySize.get(key).push({ path: fp, name: entry.name, size: stat.size });
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  walk(dirPath);

  const filesByHash = new Map();
  for (const [, files] of filesBySize) {
    if (files.length < 2) continue;
    for (const file of files) {
      try {
        const buf = fs.readFileSync(file.path);
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        file.hash = hash;
        if (!filesByHash.has(hash)) filesByHash.set(hash, []);
        filesByHash.get(hash).push(file);
      } catch (e) {}
    }
  }

  const duplicates = [];
  for (const [hash, files] of filesByHash) {
    if (files.length >= 2) {
      duplicates.push({ hash, size: files[0].size, files });
    }
  }
  duplicates.sort((a, b) => (b.size * b.files.length) - (a.size * a.files.length));
  return duplicates;
});
