#!/usr/bin/env python3
"""
opencode Go catalog collector — the "auto discover models and their config" piece.

Two authoritative sources, merged:
  1. gateway  https://opencode.ai/inference/go/v1/models   -> which models exist (no auth)
  2. metadata https://models.dev/api.json -> provider "opencode-go" -> how to call each model
     (wire protocol, context window, output limit, reasoning, image input, price)

Output: models-catalog.json next to this file, consumed by install-models.py and
by node-bridge/src/bridge.js (it reads the protocol field to pick the upstream
endpoint instead of hard-coding model names).

Usage:
  python catalog.py                # print table, use cache when fresh
  python catalog.py --refresh      # force refetch
  python catalog.py --json         # print machine json only
"""

import argparse
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "models-catalog.json")
TTL_SECONDS = 6 * 3600

GATEWAY_BASE = os.environ.get("OPENCODE_GO_GATEWAY", "https://opencode.ai/inference/go")
MODELS_URL = GATEWAY_BASE.rstrip("/") + "/v1/models"
METADATA_URL = "https://models.dev/api.json"

NPM_TO_PROTOCOL = {
    "@ai-sdk/anthropic": "anthropic",
    "@ai-sdk/openai": "responses",
    "@ai-sdk/openai-compatible": "chat",
    "@ai-sdk/google": "google",
}

# Every protocol the gateway exposes is translated: OpenAI chat, Anthropic
# Messages, OpenAI Responses and Google generateContent.
UNUSABLE = ()

# Order used by both WorkBuddy and models.dev. "none"/"off" means thinking can
# be turned off, not a level of its own.
EFFORT_ORDER = ("minimal", "low", "medium", "high", "xhigh", "max")


def parse_reasoning_options(options):
    """models.dev `reasoning_options` -> WorkBuddy reasoning capabilities.

    Example: gpt-6-luna declares
    `[{"type":"effort","values":["none","low","medium","high","xhigh","max"]}]`
    which maps to supportedEfforts low..max plus canDisableThinking.
    """
    efforts = set()
    can_disable = False
    budget_max = None
    for option in options or []:
        if not isinstance(option, dict):
            continue
        kind = option.get("type")
        if kind == "effort":
            for value in option.get("values") or []:
                if not isinstance(value, str):
                    continue
                value = value.strip().lower()
                if value in ("none", "off", "disabled"):
                    can_disable = True
                elif value in EFFORT_ORDER:
                    efforts.add(value)
        elif kind == "toggle":
            can_disable = True
        elif kind == "budget_tokens":
            maximum = option.get("max")
            if isinstance(maximum, (int, float)):
                budget_max = int(maximum)

    ordered = [e for e in EFFORT_ORDER if e in efforts]
    if "medium" in ordered:
        default = "medium"
    elif "high" in ordered:
        default = "high"
    elif ordered:
        default = ordered[0]
    else:
        default = None
    return {
        "reasoningEfforts": ordered,
        "defaultEffort": default,
        "canDisableThinking": can_disable,
        "thinkingBudgetMax": budget_max,
    }


