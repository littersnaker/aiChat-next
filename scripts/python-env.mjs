/**
 * 模块职责：让 npm scripts 无需先激活虚拟环境，也能使用项目自己的 Python 与命令行工具。
 *
 * 解析顺序与 scripts/build-electron.ts 保持一致：显式配置优先，其次项目 .venv，
 * 最后才回退到 PATH。用法：
 *   node scripts/python-env.mjs python -m backend.main --host 127.0.0.1 --port 3100
 *   node scripts/python-env.mjs tool ruff check backend
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const isWindows = process.platform === "win32";
const venvDirectory = path.join(rootDirectory, ".venv");
const venvBinDirectory = path.join(venvDirectory, isWindows ? "Scripts" : "bin");

/**
 * 返回候选解释器路径，.venv 优先于 PATH 上的全局解释器。
 */
function pythonCandidates() {
  const candidates = [];
  const configured = process.env.PYTHON_EXECUTABLE?.trim();
  if (configured) candidates.push(configured);
  candidates.push(path.join(venvBinDirectory, isWindows ? "python.exe" : "python"));
  candidates.push(isWindows ? "python" : "python3");
  candidates.push("python");
  return candidates;
}

/**
 * 只接受可执行文件存在（PATH 候选交给 spawn 自行解析）。
 */
function isRunnable(candidate) {
  return !candidate.includes(path.sep) || fs.existsSync(candidate);
}

/**
 * 解析项目解释器；找不到时给出可操作的报错，而不是任其抛出 ModuleNotFoundError。
 */
function resolvePython() {
  for (const candidate of pythonCandidates()) {
    if (isRunnable(candidate)) return candidate;
  }
  throw new Error(
    "未找到可用的 Python 解释器。请先创建虚拟环境并安装依赖：\n" +
      "  python -m venv .venv\n" +
      (isWindows
        ? "  .venv\\Scripts\\python -m pip install -r requirements-dev.txt\n"
        : "  .venv/bin/python -m pip install -r requirements-dev.txt\n") +
      "或显式指定 PYTHON_EXECUTABLE 指向正确的解释器。",
  );
}

/**
 * 解析虚拟环境内的命令行工具（ruff / black / pytest 等），回退到 PATH。
 */
function resolveTool(name) {
  const local = path.join(venvBinDirectory, isWindows ? `${name}.exe` : name);
  return fs.existsSync(local) ? local : name;
}

/**
 * 启动子进程并转发退出码与中断信号，保证 Ctrl+C 和 concurrently -k 能正常收敛。
 */
function run(command, args) {
  const child = spawn(command, args, { cwd: rootDirectory, stdio: "inherit", env: process.env });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.on("error", (error) => {
    console.error(`无法启动 ${command}：${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === "python") {
  run(resolvePython(), rest);
} else if (mode === "tool" && rest.length > 0) {
  run(resolveTool(rest[0]), rest.slice(1));
} else {
  console.error(
    "用法：node scripts/python-env.mjs python <参数...>\n" +
      "      node scripts/python-env.mjs tool <工具名> <参数...>",
  );
  process.exit(2);
}
