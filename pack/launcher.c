/*
 * opencode GO 控制台 —— Windows 托盘启动器
 *
 * 双击这个 exe：解包（首次）→ 后台拉起 node 控制台 → 弹出浏览器页面 → 常驻通知栏。
 *
 * 设计要点：
 *   - 单文件分发：payload（node.exe + 应用代码）作为 RCDATA 资源贴在 exe 里，
 *     首次运行时解到 %LOCALAPPDATA%\OpenCodeGo，之后只校验版本号。
 *   - 子进程用 Job 对象托管（KILL_ON_JOB_CLOSE），启动器一退出，node 和桥接
 *     一定跟着走，不会留下孤儿进程。
 *   - 托盘菜单里的「退出」先调用面板的 /api/shutdown（桥接用 token 优雅停止），
 *     超时才 TerminateProcess。
 *   - 数据目录：exe 同目录放 portable.txt 就变成绿色版（数据写在 exe 旁边）。
 */

#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <strsafe.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <zlib.h>

#include "version.h"

#define UI_PORT 8790
#define APP_CLASS L"OpenCodeGoTrayWnd"
#define APP_TITLE L"opencode GO 控制台"
#define WM_TRAY (WM_APP + 1)
#define WM_OPEN_NOW (WM_APP + 2)

#define ID_OPEN 1001
#define ID_COPY 1002
#define ID_RESTART 1003
#define ID_DATADIR 1004
#define ID_AUTOSTART 1005
#define ID_QUIT 1006

#define TIMER_POLL 1
#define POLL_MS 800
#define START_GRACE_TICKS 40 /* ~32s before we admit the start failed */

static HINSTANCE g_inst;
static HWND g_hwnd;
static HICON g_icon;
static HANDLE g_job;
static HANDLE g_child;
static BOOL g_running;
static BOOL g_external;
static BOOL g_pending_open;
static BOOL g_starting;
static BOOL g_warned;
static int g_ticks;
static BOOL g_silent;
static UINT g_msg_taskbar_created;
static wchar_t g_root[MAX_PATH];
static wchar_t g_app_dir[MAX_PATH];
static wchar_t g_node[MAX_PATH];
static wchar_t g_script[MAX_PATH];
static NOTIFYICONDATAW g_nid;

static void open_panel(void);
static void stop_service(void);

/* ------------------------------------------------------------------ 基础工具 */

