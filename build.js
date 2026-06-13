const fs = require('fs');
const path = require('path');

const ELEC_SRC = 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Electron';
const APP_NAME = '资料管理系统2.2';
const DIST = path.join(__dirname, 'dist');
const BUILD = path.join(DIST, APP_NAME);

console.log('=== 打包开始 ===');

// 清理
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });

// 复制所有Electron文件
console.log('复制 Electron...');
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 复制Electron目录中的所有文件
for (const entry of fs.readdirSync(ELEC_SRC, { withFileTypes: true })) {
  const srcPath = path.join(ELEC_SRC, entry.name);
  const destPath = path.join(BUILD, entry.name);
  if (entry.isDirectory()) {
    copyDir(srcPath, destPath);
  } else {
    fs.copyFileSync(srcPath, destPath);
  }
}

// 重命名exe
fs.renameSync(path.join(BUILD, 'electron.exe'), path.join(BUILD, `${APP_NAME}.exe`));

// 删除default_app.asar（与我们的应用冲突）
const defaultAsar = path.join(BUILD, 'resources', 'default_app.asar');
if (fs.existsSync(defaultAsar)) fs.unlinkSync(defaultAsar);

// 复制应用文件到resources/app
console.log('复制应用文件...');
const appDir = path.join(BUILD, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });

const filesToCopy = ['main.js', 'preload.js', 'package.json'];
for (const f of filesToCopy) {
  fs.copyFileSync(path.join(__dirname, f), path.join(appDir, f));
}

// 复制web文件夹
fs.cpSync(path.join(__dirname, 'web'), path.join(appDir, 'web'), { recursive: true });

// 复制sql.js
const sqlJsPath = path.join(__dirname, 'node_modules', 'sql.js');
if (fs.existsSync(sqlJsPath)) {
  fs.cpSync(sqlJsPath, path.join(appDir, 'node_modules', 'sql.js'), { recursive: true });
}

// 创建启动器
const launcher = `@echo off
chcp 65001 >nul
title ${APP_NAME}
"%~dp0${APP_NAME}.exe"`;
fs.writeFileSync(path.join(BUILD, '启动.bat'), launcher, 'utf-8');

const vbs = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${APP_NAME}.exe""", 0, False`;
fs.writeFileSync(path.join(BUILD, '启动.vbs'), vbs, 'utf-8');

// 计算大小
const totalSize = fs.readdirSync(BUILD, { withFileTypes: true })
  .reduce((sum, entry) => {
    if (entry.isFile()) return sum + fs.statSync(path.join(BUILD, entry.name)).size;
    return sum;
  }, 0);

console.log(`=== 打包完成 ===`);
console.log(`输出目录: ${BUILD}`);
console.log(`大小: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