def fetch_json(url, timeout=60):
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "workbuddy-opencode-go-catalog/1.0",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def collect():
    listing = fetch_json(MODELS_URL)
    ids = [row.get("id") for row in (listing.get("data") or []) if row.get("id")]
    ids = [i for i in dict.fromkeys(ids) if isinstance(i, str) and i.strip()]

    meta = fetch_json(METADATA_URL, timeout=120)
    provider = (meta.get("opencode-go") or {})
    default_npm = provider.get("npm") or "@ai-sdk/openai-compatible"
    entries = provider.get("models") or {}

    models, missing_meta = [], []
    for mid in ids:
        m = entries.get(mid)
        if not isinstance(m, dict):
            missing_meta.append(mid)
            models.append({
                "id": mid, "name": mid, "protocol": "unknown",
                "context": None, "output": None,
                "reasoning": None, "reasoningEfforts": [], "defaultEffort": None,
                "canDisableThinking": False, "thinkingBudgetMax": None,
                "images": None,
                "costIn": None, "costOut": None,
                "costCacheRead": None, "costCacheWrite": None, "status": "",
            })
            continue
        npm = ((m.get("provider") or {}).get("npm")) or default_npm
        protocol = NPM_TO_PROTOCOL.get(npm, "unknown")
        limit = m.get("limit") or {}
        cost = m.get("cost") or {}
        mods = (m.get("modalities") or {}).get("input") or []
        thinking = parse_reasoning_options(m.get("reasoning_options"))
        models.append({
            "id": mid,
            "name": m.get("name") or mid,
            "protocol": protocol,
            "context": limit.get("context"),
            "output": limit.get("output"),
            "reasoning": bool(m.get("reasoning")),
            "reasoningEfforts": thinking["reasoningEfforts"],
            "defaultEffort": thinking["defaultEffort"],
            "canDisableThinking": thinking["canDisableThinking"],
            "thinkingBudgetMax": thinking["thinkingBudgetMax"],
            "images": "image" in mods if isinstance(mods, list) else False,
            "costIn": cost.get("input"),
            "costOut": cost.get("output"),
            "costCacheRead": cost.get("cache_read"),
            "costCacheWrite": cost.get("cache_write"),
            "status": m.get("status") or "",
            "releaseDate": m.get("release_date") or "",
        })

    models.sort(key=lambda x: (x["protocol"], x["id"]))
    catalog = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "generatedAtMs": int(time.time() * 1000),
        "sources": {"gateway": MODELS_URL, "metadata": METADATA_URL},
        "counts": {
            "gateway": len(ids),
            "usable": sum(1 for m in models if m["protocol"] not in UNUSABLE and m["protocol"] != "unknown"),
        },
        "models": models,
        "missingMetadata": missing_meta,
        "notInGateway": sorted(set(entries) - set(ids)),
    }
    return catalog


def recount(catalog):
    """Recompute the usable count so a cached file survives rule changes."""
    models = catalog.get("models") or []
    catalog["counts"] = {
        "gateway": len(models),
        "usable": sum(
            1 for m in models
            if m.get("protocol") not in UNUSABLE and m.get("protocol") != "unknown"
        ),
    }
    return catalog


def load(force=False):
    if not force and os.path.exists(CACHE):
        try:
            with open(CACHE, "r", encoding="utf-8") as f:
                saved = json.load(f)
            age = time.time() - (saved.get("generatedAtMs", 0) / 1000.0)
            if 0 <= age < TTL_SECONDS:
                return recount(saved), False
        except Exception:
            pass
    catalog = collect()
    tmp = CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CACHE)
    return catalog, True


def print_table(catalog):
    print("gateway %d models | usable for WorkBuddy %d | fetched %s" % (
        catalog["counts"]["gateway"], catalog["counts"]["usable"], catalog["generatedAt"]))
    print()
    print("%-10s %-28s %9s %8s %4s %4s %-22s %7s %7s  %s" %
          ("protocol", "id", "ctx", "out", "rsn", "img", "think", "in$", "out$", "name"))
    print("-" * 132)
    for m in catalog["models"]:
        levels = m.get("reasoningEfforts") or []
        think = "/".join(levels) if levels else ("-" if not m.get("reasoning") else "on")
        if m.get("canDisableThinking") and think not in ("-", "on"):
            think += "|off"
        print("%-10s %-28s %9s %8s %4s %4s %-22s %7s %7s  %s" % (
            m["protocol"], m["id"],
            m["context"] if m["context"] is not None else "-",
            m["output"] if m["output"] is not None else "-",
            "y" if m["reasoning"] else ("-" if m["reasoning"] is None else "n"),
            "y" if m["images"] else ("-" if m["images"] is None else "n"),
            think,
            m["costIn"] if m["costIn"] is not None else "-",
            m["costOut"] if m["costOut"] is not None else "-",
            m["name"]))
    if catalog["missingMetadata"]:
        print("\nno metadata (gateway only): %s" % ", ".join(catalog["missingMetadata"]))
    if catalog["notInGateway"]:
        print("metadata only (not served now): %s" % ", ".join(catalog["notInGateway"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    catalog, fresh = load(force=a.refresh)
    if a.json:
        print(json.dumps(catalog, indent=2, ensure_ascii=False))
        return 0
    print_table(catalog)
    if not fresh:
        print("\n[cache] %s   (--refresh to refetch)" % CACHE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