static BOOL file_exists(const wchar_t *path) {
  DWORD attr = GetFileAttributesW(path);
  return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

static BOOL read_small_text(const wchar_t *path, char *out, size_t cap) {
  HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (h == INVALID_HANDLE_VALUE) return FALSE;
  DWORD got = 0;
  BOOL ok = ReadFile(h, out, (DWORD)cap - 1, &got, NULL);
  CloseHandle(h);
  if (!ok) return FALSE;
  out[got] = 0;
  while (got > 0 && (out[got - 1] == '\r' || out[got - 1] == '\n' || out[got - 1] == ' ')) {
    out[--got] = 0;
  }
  return got > 0;
}

static void trim_file_name(wchar_t *path) {
  for (int i = (int)wcslen(path) - 1; i > 0; i--) {
    if (path[i] == L'\\' || path[i] == L'/') { path[i] = 0; return; }
  }
}

static BOOL make_dirs_for(const wchar_t *file_path) {
  wchar_t buf[MAX_PATH * 2];
  StringCchCopyW(buf, ARRAYSIZE(buf), file_path);
  for (wchar_t *p = buf + 3; *p; p++) {
    if (*p == L'\\') {
      *p = 0;
      if (!CreateDirectoryW(buf, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return FALSE;
      *p = L'\\';
    }
  }
  return TRUE;
}

static BOOL write_file(const wchar_t *path, const void *data, DWORD size) {
  if (!make_dirs_for(path)) return FALSE;
  HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL, NULL);
  if (h == INVALID_HANDLE_VALUE) return FALSE;
  DWORD written = 0;
  BOOL ok = size == 0 ? TRUE : WriteFile(h, data, size, &written, NULL);
  CloseHandle(h);
  return ok && written == size;
}

/* --------------------------------------------------------------- 单实例/端口 */

static SOCKET connect_local(unsigned short port, int timeout_ms) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return INVALID_SOCKET;

  struct sockaddr_in addr;
  ZeroMemory(&addr, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  addr.sin_addr.s_addr = inet_addr("127.0.0.1");

  unsigned long nonblocking = 1;
  ioctlsocket(s, FIONBIO, &nonblocking);
  int rc = connect(s, (struct sockaddr *)&addr, sizeof(addr));
  if (rc == SOCKET_ERROR && WSAGetLastError() != WSAEWOULDBLOCK) {
    closesocket(s);
    return INVALID_SOCKET;
  }
  if (rc == SOCKET_ERROR) {
    fd_set wf, ef;
    FD_ZERO(&wf); FD_SET(s, &wf);
    FD_ZERO(&ef); FD_SET(s, &ef);
    struct timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    int sel = select(0, NULL, &wf, &ef, &tv);
    if (sel <= 0 || FD_ISSET(s, &ef)) { closesocket(s); return INVALID_SOCKET; }
    int err = 0, len = sizeof(err);
    getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&err, &len);
    if (err != 0) { closesocket(s); return INVALID_SOCKET; }
  }
  unsigned long blocking = 0;
  ioctlsocket(s, FIONBIO, &blocking);
  return s;
}

static BOOL port_open(unsigned short port) {
  SOCKET s = connect_local(port, 250);
  if (s == INVALID_SOCKET) return FALSE;
  closesocket(s);
  return TRUE;
}

/* 让面板先停桥接再退出；返回 TRUE 表示请求已送达。 */
static BOOL request_shutdown(void) {
  SOCKET s = connect_local(UI_PORT, 700);
  if (s == INVALID_SOCKET) return FALSE;
  const char *req =
      "POST /api/shutdown HTTP/1.1\r\n"
      "Host: 127.0.0.1:8790\r\n"
      "Content-Type: application/json\r\n"
      "Content-Length: 0\r\n"
      "Connection: close\r\n\r\n";
  send(s, req, (int)strlen(req), 0);
  char buf[512];
  recv(s, buf, sizeof(buf), 0);
  closesocket(s);
  return TRUE;
}

/* ------------------------------------------------------------------ 解包 */

static BOOL needs_extract(void) {
  if (!file_exists(g_node) || !file_exists(g_script)) return TRUE;
  wchar_t marker[MAX_PATH];
  StringCchPrintfW(marker, ARRAYSIZE(marker), L"%ls\\.version", g_app_dir);
  char current[64];
  if (!read_small_text(marker, current, sizeof(current))) return TRUE;
  return strcmp(current, APP_VERSION_A) != 0;
}

/* payload = [u64 原始长度][zlib 流]，解出来是 OCA1 归档：
 * 'OCA1' + u32 条目数 + N*(u16 名字长度 + UTF-8 名字 + u64 大小 + 内容) */
static BOOL extract_payload(void) {
  HRSRC res = FindResourceW(NULL, L"PAYLOAD", RT_RCDATA);
  if (!res) return TRUE; /* 开发布局：没有 payload 就直接用目录里的文件 */
  DWORD res_size = SizeofResource(NULL, res);
  HGLOBAL glob = LoadResource(NULL, res);
  const unsigned char *data = (const unsigned char *)LockResource(glob);
  if (!data || res_size < 8) return FALSE;

  uint64_t raw_size = 0;
  memcpy(&raw_size, data, 8);
  if (raw_size < 8 || raw_size > (uint64_t)2 * 1024 * 1024 * 1024) return FALSE;

  unsigned char *raw = (unsigned char *)malloc((size_t)raw_size);
  if (!raw) return FALSE;
  uLongf dest_len = (uLongf)raw_size;
  int zr = uncompress(raw, &dest_len, data + 8, (uLong)(res_size - 8));
  if (zr != Z_OK || dest_len != (uLongf)raw_size) { free(raw); return FALSE; }

  BOOL ok = FALSE;
  size_t pos = 4;
  uint32_t count = 0;
  if (memcmp(raw, "OCA1", 4) == 0 && raw_size >= 8) {
    memcpy(&count, raw + pos, 4);
    pos += 4;
    ok = TRUE;
  }

  for (uint32_t i = 0; ok && i < count; i++) {
    if (pos + 2 > raw_size) { ok = FALSE; break; }
    uint16_t name_len = 0;
    memcpy(&name_len, raw + pos, 2);
    pos += 2;
    if (name_len == 0 || name_len >= 500 || pos + name_len + 8 > raw_size) { ok = FALSE; break; }

    char name[500];
    memcpy(name, raw + pos, name_len);
    name[name_len] = 0;
    pos += name_len;

    uint64_t size = 0;
    memcpy(&size, raw + pos, 8);
    pos += 8;
    if (pos + size > raw_size) { ok = FALSE; break; }

    wchar_t wide[600];
    if (!MultiByteToWideChar(CP_UTF8, 0, name, -1, wide, 600)) { ok = FALSE; break; }
    for (wchar_t *p = wide; *p; p++) if (*p == L'/') *p = L'\\';

    wchar_t full[MAX_PATH * 2];
    if (FAILED(StringCchPrintfW(full, ARRAYSIZE(full), L"%ls\\%ls", g_root, wide))) { ok = FALSE; break; }
    if (!write_file(full, raw + pos, (DWORD)size)) { ok = FALSE; break; }
    pos += (size_t)size;
  }

  free(raw);
  if (!ok) return FALSE;

  /* 只有全部写成功才落版本号，半途失败下次还会重解。 */
  wchar_t marker[MAX_PATH];
  StringCchPrintfW(marker, ARRAYSIZE(marker), L"%ls\\.version", g_app_dir);
  return write_file(marker, APP_VERSION_A, (DWORD)strlen(APP_VERSION_A));
}

/* ------------------------------------------------------------------ 托盘 */

static void set_tip(const wchar_t *text) {
  StringCchCopyW(g_nid.szTip, ARRAYSIZE(g_nid.szTip), text);
  g_nid.uFlags = NIF_TIP | NIF_ICON | NIF_MESSAGE;
  Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

static void balloon(const wchar_t *title, const wchar_t *text) {
  NOTIFYICONDATAW nid = g_nid;
  nid.uFlags = NIF_INFO;
  nid.dwInfoFlags = NIIF_INFO;
  StringCchCopyW(nid.szInfoTitle, ARRAYSIZE(nid.szInfoTitle), title);
  StringCchCopyW(nid.szInfo, ARRAYSIZE(nid.szInfo), text);
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

static void tray_add(void) {
  ZeroMemory(&g_nid, sizeof(g_nid));
  g_nid.cbSize = sizeof(g_nid);
  g_nid.hWnd = g_hwnd;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  g_nid.uCallbackMessage = WM_TRAY;
  g_nid.hIcon = g_icon;
  StringCchCopyW(g_nid.szTip, ARRAYSIZE(g_nid.szTip), L"opencode GO 控制台 · 正在启动…");
  Shell_NotifyIconW(NIM_ADD, &g_nid);
}

static void tray_remove(void) {
  Shell_NotifyIconW(NIM_DELETE, &g_nid);
}

/* ------------------------------------------------------------------ 服务 */

static BOOL start_service(void) {
  wchar_t cmd[MAX_PATH * 2 + 64];
  if (FAILED(StringCchPrintfW(cmd, ARRAYSIZE(cmd), L"\"%ls\" \"%ls\" --no-open",
                              g_node, g_script))) {
    return FALSE;
  }

  STARTUPINFOW si;
  ZeroMemory(&si, sizeof(si));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;

  PROCESS_INFORMATION pi;
  ZeroMemory(&pi, sizeof(pi));
  if (!CreateProcessW(g_node, cmd, NULL, NULL, FALSE,
                      CREATE_NO_WINDOW | CREATE_SUSPENDED, NULL, g_app_dir, &si, &pi)) {
    return FALSE;
  }
  /* 先入 Job 再放行：这样它之后拉起的桥接也逃不掉。 */
  if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);

  g_child = pi.hProcess;
  g_running = TRUE;
  g_starting = TRUE;
  g_ticks = 0;
  return TRUE;
}

static void stop_service(void) {
  BOOL alive = FALSE;
  if (g_running && g_child) {
    alive = WaitForSingleObject(g_child, 0) == WAIT_TIMEOUT;
    if (!alive) {
      CloseHandle(g_child);
      g_child = NULL;
      g_running = FALSE;
    }
  }
  if (alive) {
    request_shutdown();
    if (WaitForSingleObject(g_child, 6000) != WAIT_OBJECT_0) {
      TerminateProcess(g_child, 0);
      WaitForSingleObject(g_child, 2000);
    }
    CloseHandle(g_child);
    g_child = NULL;
    g_running = FALSE;
  } else if (g_external) {
    request_shutdown();
    for (int i = 0; i < 30 && port_open(UI_PORT); i++) Sleep(100);
    g_external = FALSE;
  }
  g_pending_open = FALSE;
}

static void open_panel(void) {
  ShellExecuteW(NULL, L"open", L"http://127.0.0.1:8790/", NULL, NULL, SW_SHOWNORMAL);
}

static void copy_url(void) {
  const wchar_t *url = L"http://127.0.0.1:8790/";
  if (!OpenClipboard(g_hwnd)) return;
  EmptyClipboard();
  size_t bytes = (wcslen(url) + 1) * sizeof(wchar_t);
  HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (mem) {
    void *dst = GlobalLock(mem);
    if (dst) {
      memcpy(dst, url, bytes);
      GlobalUnlock(mem);
      SetClipboardData(CF_UNICODETEXT, mem);
    } else {
      GlobalFree(mem);
    }
  }
  CloseClipboard();
}

static void open_data_dir(void) {
  ShellExecuteW(NULL, L"open", g_app_dir, NULL, NULL, SW_SHOWNORMAL);
}

/* ------------------------------------------------------------------ 自启 */

static void autostart_command(wchar_t *out, size_t cap) {
  wchar_t exe[MAX_PATH];
  GetModuleFileNameW(NULL, exe, MAX_PATH);
  StringCchPrintfW(out, cap, L"\"%ls\" -silent", exe);
}

static BOOL autostart_enabled(void) {
  HKEY key;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                    0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) {
    return FALSE;
  }
  wchar_t value[MAX_PATH * 2];
  DWORD size = sizeof(value), type = 0;
  LONG rc = RegQueryValueExW(key, L"OpenCodeGoConsole", NULL, &type, (LPBYTE)value, &size);
  RegCloseKey(key);
  return rc == ERROR_SUCCESS && type == REG_SZ;
}

static void set_autostart(BOOL on) {
  HKEY key;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                      0, NULL, 0, KEY_SET_VALUE, NULL, &key, NULL) != ERROR_SUCCESS) {
    return;
  }
  if (on) {
    wchar_t cmd[MAX_PATH * 2];
    autostart_command(cmd, ARRAYSIZE(cmd));
    RegSetValueExW(key, L"OpenCodeGoConsole", 0, REG_SZ, (const BYTE *)cmd,
                   (DWORD)((wcslen(cmd) + 1) * sizeof(wchar_t)));
  } else {
    RegDeleteValueW(key, L"OpenCodeGoConsole");
  }
  RegCloseKey(key);
}

