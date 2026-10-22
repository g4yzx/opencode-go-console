#!/usr/bin/env python3
"""
Generate WorkBuddy custom-model entries from the live opencode Go catalog.

Model membership comes from the gateway listing, configuration (protocol, context
window, output limit, image input, reasoning) from models.dev. See catalog.py.

Safety: dry-run by default, timestamped backup on --apply, id-based upsert,
never touches models you added yourself.

  python catalog.py                             # see what is available first
  python install-models.py                      # dry-run, every usable model
  python install-models.py --apply              # write ~/.workbuddy/models.json
  python install-models.py --select --apply     # 8 curated picks instead of all
  python install-models.py --prune --apply      # also drop stale (opencode Go) rows
"""

import argparse
import importlib.util
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_JSON = os.path.join(os.path.expanduser("~"), ".workbuddy", "models.json")
KEY_FILE = os.path.join(HERE, "go_key.txt")
BRIDGE_URL = "http://127.0.0.1:%s/v1" % os.environ.get("OPENCODE_GO_BRIDGE_PORT", "8788")
PLACEHOLDER_KEY = "opencode-go"
NAME_SUFFIX = " (opencode Go)"
MAX_OUTPUT_CAP = 65536

SELECTED = [
    "glm-5.3",
    "glm-5.3-flash",
    "kimi-k2.7-code",
    "kimi-k3",
    "deepseek-v4.1-flash",
    "mimo-v2.6-flash",
    "qwen3.8-max",
    "minimax-m3",
]


CUSTOM_FILE = os.path.join(HERE, "custom-models.json")


def apply_custom(models):
    """Apply panel edits (custom-models.json) on top of the catalog rows."""
    try:
        with open(CUSTOM_FILE, "r", encoding="utf-8") as f:
            state = json.load(f)
    except Exception:
        return models
    if not isinstance(state, dict):
        return models

    overrides = state.get("overrides") or {}
    merged = []
    for m in models:
        patch = overrides.get(m.get("id")) if isinstance(m.get("id"), str) else None
        if isinstance(patch, dict):
            item = dict(m)
            item.update({k: v for k, v in patch.items() if v is not None})
            item["overridden"] = True
            merged.append(item)
        else:
            merged.append(m)

    known = {m.get("id") for m in merged}
    for entry in state.get("custom") or []:
        if not isinstance(entry, dict) or not entry.get("id") or entry["id"] in known:
            continue
        merged.append({
            "id": entry["id"],
            "name": entry.get("name") or entry["id"],
            "protocol": entry.get("protocol") or "chat",
            "context": entry.get("context"),
            "output": entry.get("output"),
            "reasoning": bool(entry.get("reasoning")),
            "reasoningEfforts": entry.get("reasoningEfforts") or [],
            "defaultEffort": entry.get("defaultEffort"),
            "canDisableThinking": bool(entry.get("canDisableThinking")),
            "images": bool(entry.get("images")),
            "costIn": None,
            "costOut": None,
            "status": "custom",
        })
        known.add(entry["id"])
    return merged


