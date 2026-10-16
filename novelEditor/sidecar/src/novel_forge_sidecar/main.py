"""FastAPI 应用与启动入口。

端口协议（SPEC §2）：
- 由 Main 进程 spawn：`py -3 -m novel_forge_sidecar.main`（或调用 run()）。
- 端口传 0 动态分配，启动后在 **stdout 第一行** 打印
  `{"port": <实际端口>, "status": "ready"}` 并 flush，供 Main 读取。
- 同时保留 `uvicorn novel_forge_sidecar.main:app` 直接启动的可行性。
"""

from __future__ import annotations

import json

import uvicorn
from fastapi import FastAPI

from novel_forge_sidecar import __version__
from novel_forge_sidecar.api import (
    discriminator,
    embed,
    evolution,
    health,
    lora,
    rag,
    reward,
    scene,
    style,
)

app = FastAPI(title="NovelForge Sidecar", version=__version__)

# 路由注册
app.include_router(health.router)
app.include_router(style.router)
app.include_router(embed.router)
app.include_router(rag.router)
app.include_router(discriminator.router)
app.include_router(reward.router)
app.include_router(evolution.router)
app.include_router(scene.router)
app.include_router(lora.router)


def run() -> None:
    """供 Main 进程调用的启动入口：先绑定 0 端口拿到实际端口，打印就绪 JSON 后再 serve。"""
    config = uvicorn.Config(app=app, host="127.0.0.1", port=0, log_level="warning")
    # 先自行 bind 端口 0，拿到内核分配的真实端口
    sock = config.bind_socket()
    port: int = sock.getsockname()[1]
    # stdout 第一行输出端口 JSON（uvicorn 日志走 stderr，不干扰）
    print(json.dumps({"port": port, "status": "ready"}), flush=True)
    server = uvicorn.Server(config)
    server.run(sockets=[sock])


if __name__ == "__main__":
    run()