/* ------------------------------------------------------------------ 轮询 */

static void tick(void) {
  if (g_running && g_child && WaitForSingleObject(g_child, 0) == WAIT_OBJECT_0) {
    DWORD code = 0;
    GetExitCodeProcess(g_child, &code);
    CloseHandle(g_child);
    g_child = NULL;
    g_running = FALSE;
    g_starting = FALSE;
    if (!port_open(UI_PORT)) {
      set_tip(L"服务已停止 · 右键菜单可重启");
      balloon(L"控制台没能留住",
              code == 0 ? L"进程已退出（端口被占用或代码报错，看 app\\.state 下的日志）。"
                        : L"进程异常退出，右键可以重启，或查看 app\\.state 下的日志。");
    }
  }

  if (g_pending_open && port_open(UI_PORT)) {
    g_pending_open = FALSE;
    g_starting = FALSE;
    set_tip(g_external ? L"已连接 127.0.0.1:8790" : L"运行中 · 127.0.0.1:8790");
    open_panel();
  }

  if (g_starting && ++g_ticks == START_GRACE_TICKS && !g_warned) {
    g_warned = TRUE;
    if (!port_open(UI_PORT)) {
      set_tip(L"启动超时 · 右键重启");
      balloon(L"启动有点慢", L"端口 8790 还没响应，右键可以重启，或打开数据目录看日志。");
    }
  }
}

