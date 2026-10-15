"""vector_to_blob / blob_to_vector 往返测试（SPEC §8.3）。"""

import numpy as np

from novel_forge_sidecar.services.vector_store import blob_to_vector, vector_to_blob


def test_blob_roundtrip() -> None:
    """随机向量打包再解包应还原（float32 精度内）。"""
    rng = np.random.default_rng(42)
    vec = [float(x) for x in rng.standard_normal(768)]
    restored = blob_to_vector(vector_to_blob(vec))
    assert len(restored) == len(vec)
    np.testing.assert_allclose(restored, vec, rtol=1e-6, atol=1e-7)


def test_blob_empty() -> None:
    assert blob_to_vector(vector_to_blob([])) == []


def test_blob_byte_length() -> None:
    """float32：每维 4 字节。"""
    blob = vector_to_blob([1.0, 2.0, 3.0])
    assert len(blob) == 12
