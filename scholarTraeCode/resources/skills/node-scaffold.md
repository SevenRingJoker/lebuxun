---
name: node-scaffold
description: Node.js 项目脚手架规范：package.json 骨架、目录结构、ESM/CJS 选型、镜像源与验证流程
triggers: node, nodejs, npm, express, koa, nest, 服务端, 后端, 接口服务
---

# Node.js 项目脚手架规范

创建 Node.js 项目时严格按本规范执行，**不要使用 `npm init` 交互命令**，所有配置文件用 write 工具直接写入完整内容。

## 0. 三阶段铁律（生成文件 → 安装依赖 → 运行验证，不可跳序）

任何项目创建/修复任务都必须严格分三个阶段，前一阶段未完成，禁止进入下一阶段：

1. **阶段 1 · 生成文件**：用 write 工具完整生成全部基础文件（package.json、配置文件、入口源码等）。
   - 此阶段禁止执行 `npm install`、`npm run *`、`node src/*` 等任何安装/运行类命令；
   - 禁止调用 start_background_task 启动任何后台服务；
   - 基础文件缺失时，禁止反复 edit 已有的残缺源码文件（如 main.js）"打补丁"——地基不存在时修补上层无意义，必须先 write 补齐缺失文件。
2. **阶段 2 · 安装依赖**：基础文件齐全后执行 `npm install`，确认退出码为 0、无 npm ERR。
   - 命令秒退（<500ms 失败）通常是 package.json 不存在/JSON 格式错误，回阶段 1 修复，不要重复执行安装。
3. **阶段 3 · 运行/验证**：依赖安装成功后才允许 `npm start` / `npm run dev` 等运行命令，长驻服务此阶段才可用 start_background_task。

发现产物缺失（如 package.json 不存在）时，无论正在做什么，立即回到阶段 1 重新按序执行。

## 1. 标准目录结构

```
project/
├── package.json
├── .gitignore
├── src/
│   ├── index.js          # 入口
│   ├── routes/           # 路由
│   ├── services/         # 业务逻辑
│   └── utils/            # 工具函数
└── README.md（仅用户明确要求时创建）
```

## 2. package.json 骨架

现代 Node.js（≥14）默认使用 **ES Modules**（`"type": "module"`，import/export）；仅当用户明确要求 CommonJS 或依赖老旧包时才用 require/module.exports。

```json
{
  "name": "project-name",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

依赖版本必须写**确定的主版本号**（如 `"express": "^4.19.0"`），禁止 `"latest"` 或留空。

## 3. 安装依赖

- 顺序锁：必须先创建 package.json，再执行 `npm install`。
- 国内网络先设置镜像：`npm config set registry https://registry.npmmirror.com`
- 依赖冲突（ERESOLVE）：阅读 peer 说明后可用 `npm install --legacy-peer-deps`。
- 禁止 `sudo npm install`；权限问题用 nvm 管理 Node 或修复 npm cache 属主。

## 4. .gitignore 必备项

```
node_modules/
*.log
.env
.DS_Store
```

## 5. 验证流程（收尾必须全部通过）

1. `npm install` 成功，无 npm ERR。
2. `node src/index.js`（或 `npm start`）能正常启动；HTTP 服务监听预期端口。
3. 端口被占用（EADDRINUSE）时：Windows 用 `netstat -ano | findstr :端口` + `taskkill /PID <pid> /F`；POSIX 用 `lsof -i :端口` + `kill <pid>`，或更换端口。
