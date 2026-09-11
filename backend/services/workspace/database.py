"""SQLite 数据库初始化与轻量异步兼容封装。

项目的数据量主要是本地会话、文件索引和 Agent Trace。为减少初学者需要安装的依赖，
本模块直接使用 Python 标准库 ``sqlite3``，再提供与原仓储代码一致的 ``await`` 接口。
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import weakref
from collections.abc import AsyncIterator, Callable, Iterable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from backend.core.config import get_settings

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    index_status TEXT NOT NULL DEFAULT 'idle',
    indexed_file_count INTEGER NOT NULL DEFAULT 0,
    last_opened_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    project_id TEXT,
    messages_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS file_index (
    project_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at REAL NOT NULL,
    PRIMARY KEY(project_id, relative_path),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pending_actions (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    action_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_commands (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    checkpoint_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    model TEXT NOT NULL,
    request_preview TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS trace_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(trace_id) REFERENCES traces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_preferences (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    base_url TEXT,
    include_in_auto INTEGER NOT NULL DEFAULT 1,
    auto_priority INTEGER NOT NULL DEFAULT 10,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    route TEXT NOT NULL,
    status TEXT NOT NULL,
    resumable INTEGER NOT NULL DEFAULT 1,
    request_json TEXT NOT NULL,
    state_json TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_session_updated
ON agent_checkpoints(session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      memory_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT
  );
  
  CREATE INDEX IF NOT EXISTS idx_agent_memories_lookup
  ON agent_memories(memory_type, scope_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS project_completed_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      title_key TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      target_files_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 100,
      completed_at TEXT NOT NULL
  );
  
  CREATE INDEX IF NOT EXISTS idx_completed_works_lookup
  ON project_completed_works(project_id, title_key, completed_at DESC);

  CREATE TABLE IF NOT EXISTS review_artifacts (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      agent_kind TEXT NOT NULL DEFAULT 'code',
      scope_id TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      digest_hash TEXT NOT NULL,
      output_json TEXT NOT NULL,
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_review_artifacts_work
  ON review_artifacts(work_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_review_artifacts_status
  ON review_artifacts(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS memory_eval (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      injected INTEGER NOT NULL DEFAULT 0,
      hit INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_eval_created
  ON memory_eval(created_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
      content,
      memory_type UNINDEXED,
      scope_id UNINDEXED
  );

  DROP TRIGGER IF EXISTS trg_agent_memories_fts_insert;
  DROP TRIGGER IF EXISTS trg_agent_memories_fts_delete;
  DROP TRIGGER IF EXISTS trg_agent_memories_fts_update;

  INSERT INTO agent_memories_fts(rowid, content, memory_type, scope_id)
  SELECT rowid, content, memory_type, scope_id FROM agent_memories
  WHERE NOT EXISTS (SELECT 1 FROM agent_memories_fts);

  CREATE TABLE IF NOT EXISTS listing_drafts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'US',
      draft_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'template',
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      confirmed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_listing_drafts_status
  ON listing_drafts(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS installed_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '0.0.0',
      description TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_format TEXT NOT NULL DEFAULT 'skill-md',
      content_json TEXT NOT NULL,
      files_json TEXT NOT NULL DEFAULT '{}',
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );
  """


class AsyncCursor:
    """把 ``sqlite3.Cursor`` 包装成仓储层可 ``await`` 的游标。"""

    def __init__(self, cursor: sqlite3.Cursor) -> None:
        """保存底层同步游标。"""

        self._cursor = cursor
        self.rowcount = cursor.rowcount

    async def fetchone(self) -> sqlite3.Row | None:
        """读取一行查询结果（在 worker 线程执行，避免阻塞事件循环）。"""

        return await asyncio.to_thread(self._cursor.fetchone)

    async def fetchall(self) -> list[sqlite3.Row]:
        """读取全部查询结果（在 worker 线程执行，避免阻塞事件循环）。"""

        return await asyncio.to_thread(self._cursor.fetchall)

    @property
    def lastrowid(self) -> int | None:
        """返回最近一次 INSERT 的 rowid。"""

        return self._cursor.lastrowid


class AsyncConnection:
    """为本地 SQLite 连接提供简单的异步外观。

    SQL 操作经 ``asyncio.to_thread`` 在 worker 线程执行，避免阻塞事件循环。
    协程被取消时已提交的 worker 操作无法被终止，因此 ``close`` 会先等待全部
    在途操作结束再真正关闭连接，防止连接在 C 层仍被其他线程使用时被关闭
    （Windows 下表现为 access violation / use-after-free）。
    """

    def __init__(self, connection: sqlite3.Connection) -> None:
        """保存底层连接。"""

        self._connection = connection
        self._pending: set[asyncio.Task[object]] = set()
        self._closed = False

    async def _dispatch(self, func: Callable[..., object], *args: object) -> object:
        """把同步 SQL 调用提交到 worker 线程，并登记在途任务。

        用 done_callback 而不是 finally 清理在途集合：协程被取消时任务仍会
        继续运行到结束，close 需要能等到它。
        """

        task = asyncio.get_running_loop().create_task(asyncio.to_thread(func, *args))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)
        return await task

    async def execute(self, sql: str, parameters: Iterable[Any] = ()) -> AsyncCursor:
        """执行单条 SQL 并返回异步游标（在 worker 线程执行）。"""

        return cast(
            AsyncCursor,
            await self._dispatch(self._execute, sql, tuple(parameters)),
        )

    def _execute(self, sql: str, parameters: tuple[Any, ...]) -> AsyncCursor:
        """在 worker 线程内完成同步执行与游标包装，保证 rowcount 读取同线程。"""

        return AsyncCursor(self._connection.execute(sql, parameters))

    async def executemany(self, sql: str, parameter_rows: Iterable[Iterable[Any]]) -> AsyncCursor:
        """批量执行同一条 SQL（在 worker 线程执行）。"""

        rows = [tuple(row) for row in parameter_rows]
        return cast(
            AsyncCursor,
            await self._dispatch(self._executemany, sql, rows),
        )

    def _executemany(self, sql: str, rows: list[tuple[Any, ...]]) -> AsyncCursor:
        return AsyncCursor(self._connection.executemany(sql, rows))

    async def executescript(self, sql: str) -> AsyncCursor:
        """执行包含多条语句的初始化脚本（在 worker 线程执行）。"""

        return cast(
            AsyncCursor,
            await self._dispatch(self._executescript, sql),
        )

    def _executescript(self, sql: str) -> AsyncCursor:
        return AsyncCursor(self._connection.executescript(sql))

    async def commit(self) -> None:
        """提交当前事务（在 worker 线程执行）。"""

        await self._dispatch(self._connection.commit)

    async def rollback(self) -> None:
        """回滚当前事务（在 worker 线程执行）。"""

        await self._dispatch(self._connection.rollback)

    async def close(self) -> None:
        """关闭数据库连接；先等待全部在途 worker 操作结束。"""

        if self._closed:
            return
        if self._pending:
            await asyncio.gather(*self._pending, return_exceptions=True)
        self._closed = True
        await asyncio.to_thread(self._connection.close)


