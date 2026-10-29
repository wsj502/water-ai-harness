#!/usr/bin/env python3
"""envload —— 从项目外部安全加载凭据（明文 env 或 DPAPI 密文）并注入子进程。

设计目标：
  1. 凭据文件物理移出项目目录：防误提交 git、防同步盘/备份带走、防工具链扫描项目树
  2. 严格按"数据"解析：绝不执行文件内容（区别于 `source .env` / shell eval）
  3. 任何输出只打印键名，永不打印值
  4. 启动前做文件位置/权限自检，发现问题显式警告（不静默放行）

用法：
    python tools/envload.py                          # 默认来源加载并启动 DEFAULT_CMD
    python tools/envload.py --env-file D:\\secrets\\app.env
    python tools/envload.py --print-keys             # 自检：只打印键名不启动
    python tools/envload.py -- python -m uvicorn ... # 自定义子命令

默认凭据来源查找顺序：
    1. --env-file 参数
    2. 环境变量 <APP_NAME_UPPER>_ENV_FILE（若已设置）
    3. %USERPROFILE%\\.<APP_NAME>\\secrets.dpapi（DPAPI 密文，优先）
    4. %USERPROFILE%\\.<APP_NAME>\\.env（明文，仅过渡用）

凭据文件支持两种形态，自动识别：
  - DPAPI 密文（DPE1 头）：内存解密，明文不落盘——推荐，见 tools/dpapi_env.py
  - 明文 KEY=VALUE：仅作过渡，位置/权限自检会给出警告
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

# ================= 部署时修改这三处 =================
APP_NAME = "water"                     # 存储目录名与熵前缀，全小写
PROJECT_ROOT = Path(__file__).resolve().parent.parent  # tools/ 的上级；结构不同则显式改
DEFAULT_CMD: list[str] | None = None   # 缺省子进程，例：["python", "-m", "uvicorn", "app:app"]
# ====================================================

_ENV_VAR = f"{APP_NAME.upper().replace('-', '_')}_ENV_FILE"
DEFAULT_ENV_FILE = Path(os.environ.get("USERPROFILE", ".")) / f".{APP_NAME}" / ".env"
DEFAULT_DPAPI_STORE = Path(os.environ.get("USERPROFILE", ".")) / f".{APP_NAME}" / "secrets.dpapi"
DPAPI_MAGIC = b"DPE1"

# 键名必须是合法 shell 标识符，防止畸形行注入奇怪的环境变量名
_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_env_text(text: str, source: str = "<env>") -> dict[str, str]:
    """严格解析 KEY=VALUE 行。绝不执行内容；语法错误行报错而非猜测。

    规则：
      - 空行、# 开头的整行注释：跳过
      - KEY=VALUE：首个 = 分割；值可含后续 =
      - 双引号值支持 \\\\ 与 \\" 转义；单引号值纯字面量
      - 无引号值：去除首尾空白，并按 ' #' 截掉行内注释
      - 键名不合法 / 行内无 = ：报错（宁可 fail-fast 也不静默吞掉凭据行）
    """
    env: dict[str, str] = {}
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"{source}:{lineno} 无 '=' 分隔符，拒绝猜测解析：{line[:20]}...")
        key, _, value = line.partition("=")
        key = key.strip()
        if not _KEY_RE.match(key):
            raise ValueError(f"{source}:{lineno} 非法键名：{key!r}")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            quote, value = value[0], value[1:-1]
            if quote == '"':  # 双引号内支持 \\ 与 \" 转义（与序列化端对称）
                value = value.replace('\\"', '"').replace("\\\\", "\\")
        else:
            hash_at = value.find(" #")  # 无引号值才支持行内注释
            if hash_at >= 0:
                value = value[:hash_at].rstrip()
        env[key] = value
    return env


def parse_env_file(path: Path) -> dict[str, str]:
    return parse_env_text(path.read_text(encoding="utf-8-sig"), path.name)


def load_env(path: Path) -> dict[str, str]:
    """加载凭据：DPE1 密文走 DPAPI 内存解密，否则按明文 env 解析。"""
    raw = path.read_bytes()
    if raw.startswith(DPAPI_MAGIC):
        from dpapi_env import dpapi_unprotect_text  # 延迟导入（同目录）
        return parse_env_text(dpapi_unprotect_text(raw), path.name)
    return parse_env_text(raw.decode("utf-8-sig"), path.name)


def check_location(path: Path) -> list[str]:
    """位置自检：凭据文件不应留在项目目录或常见同步盘内。"""
    warnings: list[str] = []
    resolved = path.resolve()
    if str(resolved).startswith(str(PROJECT_ROOT)):
        warnings.append(
            f"凭据文件仍在项目目录内（{resolved}），未获得隔离收益；"
            f"建议移至 {DEFAULT_ENV_FILE}"
        )
    sync_hints = ("onedrive", "baidunetdisk", "dropbox", "nutstore", "googledrive")
    if any(h in str(resolved).lower() for h in sync_hints):
        warnings.append(f"凭据文件疑似位于同步盘目录（{resolved}），会被云端复制！")
    return warnings


def check_acl(path: Path) -> list[str]:
    """权限自检（尽力而为）：发现 Everyone/Users 可读写即警告。"""
    warnings: list[str] = []
    try:
        out = subprocess.run(
            ["icacls", str(path)], capture_output=True, text=True, timeout=10
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return [f"无法执行 icacls 检查 {path.name} 的权限，请人工确认仅当前用户可读"]
    for line in out.splitlines():
        upper = line.upper()
        if ("EVERYONE" in upper or "BUILTIN\\USERS" in upper) and re.search(
            r"\((F|M|R|RX|W)[,) ]", upper
        ):
            warnings.append(
                f"{path.name} 对 Everyone/Users 组开放了权限：{line.strip()}。"
                f'建议执行：icacls "{path}" /inheritance:r /grant:r "%USERNAME%:R"'
            )
            break
    return warnings


def _resolve_env_file(cli_arg: str | None) -> Path:
    if cli_arg:
        return Path(cli_arg)
    if os.environ.get(_ENV_VAR):
        return Path(os.environ[_ENV_VAR])
    if DEFAULT_DPAPI_STORE.is_file():
        return DEFAULT_DPAPI_STORE
    return DEFAULT_ENV_FILE


def main() -> int:
    ap = argparse.ArgumentParser(description="安全加载外部凭据（明文 env 或 DPAPI 密文）并启动子进程")
    ap.add_argument("--env-file", default=None,
                    help="凭据文件路径（明文 .env 或 DPE1 密文均可，自动识别）")
    ap.add_argument("--print-keys", action="store_true",
                    help="只打印加载到的键名（不打印值）后退出，不启动子进程")
    ap.add_argument("cmd", nargs=argparse.REMAINDER,
                    help="-- 之后的自定义子命令；缺省用 DEFAULT_CMD")
    args = ap.parse_args()

    env_file = _resolve_env_file(args.env_file)
    if not env_file.is_file():
        print(f"[envload] 未找到凭据文件：{env_file}", file=sys.stderr)
        print(f"[envload] 明文过渡：创建 {DEFAULT_ENV_FILE}", file=sys.stderr)
        print(f"[envload] DPAPI 推荐：python tools/dpapi_env.py import --from <明文.env>", file=sys.stderr)
        return 1

    try:
        loaded = load_env(env_file)
    except (ValueError, UnicodeDecodeError, OSError) as exc:
        print(f"[envload] 凭据加载失败：{exc}", file=sys.stderr)
        return 1

    if not loaded:
        print(f"[envload] 凭据文件为空：{env_file}", file=sys.stderr)
        return 1

    # 自检警告（不阻断，但显式告知）；DPAPI 密文不依赖文件 ACL 兜底，跳过检查
    is_dpapi = env_file.read_bytes()[:4] == DPAPI_MAGIC
    if not is_dpapi:
        for w in check_location(env_file) + check_acl(env_file):
            print(f"[envload] [警告] {w}", file=sys.stderr)

    # 永不打印值——只打印键名与文件路径
    print(f"[envload] 已从 {env_file} 加载 {len(loaded)} 个变量："
          f"{', '.join(sorted(loaded))}")

    if args.print_keys:
        return 0

    cmd = args.cmd
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        if DEFAULT_CMD is None:
            print("[envload] 未配置 DEFAULT_CMD 且未提供子命令", file=sys.stderr)
            return 1
        cmd = [sys.executable if c == "python" else c for c in DEFAULT_CMD]

    env = os.environ.copy()
    env.update(loaded)

    # Windows：CreateProcess 不查 PATHEXT，npm 全局命令是 .cmd shim，
    # 必须用 shutil.which 解析出真实路径，.cmd/.bat 再包一层 cmd /c
    if os.name == "nt":
        import shutil
        resolved = shutil.which(cmd[0])
        if resolved:
            cmd[0] = resolved
        if re.search(r"\.(cmd|bat)$", cmd[0], re.IGNORECASE):
            cmd = [os.environ.get("COMSPEC", "cmd.exe"), "/c"] + cmd

    print(f"[envload] 启动子进程：{' '.join(cmd[:2])} ...（环境变量仅注入子进程，不落盘不回显）")
    try:
        return subprocess.call(cmd, env=env, cwd=PROJECT_ROOT)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
