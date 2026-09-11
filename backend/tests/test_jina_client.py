"""Jina 客户端单元测试：批次拆分、限速与请求/解析（MockTransport，不联网）。"""

from __future__ import annotations

import json
import time

import httpx
import pytest

from backend.core.config import get_settings
from backend.services.embeddings.jina_client import (
    JINA_EMBEDDINGS_ENDPOINT,
    JinaClient,
    JinaError,
)


def test_missing_key_raises_jina_error(monkeypatch, tmp_path) -> None:
    """未配置任何密钥时应抛出可识别的 JinaError。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("JINA_API_KEY", raising=False)
    get_settings.cache_clear()
    try:
        with pytest.raises(JinaError, match="Jina API Key"):
            JinaClient()
    finally:
        get_settings.cache_clear()


def test_estimate_tokens_is_conservative() -> None:
    """token 估算按 2 字符 1 token 并带基础开销，宁多不少。"""

    assert JinaClient._estimate_text_tokens("") == 8  # max(1, 0 // 2 + 8)
    assert JinaClient._estimate_text_tokens("ab") == 9  # max(1, 1 + 8)
    # 中文（每字按 2 字符折算）估算值不低于实际调用方预期下限。
    assert JinaClient._estimate_text_tokens("四个汉字") == 10


def test_split_batches_respects_max_batch_and_call_tokens() -> None:
    """批次拆分同时受条数上限与单请求 token 上限约束。"""

    client = JinaClient(api_key="k", max_batch=2, max_call_tokens=10_000)
    batches = client._split_batches(["a", "b", "c"])
    assert [len(batch) for batch in batches] == [2, 1]

    # 把单请求 token 上限压到极小，迫使每批一条。
    tiny = JinaClient(api_key="k", max_batch=64, max_call_tokens=5)
    batches = tiny._split_batches(["一条很长的文本", "另一条文本", "第三条"])
    assert [len(batch) for batch in batches] == [1, 1, 1]


@pytest.mark.asyncio
async def test_embed_texts_orders_vectors_by_index() -> None:
    """乱序返回的 embedding 应按 index 重组，并解析用量。"""

    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("Authorization")
        captured["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": [0.3, 0.4]},
                    {"index": 0, "embedding": [0.1, 0.2]},
                ],
                "usage": {"prompt_tokens": 12, "total_tokens": 20},
            },
        )

    client = JinaClient(api_key="secret-key", transport=httpx.MockTransport(handler))
    vectors, usage = await client.embed_texts(["第一段", "第二段"])

    assert captured["auth"] == "Bearer secret-key"
    payload = captured["payload"]
    assert payload["task"] == "retrieval.passage"  # 默认索引侧 task
    assert payload["input"] == ["第一段", "第二段"]
    assert vectors == [[0.1, 0.2], [0.3, 0.4]]
    assert usage.prompt_tokens == 12
    assert usage.total_tokens == 20


@pytest.mark.asyncio
async def test_embed_texts_with_empty_input_skips_http() -> None:
    """空输入不发起网络请求。"""

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("空输入不应触发网络请求")

    client = JinaClient(api_key="k", transport=httpx.MockTransport(handler))
    vectors, usage = await client.embed_texts(["", "   "])
    assert vectors == []
    assert usage.total_tokens == 0


@pytest.mark.asyncio
async def test_embed_texts_unauthorized_fails_fast() -> None:
    """401 不在重试白名单内，应立即抛错且只请求一次。"""

    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(401, json={"error": "bad key"})

    client = JinaClient(api_key="bad", retries=3, transport=httpx.MockTransport(handler))
    with pytest.raises(JinaError, match="401"):
        await client.embed_texts(["文本"])
    assert calls["count"] == 1


@pytest.mark.asyncio
async def test_rerank_parses_results() -> None:
    """rerank 响应解析出 index/score/document。"""

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["query"] == "货架"
        assert payload["top_n"] == 2  # top_n 收敛到候选数以内
        return httpx.Response(
            200,
            json={
                "results": [
                    {"index": 1, "relevance_score": 0.9, "document": "B"},
                    {"index": 0, "relevance_score": 0.5, "document": "A"},
                ]
            },
        )

    client = JinaClient(api_key="k", transport=httpx.MockTransport(handler))
    results = await client.rerank("货架", ["A", "B"], top_n=5)
    assert results == [
        {"index": 1, "score": 0.9, "document": "B"},
        {"index": 0, "score": 0.5, "document": "A"},
    ]


@pytest.mark.asyncio
async def test_rate_budget_waits_for_window_to_roll() -> None:
    """窗口内额度耗尽时应等待窗口滚动后放行。"""

    client = JinaClient(api_key="k", tokens_per_minute=100, window_seconds=0.2)
    client._record_usage_window(99)

    started = time.monotonic()
    await client._acquire_rate_budget(5)
    elapsed = time.monotonic() - started
    assert elapsed >= 0.15
    # 等待后窗口内旧记录已过期，可继续预留。
    client._record_usage_window(5)


def test_endpoint_constants_use_hosted_api() -> None:
    """防呆：端点必须指向 Jina 托管 API。"""

    assert JINA_EMBEDDINGS_ENDPOINT.startswith("https://api.jina.ai/")
