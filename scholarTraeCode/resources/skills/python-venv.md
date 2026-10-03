---
name: python-venv
description: Python 虚拟环境与依赖管理规范：venv 创建/激活（Windows 与 macOS/Linux 双写法）、requirements、镜像源、PEP 668
triggers: python, pip, venv, 虚拟环境, flask, django, fastapi, requirements, python3
---

# Python 虚拟环境与依赖管理规范

Python 项目**必须使用虚拟环境**，禁止在全局环境直接 pip install（新版 Linux/macOS 会触发 PEP 668 externally-managed-environment 错误）。

## 1. 创建虚拟环境

```powershell
# Windows（PowerShell/cmd）
python -m venv venv
```

```bash
# macOS / Linux
python3 -m venv venv
```

## 2. 激活虚拟环境

```powershell
# Windows PowerShell
.\venv\Scripts\Activate.ps1
# 若提示执行策略限制：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# Windows cmd
venv\Scripts\activate.bat
```

```bash
# macOS / Linux
source venv/bin/activate
```

激活成功后命令行前出现 `(venv)`。**注意：激活只对当前终端会话有效**，跨命令执行若状态丢失，应直接使用 venv 内解释器的绝对路径：

```powershell
# Windows
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe main.py
```

```bash
# macOS / Linux
./venv/bin/python -m pip install -r requirements.txt
./venv/bin/python main.py
```

## 3. requirements.txt

- 用 write 工具创建，内容必须为**纯 ASCII**（中文注释在 Windows cp936 环境会被 pip 解码失败，触发 UnicodeDecodeError）。
- 版本要锁定，如 `flask==3.0.3`、`requests>=2.31,<3`。

导出当前环境锁定版本：`pip freeze > requirements.txt`。

## 4. 安装依赖与镜像源

```bash
pip install -r requirements.txt
# 网络慢/SSL 错误时换国内镜像
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## 5. 常见错误处理

- `ModuleNotFoundError: No module named 'xxx'`：venv 未激活或未安装依赖；用 `venv` 内 python 绝对路径重跑安装。
- `externally-managed-environment`：禁止 `--break-system-packages`，回到本规范创建 venv。
- 安装触发 Rust 编译失败：优先选有预编译 wheel 的包版本，或降级 Python 版本（3.11/3.12 生态 wheel 最全）。

## 6. .gitignore 必备项

```
venv/
__pycache__/
*.pyc
.env
```

## 7. 验证流程（收尾必须全部通过）

1. `pip install -r requirements.txt` 成功。
2. `python main.py`（使用 venv 内解释器）正常运行，无 ModuleNotFoundError。
