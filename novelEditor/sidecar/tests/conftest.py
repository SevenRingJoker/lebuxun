"""全局测试夹具：把服务单例的模型目录重定向到 tmp_path，避免污染仓库。"""

import os
import tempfile

# 必须在导入 app 模块之前设置：api 模块 import 时即建运行时单例。
# - NV_DATA_DIR：档案 / 向量库 / 判别器模型全部写到临时目录；
# - NV_OLLAMA_HOST：指向废弃端口，强制 Embedder 健康探测回退 Mock（离线确定性）；
# - NV_STYLE_LLM_MODEL：空串跳过 LLM 风格分析。
os.environ.setdefault("NV_DATA_DIR", tempfile.mkdtemp(prefix="nv-test-data-"))
os.environ.setdefault("NV_OLLAMA_HOST", "http://127.0.0.1:9")
os.environ.setdefault("NV_STYLE_LLM_MODEL", "")

import pytest

from novel_forge_sidecar.api import evolution as evolution_api
from novel_forge_sidecar.api import reward as reward_api
from novel_forge_sidecar.services.evolution import EvolutionLearner
from novel_forge_sidecar.services.prompt_evolver import PromptEvolver
from novel_forge_sidecar.services.reward_model import RewardModel


@pytest.fixture(autouse=True)
def _isolated_model_dirs(tmp_path, monkeypatch):
    """奖励模型 / 演化模板 / 提示词模板全部写入临时目录。"""
    model = RewardModel(model_dir=tmp_path / "reward")
    learner = EvolutionLearner(model_dir=tmp_path / "evolution")
    evolver = PromptEvolver(model_dir=tmp_path / "evolution", evolution_learner=learner)
    monkeypatch.setattr(reward_api, "_model", model)
    monkeypatch.setattr(evolution_api, "_learner", learner)
    monkeypatch.setattr(evolution_api, "_evolver", evolver)
