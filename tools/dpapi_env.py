#!/usr/bin/env python3
"""dpapi_env —— Windows DPAPI 加密存储凭据，解密仅发生在内存。

存储形态：整个 env 文本加密为单个二进制 blob（magic 'DPE1' + DPAPI 密文）。

安全属性：
  - 仅【当前 Windows 用户 + 本机】可解密（DPAPI 用户作用域）
  - 附加应用熵（ENTROPY）：即使拿到用户句柄，其他程序不知熵也无法解密
  - CRYPTPROTECT_UI_FORBIDDEN：解密过程不弹任何系统对话框，可无人值守
  - 文件被拷贝到其他机器/其他用户即失效（密钥派生自用户口令+机器状态）
  - 明文只在内存中存在，从不回显、不写临时文件

子命令：
  import      从明文 .env 导入并加密（导入后提示安全删除明文）
  print-keys  解密并列出键名（永不打印值）
  run         解密注入环境变量并启动子进程（缺省为 envload 的 DEFAULT_CMD）

零新增依赖：ctypes 直调 crypt32.dll（Windows 自带）。

已知边界：本机账户【重置密码】后密文不可恢复（域账户有备份密钥不受此限）；
修改 ENTROPY 会使所有已存密文作废。
"""
from __future__ import annotations

import argparse
import ctypes
import os
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path

# ================= 部署时修改 =================
APP_NAME = "water"  # 与 envload.py 保持一致
# =============================================

MAGIC = b"DPE1\n"
# 应用熵：额外一层"知道算法也解不开"的门槛；改动它 = 所有已存密文作废
ENTROPY = f"{APP_NAME}::dpapi::v1".encode("utf-8")
DEFAULT_STORE = (
    Path(os.environ.get("USERPROFILE", ".")) / f".{APP_NAME}" / "secrets.dpapi"
)
CRYPTPROTECT_UI_FORBIDDEN = 0x1


# ---------------------------------------------------------------- DPAPI 原语
class _DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


if os.name == "nt":
    _crypt32 = ctypes.windll.crypt32
    _kernel32 = ctypes.windll.kernel32


def _to_blob(data: bytes) -> tuple["_DATA_BLOB", "ctypes.Array"]:
    """bytes -> DATA_BLOB；返回 (blob, 缓冲区)，调用期间必须持有缓冲区引用。"""
    buf = ctypes.create_string_buffer(bytes(data), len(data))
    blob = _DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    return blob, buf


def _from_blob(blob: "_DATA_BLOB") -> bytes:
    try:
        return ctypes.string_at(blob.pbData, blob.cbData)
    finally:
        _kernel32.LocalFree(blob.pbData)


def dpapi_protect(plain: bytes) -> bytes:
    """加密（用户作用域）。返回不含 magic 的裸密文。"""
    if os.name != "nt":
        raise RuntimeError("DPAPI 仅支持 Windows；非 Windows 请用明文 env + chmod 600 降级方案")
    in_blob, _ib = _to_blob(plain)
    ent_blob, _eb = _to_blob(ENTROPY)
    out_blob = _DATA_BLOB()
    if not _crypt32.CryptProtectData(
        ctypes.byref(in_blob),
        f"{APP_NAME} secrets",           # 描述串，会留在密文头里（不敏感）
        ctypes.byref(ent_blob),
        None, None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out_blob),
    ):
        raise ctypes.WinError()
    return _from_blob(out_blob)


def dpapi_unprotect(blob_with_magic: bytes) -> bytes:
    """解密（含 magic 校验）。失败抛 WinError（非本用户/非本机/熵不符/被篡改）。"""
    if not blob_with_magic.startswith(MAGIC):
        raise ValueError("不是 DPE1 格式密文（缺少 magic 头）")
    in_blob, _ib = _to_blob(blob_with_magic[len(MAGIC):])
    ent_blob, _eb = _to_blob(ENTROPY)
    out_blob = _DATA_BLOB()
    if not _crypt32.CryptUnprotectData(
        ctypes.byref(in_blob),
        None,
        ctypes.byref(ent_blob),
        None, None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out_blob),
    ):
        raise ctypes.WinError()
    return _from_blob(out_blob)


def dpapi_unprotect_text(blob_with_magic: bytes) -> str:
    return dpapi_unprotect(blob_with_magic).decode("utf-8")


