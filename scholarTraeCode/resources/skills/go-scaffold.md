---
name: go-scaffold
description: Go 项目脚手架规范：go mod init、标准目录布局、GOPROXY 镜像、go mod tidy 与构建验证
triggers: go, golang, go mod, go build, gin, go-zero, 微服务
---

# Go 项目脚手架规范

创建 Go 项目时严格按本规范执行，**不要使用交互式脚手架**，所有文件用 write 工具直接写入。

## 1. 初始化模块

```bash
go mod init example.com/project-name
```

模块路径命名：本地项目可用简单名；未来要发布/被引用用域名路径（如 `github.com/user/project`）。

## 2. 标准目录布局

```
project/
├── go.mod
├── go.sum                 # go mod tidy 后自动生成
├── main.go                # 入口（小型项目）
├── cmd/                   # 多入口项目：cmd/server/main.go
├── internal/              # 私有代码（外部模块不可导入）
│   ├── handler/
│   ├── service/
│   └── repository/
├── pkg/                   # 可被外部复用的公共库
└── configs/               # 配置文件
```

## 3. GOPROXY 国内镜像

模块下载失败（dial tcp / connection refused）时先设置：

```bash
go env -w GOPROXY=https://goproxy.cn,direct
go env -w GOSUMDB=sum.golang.google.cn
```

## 4. 依赖管理

- 引入新依赖后执行 `go mod tidy`：自动补全/清理 go.mod 与 go.sum。
- `missing go.sum entry` 错误：直接 `go mod tidy` 补齐校验和。
- `go: cannot find main module`：当前目录无 go.mod，回到项目根目录或先 go mod init。

## 5. main.go 最小骨架

```go
package main

import "fmt"

func main() {
    fmt.Println("server starting...")
}
```

## 6. .gitignore 必备项

```
*.exe
*.test
*.out
vendor/
```

## 7. 验证流程（收尾必须全部通过）

1. `go mod tidy` 成功。
2. `go build ./...` 编译通过（...表示递归全部包）。
3. 需要运行时：`go run main.go` 正常启动。
4. `go vet ./...` 无告警（建议执行）。