def utc_now_iso() -> str:
    """返回带时区的 UTC ISO 时间字符串。"""

    return datetime.now(UTC).isoformat()


class _SharedConnectionState:
    """单个事件循环 + 数据库路径共享的连接状态。"""

    __slots__ = ("connection", "database_path", "depth", "lock", "owner")

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.lock = asyncio.Lock()
        self.connection: AsyncConnection | None = None
        self.owner: asyncio.Task[object] | None = None
        self.depth = 0


# 键为事件循环：服务器进程只有一个主循环（长生命周期连接），pytest-asyncio
# 每个测试新建循环（天然隔离不同 tmp 数据库），循环销毁后条目自动回收。
_shared_connections: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop,
    _SharedConnectionState,
] = weakref.WeakKeyDictionary()


def _get_shared_state(database_path: Path) -> _SharedConnectionState:
    """取当前循环的共享状态；数据库路径变化（如测试重定向）时重建。"""

    loop = asyncio.get_running_loop()
    state = _shared_connections.get(loop)
    if state is None or state.database_path != database_path:
        state = _SharedConnectionState(database_path)
        _shared_connections[loop] = state
    return state


def _new_async_connection(database_path: Path) -> AsyncConnection:
    """建立一条启用了外键约束的异步连接。"""

    # check_same_thread=False：AsyncConnection 的 SQL 操作经 asyncio.to_thread
    # 在 worker 线程执行，必须允许连接跨线程使用；外层 asyncio.Lock 保证同一
    # 时刻只有一个协程在用这条连接，事务不会交错。
    raw_connection = sqlite3.connect(
        database_path,
        timeout=30.0,
        check_same_thread=False,
    )
    raw_connection.row_factory = sqlite3.Row
    raw_connection.execute("PRAGMA foreign_keys=ON")
    return AsyncConnection(raw_connection)


@asynccontextmanager
async def open_database() -> AsyncIterator[AsyncConnection]:
    """获取共享 SQLite 连接，退出时自动提交、异常回滚。

    连接按「事件循环 + 数据库路径」缓存复用，省去每次操作的 connect/PRAGMA
    开销；``asyncio.Lock`` 保证事务串行。同一任务内的嵌套调用（例如一个仓储
    函数内部再开一次）复用外层连接与事务，提交权归最外层，避免自锁死锁。
    """

    database_path = get_settings().database_path
    database_path.parent.mkdir(parents=True, exist_ok=True)
    state = _get_shared_state(database_path)
    current_task = cast("asyncio.Task[object]", asyncio.current_task())
    if state.connection is not None and state.owner is current_task:
        state.depth += 1
        try:
            yield state.connection
        finally:
            state.depth -= 1
        return
    async with state.lock:
        if state.connection is None:
            state.connection = _new_async_connection(database_path)
        state.owner = current_task
        state.depth = 1
        try:
            yield state.connection
            await state.connection.commit()
        except Exception:
            await state.connection.rollback()
            raise
        finally:
            state.owner = None
            state.depth = 0


async def initialize_database() -> None:
    """创建应用所需的数据表，并应用版本化迁移。"""

    async with open_database() as connection:
        await connection.executescript(SCHEMA_SQL)
    # 延迟导入避免与 migrations 模块的循环依赖。
    from backend.services.workspace.migrations import apply_migrations

    await apply_migrations()


def dumps_json(value: object) -> str:
    """把 Python 对象序列化为可读的 UTF-8 JSON 字符串。"""

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def loads_json(value: str, default: object) -> object:
    """安全解析数据库 JSON；解析失败时返回默认值。"""

    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


async def rebuild_memory_fts() -> None:
    """整体重建记忆 FTS 索引（删除/淘汰后调用，保证索引一致）。"""

    async with open_database() as connection:
        await connection.execute("DELETE FROM agent_memories_fts")
        await connection.execute(
            """
            INSERT INTO agent_memories_fts(rowid, content, memory_type, scope_id)
            SELECT rowid, content, memory_type, scope_id FROM agent_memories
            """
        )


def normalize_root_path(raw_path: str) -> Path:
    """把用户选择的项目目录转换为已存在的绝对目录。"""

    path = Path(raw_path).expanduser().resolve()
    if not path.is_dir():
        raise ValueError(f"项目目录不存在或不是文件夹：{path}")
    return path