def dpapi_protect_text(text: str) -> bytes:
    return MAGIC + dpapi_protect(text.encode("utf-8"))


# ---------------------------------------------------------------- 子命令
def _tighten_acl(path: Path) -> None:
    """收紧密文文件 ACL：仅当前用户只读（尽力而为，失败只警告）。"""
    try:
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r",
             f"{os.environ.get('USERNAME', '')}:R"],
            capture_output=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        print(f"[dpapi-env] [警告] 无法自动收紧 {path} 的 ACL，请人工执行：", file=sys.stderr)
        print(f'  icacls "{path}" /inheritance:r /grant:r "%USERNAME%:R"', file=sys.stderr)


def cmd_import(args: argparse.Namespace) -> int:
    from envload import parse_env_file  # 同目录，脚本运行时 tools/ 在 sys.path

    src: Path = args.src
    if not src.is_file():
        print(f"[dpapi-env] 明文源文件不存在：{src}", file=sys.stderr)
        return 1
    try:
        env = parse_env_file(src)  # 复用严格解析器，导入前先过一遍语法
    except (ValueError, UnicodeDecodeError) as exc:
        print(f"[dpapi-env] 明文解析失败：{exc}", file=sys.stderr)
        return 1
    if not env:
        print(f"[dpapi-env] 明文文件为空：{src}", file=sys.stderr)
        return 1

    # 序列化为规范 KEY="VALUE" 文本（全量双引号 + 转义，保证含空格/#/= 的值往返无损）
    def _ser(v: str) -> str:
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    canonical = "".join(f"{k}={_ser(v)}\n" for k, v in env.items())

    out: Path = args.out or DEFAULT_STORE
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        # 上次导入已把 ACL 收紧为只读，先临时放开写权限再覆盖
        subprocess.run(["icacls", str(out), "/grant:r",
                        f"{os.environ.get('USERNAME', '')}:F"],
                       capture_output=True, timeout=10)
    out.write_bytes(dpapi_protect_text(canonical))
    _tighten_acl(out)

    print(f"[dpapi-env] 已加密 {len(env)} 个变量 -> {out}")
    print(f"[dpapi-env] 键名：{', '.join(sorted(env))}")
    print(f"[dpapi-env] 密文仅当前用户({os.environ.get('USERNAME')})在本机可解密")
    print(f"[dpapi-env] 下一步：请安全删除明文源文件 {src}")
    return 0


def cmd_print_keys(args: argparse.Namespace) -> int:
    from envload import load_env

    store: Path = args.store or DEFAULT_STORE
    if not store.is_file():
        print(f"[dpapi-env] 密文不存在：{store}（先跑 import）", file=sys.stderr)
        return 1
    try:
        env = load_env(store)
    except (ValueError, OSError) as exc:
        print(f"[dpapi-env] 解密失败：{exc}", file=sys.stderr)
        print("[dpapi-env] 常见原因：非本用户/非本机/文件被篡改/账户重置过密码", file=sys.stderr)
        return 1
    print(f"[dpapi-env] {store} 内含 {len(env)} 个变量：{', '.join(sorted(env))}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    """委托给 envload.main（其 load_env 已能识别 DPE1 密文并内存解密）。"""
    import envload

    store = str(args.store or DEFAULT_STORE)
    sys.argv = ["envload.py", "--env-file", store] + (args.cmd or [])
    return envload.main()


def main() -> int:
    ap = argparse.ArgumentParser(prog="dpapi_env",
                                 description="DPAPI 加密凭据存储与安全注入")
    sub = ap.add_subparsers(dest="cmd_name", required=True)

    p = sub.add_parser("import", help="从明文 .env 导入并加密")
    p.add_argument("--from", dest="src", type=Path, required=True, help="明文 .env 路径")
    p.add_argument("--out", type=Path, default=None,
                   help=f"密文输出路径（默认 {DEFAULT_STORE}）")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("print-keys", help="解密并列出键名（不打印值）")
    p.add_argument("--store", type=Path, default=None)
    p.set_defaults(func=cmd_print_keys)

    p = sub.add_parser("run", help="解密注入并启动子进程（缺省 DEFAULT_CMD）")
    p.add_argument("--store", type=Path, default=None)
    p.add_argument("cmd", nargs=argparse.REMAINDER, help="-- 之后为自定义子命令")
    p.set_defaults(func=cmd_run)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
