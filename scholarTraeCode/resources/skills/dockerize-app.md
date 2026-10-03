---
name: dockerize-app
description: 应用容器化规范：多阶段 Dockerfile、.dockerignore、docker compose 编排、端口映射与镜像加速
triggers: docker, dockerfile, 容器, docker compose, 镜像, 部署, k8s, kubernetes
---

# 应用容器化规范

为应用编写 Dockerfile / compose 编排时遵循本规范。**先确认环境探测结果中 Docker 可用**（`docker --version` + `docker info` 验证 daemon 运行）；不可用时引导用户启动 Docker Desktop，勿盲目重试。

## 1. .dockerignore 必备

与 Dockerfile 同时创建，避免把无关文件打进镜像：

```
node_modules
.git
*.log
.env
venv
__pycache__
README.md
```

## 2. Node.js 多阶段 Dockerfile

多阶段构建：builder 阶段装全量依赖编译，runner 阶段只拷产物，镜像更小更安全。

```dockerfile
# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --registry=https://registry.npmmirror.com
COPY . .
RUN npm run build

# ---- runner ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## 3. Python Dockerfile 要点

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
COPY . .
EXPOSE 5000
CMD ["python", "main.py"]
```

## 4. docker compose 编排

文件名 `docker-compose.yml`：

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"      # 宿主机端口:容器端口
    environment:
      - NODE_ENV=production
    restart: unless-stopped
```

## 5. 常见错误处理

- `port is already allocated` / `Bind for ... failed`：宿主机端口被占用，换宿主机端口或停掉冲突容器（`docker ps` + `docker stop`）。
- `OOMKilled`：容器内存超限，调 `--memory` 限制或优化内存。
- 拉取镜像超时：配置 registry mirror（Docker Desktop settings → registry mirrors 加 `https://docker.m.daocloud.io`）。
- 权限错误（permission denied on docker.sock）：不要 sudo，将用户加入 docker 组后重新登录（由用户手动操作）。

## 6. 验证流程（收尾必须全部通过）

1. `docker compose config` 校验编排文件语法。
2. `docker compose build` 构建成功。
3. `docker compose up -d` 启动后 `docker ps` 状态为 Up，端口可访问。
