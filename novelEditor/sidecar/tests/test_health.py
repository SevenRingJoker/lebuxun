"""/health 端点测试。"""

from httpx import ASGITransport, AsyncClient

from novel_forge_sidecar import __version__
from novel_forge_sidecar.main import app


async def test_health_returns_ok() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["version"] == __version__
