#!/usr/bin/env python3
"""把控制台打包成一个 Windows EXE（托盘启动器 + 内嵌运行时）。

用法：
    python pack/build.py                # 用默认 node 与 package.json 版本
    python pack/build.py --version 1.1  # 覆盖版本号
    python pack/build.py --node "C:\\path\\node.exe"

产物：dist/OpenCodeGoConsole.exe
      双击 → 首次解包到 %LOCALAPPDATA%\\OpenCodeGo → 后台起 node → 弹浏览器 → 托盘常驻

设计取舍：
  * 运行时用官方 node.exe（87 MB）而不是 SEA 重打包，换来零改造的现有代码；
    zlib 压完约 30 MB，单文件分发够用。
  * 归档格式故意做得极简（OCA1），C 侧解析只有几十行，出错概率低。
  * 版本号写进 exe 资源与 app/.version，版本变化才重新解包，用户数据原地保留。
  * 链接必须 `-static`：否则 MinGW 会挑 zlib1.dll 等动态库，换台机器就报
    「找不到 zlib1.dll」。改完用 `objdump -p dist/*.exe | grep "DLL Name"`
    确认只剩 KERNEL32/USER32/SHELL32/ADVAPI32/WS2_32/msvcrt。
"""

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

PACK = Path(__file__).resolve().parent
ROOT = PACK.parent
BUILD = PACK / 'build'
DIST = ROOT / 'dist'
MINGW = Path('C:/msys64/mingw64/bin')
DEFAULT_NODE = Path(os.environ.get('NODE_EXE', r'C:\Users\yzx\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'))

APP_FILES = [
    'ui.js',
    'accounts.js',
    'package.json',
    'README.md',
    'README.en.md',
    'LICENSE',
    'ui/index.html',
    'src/bridge.js',
    'src/protocol-converter.js',
    'src/responses-converter.js',
    'src/google-converter.js',
    'src/usage.js',
    'src/official-usage.js',
    'src/file-util.js',
]

RC_TEMPLATE = """\
#include "version.h"

1 ICON "app.ico"
1 24 "app.manifest"
PAYLOAD RCDATA "payload.bin"

VS_VERSION_INFO VERSIONINFO
 FILEVERSION {ver4}
 PRODUCTVERSION {ver4}
 FILEFLAGSMASK 0x3fL
 FILEFLAGS 0x0L
 FILEOS 0x40004L
 FILETYPE 0x1L
 FILESUBTYPE 0x0L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "080404b0"
        BEGIN
            VALUE "CompanyName", "yzx"
            VALUE "FileDescription", "opencode GO console (tray launcher)"
            VALUE "FileVersion", "{version}"
            VALUE "InternalName", "OpenCodeGoConsole"
            VALUE "OriginalFilename", "OpenCodeGoConsole.exe"
            VALUE "ProductName", "opencode GO console"
            VALUE "ProductVersion", "{version}"
            VALUE "Comments", "https://opencode.ai"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x804, 1200
    END
END
"""


def die(msg):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(1)


def archive(entries):
    """OCA1 归档：magic + count + (nameLen, name, size, bytes)*"""
    out = bytearray(b'OCA1')
    out += struct.pack('<I', len(entries))
    for name, data in entries:
        raw_name = name.encode('utf-8')
        if len(raw_name) >= 500:
            die('文件名过长: ' + name)
        out += struct.pack('<H', len(raw_name)) + raw_name
        out += struct.pack('<Q', len(data)) + data
    return bytes(out)


def collect(node_exe):
    entries = []
    total = 0
    for rel in APP_FILES:
        path = ROOT / rel
        if not path.is_file():
            die('缺少文件: ' + rel)
        data = path.read_bytes()
        entries.append(('app/' + rel, data))
        total += len(data)

    if not node_exe.is_file():
        die('找不到 node.exe: ' + str(node_exe))
    node_bytes = node_exe.read_bytes()
    entries.append(('runtime/node.exe', node_bytes))
    total += len(node_bytes)
    return entries, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', default=None)
    ap.add_argument('--node', default=str(DEFAULT_NODE))
    ap.add_argument('--out', default=str(DIST / 'OpenCodeGoConsole.exe'))
    args = ap.parse_args()

    version = args.version or json.loads((ROOT / 'package.json').read_text('utf-8')).get('version') or '1.0.0'
    parts = [int(x) for x in version.split('.')[:3]] + [0]
    while len(parts) < 4:
        parts.append(0)
    ver4 = ','.join(str(p) for p in parts[:4])

    BUILD.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(parents=True, exist_ok=True)

    entries, total = collect(Path(args.node))
    raw = archive(entries)
    packed = zlib.compress(raw, 9)
    payload = struct.pack('<Q', len(raw)) + packed
    (BUILD / 'payload.bin').write_bytes(payload)
    ratio = len(payload) / total * 100
    print(f'payload: {total/1048576:.1f} MB -> {len(payload)/1048576:.1f} MB ({ratio:.0f}%), '
          f'{len(entries)} 个文件')

    if not (PACK / 'app.ico').is_file():
        subprocess.run([sys.executable, str(PACK / 'make_icon.py')], check=True)

    (BUILD / 'version.h').write_text(
        f'#define APP_VERSION L"{version}"\n'
        f'#define APP_VERSION_A "{version}"\n',
        'utf-8')
    (BUILD / 'launcher.rc').write_text(RC_TEMPLATE.format(version=version, ver4=ver4), 'ascii')

    for name in ('app.ico', 'app.manifest'):
        shutil.copy2(PACK / name, BUILD / name)

    env = dict(os.environ)
    env['PATH'] = str(MINGW) + os.pathsep + env.get('PATH', '')
    windres = MINGW / 'windres.exe'
    gcc = MINGW / 'gcc.exe'
    if not windres.is_file() or not gcc.is_file():
        die(f'找不到 MinGW 工具链：{MINGW}')

    subprocess.run([str(windres), '--codepage=65001', '-I', str(BUILD),
                    '-i', 'launcher.rc', '-o', 'launcher_res.o'],
                   cwd=BUILD, check=True, env=env)
    out = Path(args.out).resolve()
    # -static matters: without it the linker picks zlib1.dll (and possibly
    # libgcc/libwinpthread DLLs) from the MinGW tree, and the exe only starts on
    # machines that happen to have them on PATH. Everything but the Windows
    # system DLLs must be baked in.
    subprocess.run([str(gcc), '-O2', '-s', '-municode', '-mwindows',
                    '-static', '-static-libgcc',
                    '-DUNICODE', '-D_UNICODE',
                    '-I', str(BUILD),
                    str(PACK / 'launcher.c'), 'launcher_res.o',
                    '-lz', '-lws2_32', '-lshell32', '-ladvapi32', '-luser32', '-lgdi32',
                    '-o', str(out)],
                   cwd=BUILD, check=True, env=env)

    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    size = out.stat().st_size
    print(f'exe: {out}  {size/1048576:.1f} MB')
    print(f'sha256: {digest}')
    print(f'version: {version}')


if __name__ == '__main__':
    main()