/* ------------------------------------------------------------------ 窗口 */

static void show_menu(void) {
  HMENU menu = CreatePopupMenu();
  if (!menu) return;

  AppendMenuW(menu, MF_STRING, ID_OPEN, L"打开控制台\t双击图标");
  AppendMenuW(menu, MF_STRING, ID_COPY, L"复制地址");
  AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
  AppendMenuW(menu, MF_STRING, ID_RESTART, g_running || g_external ? L"重启服务" : L"启动服务");
  AppendMenuW(menu, MF_STRING, ID_DATADIR, L"打开数据目录");
  AppendMenuW(menu, MF_STRING | (autostart_enabled() ? MF_CHECKED : MF_UNCHECKED),
              ID_AUTOSTART, L"开机自启");
  AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
  AppendMenuW(menu, MF_STRING, ID_QUIT, L"退出");
  SetMenuDefaultItem(menu, ID_OPEN, FALSE);

  POINT pt;
  GetCursorPos(&pt);
  SetForegroundWindow(g_hwnd);
  TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, 0, g_hwnd, NULL);
  PostMessageW(g_hwnd, WM_NULL, 0, 0);
  DestroyMenu(menu);
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  if (msg == g_msg_taskbar_created && g_msg_taskbar_created != 0) {
    tray_add(); /* explorer.exe 重启后图标要重新挂 */
    return 0;
  }

  switch (msg) {
    case WM_TRAY:
      if (LOWORD(lParam) == WM_RBUTTONUP || LOWORD(lParam) == WM_CONTEXTMENU) {
        show_menu();
      } else if (LOWORD(lParam) == WM_LBUTTONDBLCLK) {
        open_panel();
      }
      return 0;

    case WM_OPEN_NOW:
      open_panel();
      return 0;

    case WM_TIMER:
      if (wParam == TIMER_POLL) tick();
      return 0;

    case WM_COMMAND:
      switch (LOWORD(wParam)) {
        case ID_OPEN:
          open_panel();
          return 0;
        case ID_COPY:
          copy_url();
          return 0;
        case ID_RESTART:
          set_tip(L"正在重启…");
          stop_service();
          g_warned = FALSE;
          if (port_open(UI_PORT)) {
            g_external = TRUE;
            g_pending_open = TRUE;
          } else if (start_service()) {
            g_pending_open = TRUE;
          } else {
            set_tip(L"启动失败");
            MessageBoxW(hwnd, L"启动 node 失败。请确认杀毒软件没有拦截 runtime\\node.exe。",
                        APP_TITLE, MB_ICONERROR | MB_OK);
          }
          return 0;
        case ID_DATADIR:
          open_data_dir();
          return 0;
        case ID_AUTOSTART:
          set_autostart(!autostart_enabled());
          return 0;
        case ID_QUIT:
          KillTimer(hwnd, TIMER_POLL);
          stop_service();
          tray_remove();
          DestroyWindow(hwnd);
          return 0;
      }
      return 0;

    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

/* ------------------------------------------------------------------ main */

static BOOL resolve_paths(void) {
  wchar_t exe[MAX_PATH];
  if (!GetModuleFileNameW(NULL, exe, MAX_PATH)) return FALSE;
  trim_file_name(exe);

  wchar_t portable[MAX_PATH];
  StringCchPrintfW(portable, ARRAYSIZE(portable), L"%ls\\portable.txt", exe);

  if (file_exists(portable)) {
    StringCchCopyW(g_root, ARRAYSIZE(g_root), exe);
  } else {
    wchar_t appdata[MAX_PATH];
    if (FAILED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, appdata))) return FALSE;
    StringCchPrintfW(g_root, ARRAYSIZE(g_root), L"%ls\\OpenCodeGo", appdata);
  }

  StringCchPrintfW(g_app_dir, ARRAYSIZE(g_app_dir), L"%ls\\app", g_root);
  StringCchPrintfW(g_node, ARRAYSIZE(g_node), L"%ls\\runtime\\node.exe", g_root);
  StringCchPrintfW(g_script, ARRAYSIZE(g_script), L"%ls\\ui.js", g_app_dir);
  return TRUE;
}

