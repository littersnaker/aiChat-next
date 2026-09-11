# 安装 Python 与项目依赖

给第一次跑这个项目的人看的。推荐 **Python 3.13 或更高版本**（仓库 `.python-version` 记录的是 3.14.6，两者都能正常运行）。

## 一、一条命令自动安装（推荐）

在项目根目录打开终端，执行对应系统的脚本，它会自动完成「创建 `.venv` → 安装 Python 依赖 → 检查 Node/pnpm → 安装前端依赖 → 生成 `.env.local`」：

Windows PowerShell：

```powershell
.\setup-windows.ps1
```

macOS / Linux：

```bash
bash setup-macos-linux.sh
```

脚本执行完会提示你配置模型 API Key，然后就能直接 `pnpm dev`。两个脚本都只会创建缺失的 `.venv`，不会覆盖已有环境。

> macOS 脚本默认查找 `python3.13`。如果你装的是更高版本，用 `PYTHON_EXECUTABLE` 指定，例如 `PYTHON_EXECUTABLE=python3.14 bash setup-macos-linux.sh`。

如果脚本中途报错，按下面的手动步骤排查。

## 二、手动安装

### 1. 检查现有环境

Windows PowerShell：

```powershell
node --version
pnpm --version
py -3.13 --version
```

macOS：

```bash
node --version
pnpm --version
python3.13 --version
```

哪条提示「找不到命令」，就先装对应的东西。Python 从 [python.org](https://www.python.org/downloads/) 下载；Windows 安装时务必勾选 **Add python.exe to PATH**；macOS 也可以用 `brew install python@3.13`。

### 2. 创建虚拟环境并装依赖

虚拟环境相当于 Python 项目专属的 `node_modules`，避免不同项目的依赖互相污染。

Windows PowerShell：

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

macOS：

```bash
python3.13 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements-dev.txt
```

两个 requirements 文件的区别：

- `requirements.txt`：运行后端必需的 FastAPI、Uvicorn、HTTP 客户端和 Windows 时区数据等；
- `requirements-dev.txt`：在运行依赖之上增加 PyInstaller 和 pytest 等测试工具。

### 3. 安装 Node 和 pnpm

本项目最低要求 Node 22.12，推荐 Node 24 LTS。

```bash
npm install --global pnpm@10.12.1
```

或者在带 Corepack 的 Node 中：

```bash
corepack enable
corepack prepare pnpm@10.12.1 --activate
```

然后在项目根目录安装前端依赖：

```bash
pnpm install
```

### 4. 准备环境变量

交付压缩包不含 `.env.local`（内含密钥，不要提交或外发）。新机器上复制一份模板：

Windows：

```powershell
Copy-Item env.example .env.local
```

macOS：

```bash
cp env.example .env.local
```

然后至少配置一个模型供应商 Key，或在应用设置界面里录入。

## 三、无需激活虚拟环境

**推荐直接用 `pnpm` 命令，不用手动激活**。项目里的 npm 脚本会自动定位 `.venv`（找不到才回退到系统 Python），所以依赖装在 `.venv` 里就够了。

如果你想手动激活也可以，激活后命令行前面会出现 `(.venv)`：

Windows PowerShell：

```powershell
.\.venv\Scripts\Activate.ps1
```

macOS：

```bash
source .venv/bin/activate
```

PowerShell 若因执行策略拦截激活脚本：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

## 四、启动项目

```bash
pnpm dev
```

会同时拉起三样东西：

| 服务 | 地址 |
| --- | --- |
| Vite 前端 | http://127.0.0.1:5173/ |
| FastAPI 后端 | http://127.0.0.1:3100/api/health |
| Electron 窗口 | 自动打开 |

正常日志会包含 `VITE ... Local: http://127.0.0.1:5173/` 和 `Application startup complete`。

只单独调试后端：

```bash
.venv/bin/python -m backend.main        # macOS；Windows 用 .\.venv\Scripts\python.exe
```

这时后端监听默认端口 8765，可打开 http://127.0.0.1:8765/api/docs 查看接口文档。

## 五、常见问题

**`ModuleNotFoundError: No module named 'uvicorn'`**
依赖没装进项目用的解释器。确认 `.venv` 在项目根目录，然后重跑第 2 步的 pip 安装命令。只要不是手动调用系统 `python`，`pnpm dev` 会自己用 `.venv`。

**pip 下载慢或超时**
先 `python -m pip install --upgrade pip` 再重试；企业网络需要代理时，在终端设置 `HTTPS_PROXY` 后重试，不要把带账号密码的代理写进 Git。

**Electron 找不到 Python / 想指定别的解释器**

Windows：

```powershell
$env:PYTHON_EXECUTABLE="$PWD\.venv\Scripts\python.exe"
pnpm dev
```

macOS：

```bash
PYTHON_EXECUTABLE="$PWD/.venv/bin/python" pnpm dev
```

**虚拟环境损坏需要重装**
删除 `.venv` 重建即可，别删源码和 `.env.local`：

Windows：

```powershell
Remove-Item -Recurse -Force .venv
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

macOS：

```bash
rm -rf .venv
python3.13 -m venv .venv
./.venv/bin/python -m pip install -r requirements-dev.txt
```

## 六、打包（可选）

```bash
pnpm electron:make
```

前端、Electron 主进程和 Python 后端会一起打包，产物在 `release/`。Windows 也可直接运行 `.\build-windows-installer.ps1`。
