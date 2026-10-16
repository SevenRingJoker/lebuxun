"""Phase 6：GET /reward/status 奖励模型状态端点测试。"""

import json

import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

from novel_forge_sidecar.api import reward as reward_api
from novel_forge_sidecar.main import app
from novel_forge_sidecar.services.reward_model import RewardModel
from novel_forge_sidecar.services.text_features import FEATURE_DIM

# 复用 test_growth 的合成样本与训练辅助
from test_growth import _train


@pytest.fixture()
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_status_untrained(client: AsyncClient) -> None:
    """未训练（无 latest.json）：version 为 null，指标字段全为 null。"""
    resp = await client.get("/reward/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] is None
    assert body["accuracy"] is None
    assert body["kendallTau"] is None
    assert body["sampleCount"] is None
    assert body["trainedAt"] is None


async def test_status_after_training(client: AsyncClient) -> None:
    """训练 120 样本后：version=v1，accuracy>0.6，sampleCount/trainedAt 正确。"""
    await _train(client, 120)
    resp = await client.get("/reward/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == "v1"
    assert body["accuracy"] > 0.6
    assert -1.0 <= body["kendallTau"] <= 1.0
    assert body["sampleCount"] == 120
    assert isinstance(body["trainedAt"], int) and body["trainedAt"] > 0


async def test_status_legacy_pointer(client: AsyncClient, tmp_path, monkeypatch) -> None:
    """老格式 latest.json（仅 version 字段）：端点不炸，指标字段为 null。"""
    model_dir = tmp_path / "reward"
    model_dir.mkdir(parents=True)
    # 配一个合法 npz，保证模型可加载
    np.savez(
        model_dir / "v1.npz",
        weights=np.zeros(FEATURE_DIM),
        bias=np.float64(0.0),
        mean=np.zeros(FEATURE_DIM),
        std=np.ones(FEATURE_DIM),
        meta=np.array(json.dumps({"featureDim": FEATURE_DIM})),
    )
    (model_dir / "latest.json").write_text(
        json.dumps({"version": "v1"}, ensure_ascii=False), encoding="utf-8"
    )
    monkeypatch.setattr(reward_api, "_model", RewardModel(model_dir=model_dir))

    resp = await client.get("/reward/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == "v1"
    assert body["accuracy"] is None
    assert body["kendallTau"] is None
    assert body["sampleCount"] is None
    assert body["trainedAt"] is None
