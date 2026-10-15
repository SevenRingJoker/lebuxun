"""向量存储。

- vector_to_blob / blob_to_vector：SPEC §8.3 的真实实现（float32 二进制打包）。
- VectorStore：Phase 1 用标准库 sqlite3 存 blob，查询时在内存中暴力算余弦相似度；
  后续接入 sqlite-vec 虚表时保持同一接口即可。
"""

from __future__ import annotations

import sqlite3
import struct

import numpy as np

from novel_forge_sidecar.models.schemas import RagChunk, SceneType


def vector_to_blob(vec: list[float]) -> bytes:
    """SPEC §8.3：float32 数组 → BLOB。"""
    return struct.pack(f"{len(vec)}f", *vec)


def blob_to_vector(blob: bytes) -> list[float]:
    """SPEC §8.3：BLOB → float32 数组。"""
    n = len(blob) // 4
    return list(struct.unpack(f"{n}f", blob))


class VectorStore:
    """RAG 向量库，按 style_id 隔离。"""

    def __init__(self, db_path: str = ":memory:") -> None:
        self.conn = sqlite3.connect(db_path)
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rag_chunks (
                id TEXT PRIMARY KEY,
                style_id TEXT NOT NULL,
                book_id TEXT NOT NULL,
                chapter_index INTEGER,
                text TEXT NOT NULL,
                scene_type TEXT NOT NULL,
                vector BLOB
            )
            """
        )
        self.conn.commit()

    def upsert(
        self,
        style_id: str,
        chunks: list[RagChunk],
        vectors: list[list[float]],
    ) -> None:
        """写入（或覆盖）一批 chunk 及其向量。"""
        rows = [
            (
                c.id,
                style_id,
                c.book_id,
                c.chapter_index,
                c.text,
                c.scene_type.value,
                vector_to_blob(v),
            )
            for c, v in zip(chunks, vectors)
        ]
        self.conn.executemany(
            """
            INSERT OR REPLACE INTO rag_chunks
                (id, style_id, book_id, chapter_index, text, scene_type, vector)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        self.conn.commit()

    def query(
        self,
        style_id: str,
        query_vector: list[float],
        scene_type: SceneType | None,
        top_k: int,
    ) -> list[RagChunk]:
        """余弦相似度取 top_k，可按场景过滤。"""
        sql = "SELECT id, book_id, chapter_index, text, scene_type, vector FROM rag_chunks WHERE style_id = ?"
        params: list[object] = [style_id]
        if scene_type is not None:
            sql += " AND scene_type = ?"
            params.append(scene_type.value)

        q = np.asarray(query_vector, dtype=np.float32)
        q_norm = np.linalg.norm(q)
        scored: list[tuple[float, RagChunk]] = []
        for cid, book_id, chapter_index, text, st, blob in self.conn.execute(sql, params):
            if blob is None:
                continue
            v = np.asarray(blob_to_vector(blob), dtype=np.float32)
            denom = q_norm * np.linalg.norm(v)
            sim = float(np.dot(q, v) / denom) if denom > 0 else 0.0
            scored.append(
                (
                    sim,
                    RagChunk(
                        id=cid,
                        style_id=style_id,
                        book_id=book_id,
                        chapter_index=chapter_index,
                        text=text,
                        scene_type=SceneType(st),
                    ),
                )
            )
        scored.sort(key=lambda x: x[0], reverse=True)
        return [chunk for _, chunk in scored[:top_k]]

    def close(self) -> None:
        self.conn.close()