static void create_kill_job(void) {
  g_job = CreateJobObjectW(NULL, NULL);
  if (!g_job) return;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  ZeroMemory(&info, sizeof(info));
  info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &info, sizeof(info));
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmdline, int show) {
  (void)prev; (void)cmdline; (void)show;

  g_inst = inst;
  g_silent = wcsstr(GetCommandLineW(), L"-silent") != NULL;

  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);

  if (!resolve_paths()) {
    MessageBoxW(NULL, L"无法定位数据目录（%LOCALAPPDATA% 不可用）。", APP_TITLE, MB_ICONERROR | MB_OK);
    return 1;
  }

  /* 已经在跑：把现有窗口叫出来，不再开第二个托盘。 */
  HWND existing = FindWindowW(APP_CLASS, NULL);
  if (existing) {
    PostMessageW(existing, WM_OPEN_NOW, 0, 0);
    return 0;
  }

  g_icon = (HICON)LoadImageW(g_inst, MAKEINTRESOURCEW(1), IMAGE_ICON, 0, 0,
                             LR_DEFAULTSIZE | LR_SHARED);

  g_msg_taskbar_created = RegisterWindowMessageW(L"TaskbarCreated");

  WNDCLASSEXW wc;
  ZeroMemory(&wc, sizeof(wc));
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = g_inst;
  wc.lpszClassName = APP_CLASS;
  wc.hIcon = g_icon;
  if (!RegisterClassExW(&wc)) return 1;

  g_hwnd = CreateWindowExW(0, APP_CLASS, APP_TITLE, WS_OVERLAPPED,
                           0, 0, 0, 0, NULL, NULL, g_inst, NULL);
  if (!g_hwnd) return 1;

  tray_add();
  create_kill_job();

  if (needs_extract()) {
    set_tip(L"首次初始化，正在解包…");
    if (!extract_payload()) {
      tray_remove();
      MessageBoxW(NULL,
                  L"解包失败。请把 exe 放到有写权限的目录（不要放 Program Files），\n"
                  L"或者删掉 %LOCALAPPDATA%\\OpenCodeGo 后重试。",
                  APP_TITLE, MB_ICONERROR | MB_OK);
      return 1;
    }
  }

  if (port_open(UI_PORT)) {
    /* 开发面板或上一次没退干净的实例已经占着端口，直接接管显示。 */
    g_external = TRUE;
    set_tip(L"已连接 127.0.0.1:8790");
    if (!g_silent) open_panel();
  } else if (start_service()) {
    g_pending_open = !g_silent;
    set_tip(L"正在启动…");
  } else {
    set_tip(L"启动失败");
    MessageBoxW(NULL,
                L"无法启动 runtime\\node.exe。\n请确认杀毒软件没有拦截，或重新下载完整包。",
                APP_TITLE, MB_ICONERROR | MB_OK);
    tray_remove();
    return 1;
  }

  SetTimer(g_hwnd, TIMER_POLL, POLL_MS, NULL);

  if (!g_silent) {
    balloon(L"opencode GO 控制台", L"已挂到通知栏，双击图标随时打开页面。");
  }

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  if (g_job) CloseHandle(g_job); /* KILL_ON_JOB_CLOSE：兜底清掉 node 与桥接 */
  WSACleanup();
  return 0;
}
