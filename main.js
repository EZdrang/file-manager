const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const APP_VERSION = '2.1';
const CONFIG_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const META_PATH = path.join(CONFIG_DIR, 'metadata.json');

// Legacy log path (versioned) and new universal log path
const LEGACY_LOG_NAME = '.资料管理系统2.0.log';
const UNIVERSAL_LOG_NAME = '.资料管理系统.log';

let mainWindow;
let tray = null;
let workspaceDir = null;

// === Logging ===
function getLogPath() {
  if (!workspaceDir) return null;
  const universal = path.join(workspaceDir, UNIVERSAL_LOG_NAME);
  const legacy = path.join(workspaceDir, LEGACY_LOG_NAME);
  // Migrate legacy log to universal name
  if (fs.existsSync(legacy) && !fs.existsSync(universal)) {
    try {
      fs.renameSync(legacy, universal);
      execSync(`attrib +h "${universal}"`, { stdio: 'ignore' });
    } catch (e) {}
  }
  // Ensure hidden attribute
  if (fs.existsSync(universal)) {
    try { execSync(`attrib +h "${universal}"`, { stdio: 'ignore' }); } catch (e) {}
  }
  return universal;
}

function writeLog(action, detail) {
  const logPath = getLogPath();
  if (!logPath) return;
  try {
    const now = new Date().toLocaleString('zh-CN');
    const line = `[${now}] [系统与操作任务] ${action}: ${detail}\n`;
    fs.appendFileSync(logPath, line, 'utf-8');
    // Set hidden attribute on Windows
    try { execSync(`attrib +h "${logPath}"`, { stdio: 'ignore' }); } catch (e) {}
    // Check size > 5MB
    const stat = fs.statSync(logPath);
    if (stat.size > 5 * 1024 * 1024) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      const half = Math.floor(lines.length / 2);
      fs.writeFileSync(logPath, lines.slice(half).join('\n'), 'utf-8');
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
    // Future version migration can go here
    // if (cfg.version === '1.0') { migrateV1toV2(cfg); }
    return cfg;
  } catch (e) { return {}; }
}

function saveConfig(cfg) {
  cfg.version = APP_VERSION;
  cfg.lastModified = new Date().toISOString();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
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

  // Hide instead of close (minimize to tray)
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

app.on('before-quit', () => { app.isQuitting = true; });

app.on('window-all-closed', () => {
  // Don't quit - keep running in tray
});

// === Window ===
ipcMain.on('minimize-window', () => mainWindow.minimize());
ipcMain.on('maximize-window', () => { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
ipcMain.on('close-window', () => { mainWindow.webContents.send('ask-close-action'); });
ipcMain.on('hide-to-tray', () => { mainWindow.hide(); });
ipcMain.on('quit-app', () => { app.isQuitting = true; app.quit(); });

// === Tray ===
function createTray() {
  const iconPath = path.join(__dirname, 'web', 'icon-16.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    // Fallback: create simple icon
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('资料管理系统2.0');

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

// === Workspace ===
ipcMain.handle('get-workspace', () => workspaceDir);

ipcMain.handle('set-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择工作目录'
  });
  if (result.canceled || !result.filePaths[0]) return null;
  workspaceDir = result.filePaths[0];
  saveConfig({ workspace: workspaceDir });
  return workspaceDir;
});

ipcMain.handle('open-workspace-path', (e, p) => {
  shell.openPath(p);
});

// === File System ===
ipcMain.handle('read-dir', (e, dirPath) => {
  const target = dirPath || workspaceDir;
  if (!target || !fs.existsSync(target)) return [];

  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.'))
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
    return fs.readFileSync(filePath, 'utf-8').slice(0, 20000);
  } catch (e) {
    return null;
  }
});

ipcMain.handle('get-file-stat', (e, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    return { size: stat.size, modified: stat.mtime, birthtime: stat.birthtime, isFile: stat.isFile() };
  } catch (e) {
    return null;
  }
});

ipcMain.handle('search-files', (e, keyword) => {
  if (!workspaceDir || !keyword) return [];
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

  walk(workspaceDir, 0);
  return results;
});

