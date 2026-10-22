#!/usr/bin/env python3
"""
OpenCode Go subscription usage — the "check quota" piece.

Endpoint (verified 2026-10-21):
  GET https://opencode.ai/inference/go/v1/usage
  Authorization: Bearer <GO key>
  -> { "usage": { "rolling": {...}, "weekly": {...}, "monthly": {...} } }
     each window: { "status": "ok" | "rate-limited", "percent": 0..100, "resetsAt": ISO }

Key lookup order: --key, GO_KEY env, go_key.txt next to this file.

Usage:
  python usage.py
  python usage.py --json
  python usage.py --watch 60
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(HERE, "go_key.txt")
ACCOUNTS_FILE = os.path.join(HERE, "accounts.json")
GATEWAY = os.environ.get("OPENCODE_GO_GATEWAY", "https://opencode.ai/inference/go").rstrip("/")
USAGE_URL = GATEWAY + "/v1/usage"

LABELS = (("rolling", "5h", "5 hour"), ("weekly", "week", "weekly"), ("monthly", "month", "monthly"))


def active_account_key():
    """Key of the account the bridge currently uses (accounts.json)."""
    try:
        with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
            store = json.load(f)
        accounts = store.get("accounts") or []
        active = next((a for a in accounts if a.get("ref") == store.get("activeRef")), None)
        if active is None and accounts:
            active = accounts[0]
        key = (active or {}).get("key") or ""
        return key.strip()
    except Exception:
        return ""


def resolve_key(cli_key=None):
    if cli_key:
        return cli_key.strip()
    env = os.environ.get("GO_KEY", "").strip()
    if env:
        return env
    from_accounts = active_account_key()
    if from_accounts:
        return from_accounts
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "r", encoding="utf-8-sig") as f:
            return f.read().strip()
    return ""


def read_usage(key, timeout=15):
    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": "Bearer " + key,
        "Accept": "application/json",
        "User-Agent": "workbuddy-opencode-go-usage/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        if e.code == 401:
            raise SystemExit("401 Unauthorized — key rejected. Check that it is an OpenCode Go subscription key.\n%s" % body)
        if e.code == 403:
            raise SystemExit("403 Forbidden — key is valid but lacks Go subscription permission.\n%s" % body)
        raise SystemExit("HTTP %d from %s\n%s" % (e.code, USAGE_URL, body))
    except urllib.error.URLError as e:
        raise SystemExit("cannot reach %s: %s" % (USAGE_URL, e.reason))


def reset_text(iso, now=None):
    try:
        ts = iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        local = dt.astimezone()
        now = now or datetime.now(timezone.utc)
        delta = (dt.astimezone(timezone.utc) - now).total_seconds()
        if delta <= 0:
            return "reset pending"
        h, rem = divmod(int(delta), 3600)
        m = rem // 60
        eta = ("%dh%02dm" % (h, m)) if h else ("%dm" % m)
        return "%s  (in %s)" % (local.strftime("%m-%d %H:%M"), eta)
    except Exception:
        return iso


def bar(percent, width=20):
    filled = int(round(width * max(0.0, min(100.0, percent)) / 100.0))
    return "[" + "#" * filled + "-" * (width - filled) + "]"


def render(payload):
    usage = (payload or {}).get("usage") or {}
    now = datetime.now(timezone.utc)
    lines = ["OpenCode Go usage   %s" % datetime.now().strftime("%Y-%m-%d %H:%M:%S")]
    for key, short, long_name in LABELS:
        row = usage.get(key) or {}
        if not row:
            lines.append("  %-5s %s  n/a" % (short, bar(0)))
            continue
        pct = row.get("percent")
        pct = float(pct) if isinstance(pct, (int, float)) else 0.0
        flag = "" if row.get("status") == "ok" else "  [rate-limited]"
        lines.append("  %-5s %s %5.1f%%  resets %s%s" % (
            short, bar(pct), pct, reset_text(row.get("resetsAt", ""), now), flag))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--watch", type=int, metavar="SECONDS")
    a = ap.parse_args()

    key = resolve_key(a.key)
    if not key:
        print("[fail] no key: add an account in the panel, set GO_KEY, create go_key.txt, or pass --key", file=sys.stderr)
        return 2

    while True:
        payload = read_usage(key)
        if a.json:
            print(json.dumps(payload, indent=2, ensure_ascii=False))
        else:
            if a.watch:
                print("\033[2J\033[H", end="")
            print(render(payload))
        if not a.watch:
            return 0
        time.sleep(max(5, a.watch))


if __name__ == "__main__":
    sys.exit(main())
