#!/usr/bin/env python3
"""Model-side result composer for the THDisc example. Emits an askui spec."""
import json, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
data = json.load(open(root / 'data/circles.json'))
selected = set(json.loads(sys.argv[1]) if len(sys.argv) > 1 else [])
rest = [c for c in data if c['name'] not in selected]
base = "rsync://patchouli@rsync.thdisc.com:874/tlmc/"

if rest:
    items = [{
        "title": c['name'],
        "desc": c['intro'],
        "tag": f"{c['genre']} · {c['n']} 张",
        "code": f"rsync-ssl -av '{base}[{c['name']}]/' ~/Music/tlmc/"
    } for c in rest]
    script = "mkdir -p ~/Music/tlmc\n" + "\n".join(
        f"rsync-ssl -av --info=progress2 '{base}[{c['name']}]/' ~/Music/tlmc/" for c in rest)
    blocks = [
        {"type": "list", "items": items},
        {"type": "code", "label": f"一次同步全部 {len(rest)} 个社团", "code": script},
    ]
    subtitle = f"你勾了 {len(selected)} 个，剩 {len(rest)} 个；共 {sum(c['n'] for c in rest)} 张专辑。"
else:
    blocks = [{"type": "text", "text": "25 个你全认识，没得推荐了。"}]
    subtitle = "下次少勾几个，留点给 AI 发挥。"

spec = {
    "kicker": "THDISC · AI RESULT",
    "title": "AI 整理好了",
    "subtitle": subtitle,
    "meta": ["模型已接手", f"排除 {len(selected)} 个", f"推荐 {len(rest)} 个"],
    "blocks": blocks,
    "submit": {"label": "完成", "note": "需要站点账号 patchouli；命令会提示密码。"}
}
json.dump(spec, sys.stdout, ensure_ascii=False, indent=1)