ipcMain.handle('create-folder', (e, dirPath, name) => {
  try {
    const target = path.join(dirPath, name);
    fs.mkdirSync(target, { recursive: true });
    writeLog('创建文件夹', target);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('delete-path', (e, targetPath) => {
  try {
    const name = targetPath.split(/[/\\]/).pop();
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
    writeLog('删除', name);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('rename-path', (e, oldPath, newName) => {
  try {
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    fs.renameSync(oldPath, newPath);
    writeLog('重命名', `${oldPath.split(/[/\\]/).pop()} → ${newName}`);
    return newPath;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('backup-file', (e, sourcePath, backupPath) => {
  try {
    const data = fs.readFileSync(sourcePath);
    fs.writeFileSync(backupPath, data);
    writeLog('备份文件', `${sourcePath.split(/[/\\]/).pop()} → ${backupPath.split(/[/\\]/).pop()}`);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('copy-file', (e, sourcePath, destPath) => {
  try {
    fs.copyFileSync(sourcePath, destPath);
    writeLog('复制文件', `${sourcePath.split(/[/\\]/).pop()} → ${destPath.split(/[/\\]/).pop()}`);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('move-file', (e, sourcePath, destPath) => {
  try {
    fs.renameSync(sourcePath, destPath);
    writeLog('移动文件', `${sourcePath.split(/[/\\]/).pop()} → ${destPath.split(/[/\\]/).pop()}`);
    return true;
  } catch (e) {
    return false;
  }
});

// === System Clipboard (Windows Explorer) ===
function runPs(script) {
  const tmpFile = path.join(os.tmpdir(), `clip_${Date.now()}.ps1`);
  // Write without BOM - PowerShell handles UTF-8 fine without it
  // Using Buffer to avoid Node's UTF-8 BOM behavior
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
    // Write each path to a temp file, then use PowerShell to read and add to clipboard
    const listFile = path.join(os.tmpdir(), `clip_paths_${Date.now()}.txt`);
    fs.writeFileSync(listFile, filePaths.join('\n'), 'utf-16le');
    
    const script = `Add-Type -AssemblyName System.Windows.Forms
$paths = Get-Content "${listFile}" -Encoding Unicode
$files = New-Object System.Collections.Specialized.StringCollection
foreach ($p in $paths) { $files.Add($p) | Out-Null }
[System.Windows.Forms.Clipboard]::SetFileDropList($files)`;
    
    writeLog('剪贴板写入', filePaths.join(', '));
    runPs(script);
    
    // Cleanup
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

// === Drag files to Explorer ===
ipcMain.on('start-drag', (e, filePath) => {
  try {
    e.sender.startDrag({ file: filePath, icon: path.join(__dirname, 'web', 'icon-32.png') });
  } catch (err) {
    writeLog('拖拽失败', err.message);
  }
});

ipcMain.handle('get-home-dir', () => os.homedir());

// === Logging ===
ipcMain.handle('get-log', (e, maxLines) => readLog(maxLines));
ipcMain.handle('get-log-size', () => getLogSize());
ipcMain.handle('clear-log', () => { clearLog(); return true; });

// === Config Export/Import ===
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

    // Restore settings (forward-compatible: read what we understand, ignore the rest)
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

    // Restore metadata
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

// === Metadata (tags, notes) ===
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

// === Stats ===
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

// === REST API Server (for AI agents) ===
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
  if (!workspaceDir) return null;
  const resolved = path.resolve(workspaceDir, filePath);
  if (!resolved.startsWith(workspaceDir)) return null;
  return resolved;
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
    // CORS preflight
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
      // Health check
      if (pathname === '/api/health') {
        return sendJson(res, 200, { status: 'ok', version: APP_VERSION, workspace: workspaceDir, port });
      }

      // API docs
      if (pathname === '/api/docs') {
        return sendJson(res, 200, { endpoints: API_ROUTES, example: 'curl http://localhost:' + port + '/api/workspace' });
      }

      // Workspace info
      if (pathname === '/api/workspace' && req.method === 'GET') {
        if (!workspaceDir) return sendJson(res, 200, { workspace: null, message: '未设置工作目录' });
        const cfg = loadConfig();
        const meta = loadMeta();
        const linked = cfg.linkedFolders || [];
        return sendJson(res, 200, { workspace: workspaceDir, linkedFolders: linked.map(l => ({ name: l.name, path: l.path })), metaCount: Object.keys(meta).length });
      }

      // List files
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

      // Read file / get file info
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

      // Search
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

      // Get meta
      if (pathname === '/api/meta' && req.method === 'POST') {
        const body = await parseBody(req);
        if (!body.path) return sendJson(res, 400, { error: '请提供path参数' });
        const fullPath = resolveFilePath(body.path);
        if (!fullPath) return sendJson(res, 403, { error: '禁止访问' });
        const meta = loadMeta();
        return sendJson(res, 200, { path: body.path, meta: meta[fullPath] || { tags: '', notes: '' } });
      }

      // Save meta
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

      // Create folder
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

      // Delete
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

      // Rename
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

      // Stats
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
});
