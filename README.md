# 资料管理系统3.0

现代化本地文件管理工具，基于Electron构建，支持REST API接口，可与AI Agent集成协作。

## 功能特性

- 📂 工作目录模式 + VSCode风格目录树
- 👁️ 单击预览，双击打开（文本/图片/代码）
- 🏷️ 彩色标签与备注系统
- 🔍 智能搜索（#标签、!类型、@备注、yaml标签）
- 🎨 暗色/亮色主题
- 📋 右键菜单 + 键盘快捷键
- 🖥️ 系统托盘后台运行
- 🤖 REST API服务（12个端点，供AI Agent调用）
- 🚀 首次运行引导向导
- 💾 配置导入导出
- 📝 操作日志

## 快速开始

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
- sql.js (SQLite)
- Node.js HTTP API
- 纯HTML/CSS/JS（无框架）

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
