# 资料管理系统 v3.3

现代化本地文件管理工具，基于Electron构建，支持REST API接口，可与AI Agent集成协作。

## 下载

### Windows
| 文件 | 说明 |
|------|------|
| `file-manager-3.3.0-setup-x64.exe` | Windows x64 安装包 |
| `file-manager-3.3.0-setup-arm64.exe` | Windows ARM64 安装包 |
| `file-manager-3.3.0-portable-x64.exe` | Windows x64 便携版 |
| `file-manager-3.3.0-portable-arm64.exe` | Windows ARM64 便携版 |

### macOS
| 文件 | 说明 |
|------|------|
| `file-manager-3.3.0-x64.dmg` | macOS Intel DMG |
| `file-manager-3.3.0-arm64.dmg` | macOS Apple Silicon DMG |

### Linux
| 文件 | 说明 |
|------|------|
| `file-manager-3.3.0.amd64.deb` | Linux x64 DEB包 |

## 功能特性

### 核心功能
- 📂 多工作目录模式 + VSCode风格目录树
- 👁️ 单击预览，双击打开（文本/图片/代码）
- 🏷️ 彩色标签与备注系统
- 🔍 智能搜索（#标签、!类型、@备注、yaml标签）
- 🎨 暗色/亮色主题
- 📋 右键菜单 + 键盘快捷键
- 🖥️ 系统托盘后台运行
- 🤖 REST API服务（供AI Agent调用）
- 🚀 首次运行引导向导
- 💾 配置导入导出
- 📝 操作日志
- 📊 多栏模式（1/2/3栏），支持跨栏拖拽移动/复制文件
- 📄 文件预览增强：PDF、Word、音频、HTML实时渲染
- 🖼️ 图片预览支持缩放、旋转
- 📦 压缩包预览（ZIP/RAR/7Z 内容列表）
- ✏️ 批量操作：打标签、删标签、删备注、正则重命名
- 📝 知识笔记系统：文件关联Markdown笔记，支持导出
- 📊 文件统计面板（饼图+扩展名Top10）
- 🔁 重复文件检测
- 📷 EXIF信息显示，自动按拍摄时间/设备/镜头打标签
- 📁 文件夹备注（目录树彩色显示）
- ⭐ 收藏夹 / 🕐 最近文件
- 🔎 文件内容全文搜索（grep级别）
- ⌨️ 自定义快捷键（设置页面配置）
- 🌐 远程目录挂载（SMB/WebDAV）
- 📂 文件拖拽到文件夹直接移动
- ↩️ 撤销/重做（Ctrl+Z/Y）
- 🔍 文件过滤器（类型/大小/日期）
- 🗂️ 分类视图 / 看板视图
- 🔍 搜索范围切换（当前目录/全局）
- 📋 拖拽排序工作目录

### 首次运行
首次启动会弹出引导向导：
1. 欢迎页面
2. 选择工作目录
3. 导入旧配置（可选）
4. 选择主题
5. 开始使用

### 基本操作
| 操作 | 功能 |
|------|------|
| 单击文件 | 预览内容 |
| 双击文件 | 系统程序打开 |
| Ctrl+C/V | 复制/粘贴 |
| 右键菜单 | 文件操作 |
| 搜索框 | 搜索/路径跳转 |

### 高级搜索
```
#重要          按标签筛选
!py            按文件类型筛选
@待处理        按备注筛选
#重要 !py      AND逻辑
#重要|#紧急    OR逻辑
-#废弃         排除标签
```

## REST API

内置HTTP API服务器，端口默认5000。

```bash
# 健康检查
curl http://127.0.0.1:5000/api/health

# 列出文件
curl http://127.0.0.1:5000/api/files

# 搜索
curl -X POST http://127.0.0.1:5000/api/search \
  -H "Content-Type: application/json" \
  -d '{"keyword": "main.js"}'

# 读取文件
curl http://127.0.0.1:5000/api/files/main.js
```

## 技术栈

- Electron v42.4.0
- Node.js HTTP API
- 纯HTML/CSS/JS（无框架）
- mammoth.js（Word预览）
- yauzl（ZIP读取）
- 7zip-min（RAR/7Z读取）
- exifr（EXIF信息）
- marked.js（Markdown渲染）

## 项目结构

```
FileManager/
├── main.js          # 主进程
├── preload.js       # 预加载脚本
├── package.json     # 配置文件
├── build.js         # 打包脚本
├── web/
│   ├── electron.html
│   ├── renderer.js
│   ├── styles.css
│   ├── vendor/      # 第三方库
│   └── icon.png
└── node_modules/
```

## 开发

```bash
# 安装依赖
npm install

# 启动开发
npm start

# 打包
npm run dist
```

## 许可证

MIT License

## 作者

EZdrang
