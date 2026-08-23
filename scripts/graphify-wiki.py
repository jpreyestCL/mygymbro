#!/usr/bin/env python3
"""Regenerate graphify-out/wiki/ from the current graph.

graphify's CLI rebuilds graph.json and GRAPH_REPORT.md (post-commit hook, `graphify update .`)
but has no flag for the wiki, which is the layer agents actually navigate. This reads the
artifacts the CLI just wrote and re-renders the articles from them. No LLM, no API cost.

    ./scripts/graphify-wiki.py [repo-root]
"""
import fcntl
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
out = root / "graphify-out"
if not (out / "graph.json").exists():
    sys.exit("no graphify-out/graph.json — run `graphify extract . --code-only` first")


def cli_python() -> str | None:
    """The interpreter backing the `graphify` on PATH, read from its shebang.

    Plain `python3` may have a *different, older* graphify importable (this machine has a
    stale 0.4.13 in the Homebrew 3.14 site-packages), and an old wiki.py against a new
    analysis file fails on renamed keys. Always render with the CLI's own interpreter.
    """
    binary = shutil.which("graphify")
    if not binary:
        return None
    try:
        shebang = Path(binary).read_text(encoding="utf-8", errors="ignore").splitlines()[0]
    except (OSError, IndexError):
        return None
    if not shebang.startswith("#!"):
        return None
    interp = shebang[2:].strip().removeprefix("/usr/bin/env ").strip()
    return interp if interp and Path(interp).exists() else None


target = cli_python()
if target and os.path.realpath(target) != os.path.realpath(sys.executable):
    sys.exit(subprocess.call([target, __file__, str(root)]))

try:
    from graphify.serve import _load_graph
    from graphify.wiki import to_wiki
except ImportError:
    sys.exit("graphify not importable — install it with: uv tool install -U graphifyy")

# to_wiki() clears and rewrites wiki/, and two things can call this at once: the
# post-commit hook and the LaunchAgent watching graph.json. Whoever loses the race has
# nothing to add — the winner is rendering the same graph — so bail instead of queueing.
lock = open(out / ".wiki.lock", "w")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(0)

G = _load_graph(str(out / "graph.json"))
analysis = json.loads((out / ".graphify_analysis.json").read_text())
communities = {int(k): v for k, v in analysis["communities"].items()}
cohesion = {int(k): v for k, v in analysis.get("cohesion", {}).items()}

labels_file = out / ".graphify_labels.json"
labels = None
if labels_file.exists():
    labels = {int(k): v for k, v in json.loads(labels_file.read_text()).items()}

n = to_wiki(G, communities, out / "wiki", community_labels=labels,
            cohesion=cohesion, god_nodes_data=analysis.get("gods"))
print(f"[graphify wiki] {n} articles + index.md -> {out / 'wiki'}")