def load_catalog(force=False):
    spec = importlib.util.spec_from_file_location("og_catalog", os.path.join(HERE, "catalog.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    catalog, _fresh = module.load(force=force)
    return catalog


def read_key():
    if not os.path.exists(KEY_FILE):
        return ""
    with open(KEY_FILE, "r", encoding="utf-8-sig") as f:
        return f.read().strip()


def build_entry(m, key, force_reasoning):
    out = m.get("output")
    cap = 1000000 if (m.get("overridden") or m.get("custom")) else MAX_OUTPUT_CAP
    max_out = min(int(out), cap) if isinstance(out, int) and out > 0 else 32768
    ctx = m.get("context")
    efforts = [e for e in (m.get("reasoningEfforts") or []) if isinstance(e, str)]
    supports_reasoning = bool(m.get("reasoning") or efforts)
    entry = {
        "id": m["id"],
        "name": "%s%s" % (m.get("name") or m["id"], NAME_SUFFIX),
        "vendor": "Custom",
        "url": BRIDGE_URL,
        "apiKey": key or PLACEHOLDER_KEY,
        "supportsToolCall": True,
        "supportsImages": bool(m.get("images")),
        "supportsReasoning": supports_reasoning,
        "maxInputTokens": int(ctx) if isinstance(ctx, int) and ctx > 0 else 200000,
        "maxOutputTokens": max_out,
    }
    if supports_reasoning and (efforts or force_reasoning):
        supported = efforts or ["low", "medium", "high"]
        default = m.get("defaultEffort")
        if default not in supported:
            default = "medium" if "medium" in supported else ("high" if "high" in supported else supported[0])
        entry["reasoning"] = {
            "defaultEffort": default,
            "supportedEfforts": supported,
            "canDisableThinking": bool(m.get("canDisableThinking")),
        }
    return entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--select", action="store_true", help="only the curated shortlist")
    ap.add_argument("--only", help="comma separated model ids")
    ap.add_argument("--reasoning", action="store_true", help="force a reasoning block when metadata has no levels")
    ap.add_argument("--prune", action="store_true", help="remove stale %s rows" % NAME_SUFFIX.strip())
    ap.add_argument("--existing", action="store_true", help="only refresh rows already in models.json")
    ap.add_argument("--refresh", action="store_true", help="refetch catalog first")
    ap.add_argument("--file", default=MODELS_JSON)
    a = ap.parse_args()

    catalog = load_catalog(force=a.refresh)
    usable = apply_custom([
        m for m in catalog["models"]
        if m["protocol"] in ("chat", "anthropic", "responses", "google")
    ])

    if a.only:
        want = {x.strip() for x in a.only.split(",") if x.strip()}
        usable = [m for m in usable if m["id"] in want]
        missing = want - {m["id"] for m in usable}
        if missing:
            print("[warn] not usable / not found: %s" % ", ".join(sorted(missing)))
    elif a.select:
        order = {mid: i for i, mid in enumerate(SELECTED)}
        usable = [m for m in usable if m["id"] in order]
        usable.sort(key=lambda m: order[m["id"]])

    if not usable:
        print("[fail] no models selected")
        return 1

    path = a.file
    if not os.path.exists(path):
        print("[fail] not found: %s" % path)
        return 1
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.loads(f.read())
    if not isinstance(data, list):
        print("[fail] models.json root is not a list")
        return 1

    if a.existing:
        installed = {m.get("id") for m in data if isinstance(m, dict)}
        usable = [m for m in usable if m["id"] in installed]

    key = read_key()
    entries = [build_entry(m, key, a.reasoning) for m in usable]

    added, updated = [], []
    for e in entries:
        idx = next((i for i, m in enumerate(data)
                    if isinstance(m, dict) and m.get("id") == e["id"]), None)
        if idx is None:
            data.append(e)
            added.append(e["id"])
        else:
            merged = dict(data[idx])
            merged.update(e)
            if "reasoning" not in e:
                merged.pop("reasoning", None)
            data[idx] = merged
            updated.append(e["id"])

    pruned_count = 0
    if a.prune:
        keep = {e["id"] for e in entries}
        before = len(data)
        data = [m for m in data if not (
            isinstance(m, dict)
            and str(m.get("name", "")).endswith(NAME_SUFFIX)
            and m.get("id") not in keep
        )]
        pruned_count = before - len(data)

    print("catalog   : %s  (gateway %d / usable %d)" % (
        catalog["generatedAt"], catalog["counts"]["gateway"], catalog["counts"]["usable"]))
    print("file      : %s" % path)
    print("bridge    : %s" % BRIDGE_URL)
    print("key       : %s" % (("go_key.txt (%d chars)" % len(key)) if key
                              else "placeholder + bridge GO_KEY fallback"))
    print("rows      : %d -> %d" % ((len(data) - len(added)), len(data)))
    print("added     : %s" % (", ".join(added) or "-"))
    print("updated   : %s" % (", ".join(updated) or "-"))
    if a.prune:
        print("pruned    : %d stale row(s)" % pruned_count)
    print()
    print("%-10s %-28s %8s %8s %4s %4s" % ("protocol", "id", "ctx", "maxOut", "img", "rsn"))
    for m, e in zip(usable, entries):
        print("%-10s %-28s %8d %8d %4s %4s" % (
            m["protocol"], e["id"], e["maxInputTokens"], e["maxOutputTokens"],
            "y" if e["supportsImages"] else "n", "y" if e["supportsReasoning"] else "n"))

    if not a.apply:
        print("\n[dry-run] nothing written. rerun with --apply")
        return 0

    bak = "%s.bak-%s" % (path, time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(path, bak)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print("\nbackup    : %s" % bak)
    print("[ok] written. restart WorkBuddy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
