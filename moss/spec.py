# -*- coding: utf-8 -*-
"""MOSS layout 规范实现：归一化 / 校验 / 编译 / Klein 导出。

坐标口径与官方 `compile_prompt.py`、`to_klein.py` 对齐：
  草稿    abs / xyxy   [x1,y1,x2,y2] 像素，左上原点
  编译稿  abs_centralized / yxyx  中心原点，先 floor 左上、ceil 右下再减半画布
  Klein   0-1000 / [y,x,y,x] 左上原点，文字框四周留余量

编辑器的内部文档只存 abs/xyxy；导出时才转成两套对外口径。
"""

from __future__ import annotations

import json
import math
import re

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
LABELS = ("object", "character", "text")
CANVASES = ("single", "multi_panel", "collage")
MAX_CANVAS = 16384

# Klein 生成 id 时跳过的虚词/形容词（与 to_klein.py 一致）
KLEIN_SKIP = {
    "a", "an", "the", "flat", "solid", "single", "one", "two", "three", "large",
    "small", "tiny", "big", "bold", "simple", "clean", "warm", "dark", "light",
    "high", "low", "full", "matte", "off", "white", "black", "red", "blue", "green",
}


class SpecError(ValueError):
    """输入无法归一化或编译。"""


# ── 小工具 ────────────────────────────────────────────────────────────────

def _merge_captions(en, zh):
    """英文 + 中文 → 唯一的 caption：只有一边就用那一边，两边都有就换行接上。"""
    en = str(en or "").strip()
    zh = str(zh or "").strip()
    if not en:
        return zh
    if not zh or zh in en:
        return en
    return en + "\n" + zh


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        out = []
        for item in value:
            text = str(item).strip()
            if text:
                out.append(text)
        return out
    return [piece.strip() for piece in re.split(r"[,，]", str(value)) if piece.strip()]


def _as_int(value, default=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return int(round(number))


def _round_half_up(value):
    """JS 的 Math.round：.5 一律向上，不用 Python 的银行家舍入。"""
    return int(math.floor(value + 0.5))


def blank_item(width, height, label="object"):
    return {
        "label": label if label in LABELS else "object",
        "caption": "",
        "text": "",
        "tags": [],
        "palette": [],
        "bbox": [0, 0, int(width), int(height)],
    }


def blank_doc(width=1152, height=1536):
    return {
        "width": int(width),
        "height": int(height),
        "summary": {
            "caption": "",
            "meta": [],
            "canvas": "single",
            "palette": [],
        },
        "items": [],
    }


# ── 归一化 ────────────────────────────────────────────────────────────────

def normalize_doc(raw, width=None, height=None):
    """把任意草稿/编译稿/caption 稿统一成内部文档（abs + xyxy，只有一个 caption）。

    返回 (doc, warnings)。结构性错误抛 SpecError。
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as error:
            raise SpecError(f"JSON 解析失败：{error.msg}（第 {error.lineno} 行）")
    if not isinstance(raw, dict):
        raise SpecError("顶层必须是 JSON 对象")

    warnings = []
    if "caption" in raw and "summary" not in raw and "items" not in raw and "elements" not in raw:
        doc = blank_doc(_as_int(width, 1024), _as_int(height, 1024))
        doc["summary"]["caption"] = str(raw.get("caption") or "").strip()
        warnings.append("这是一段纯 caption，已转成空白画布 + 整图描述")
        return doc, warnings

    canvas_w = _as_int(raw.get("width")) or _as_int(width)
    canvas_h = _as_int(raw.get("height")) or _as_int(height)
    space = str(raw.get("bbox_coord_space") or "").strip()
    fmt = str(raw.get("bbox_format") or "").strip()
    if not space:
        space = "abs_centralized" if fmt == "yxyx" else "abs"
    if not fmt:
        fmt = "yxyx" if space == "abs_centralized" else "xyxy"

    if not canvas_w or not canvas_h or canvas_w <= 0 or canvas_h <= 0:
        if space == "abs_centralized":
            canvas_w, canvas_h = 1024, 1024
            warnings.append("编译稿不带画布尺寸，先按 1024×1024 打开，记得改成原尺寸")
        else:
            raise SpecError("缺少画布 width / height")
    if canvas_w > MAX_CANVAS or canvas_h > MAX_CANVAS:
        raise SpecError(f"画布尺寸超过 {MAX_CANVAS}px 上限")

    if canvas_w % 16 or canvas_h % 16:
        canvas_w = max(16, _round_half_up(canvas_w / 16) * 16)
        canvas_h = max(16, _round_half_up(canvas_h / 16) * 16)
        warnings.append(f"画布尺寸已对齐到 16 的倍数：{canvas_w}×{canvas_h}")

    summary_raw = raw.get("summary") if isinstance(raw.get("summary"), dict) else {}
    canvas_kind = str(summary_raw.get("canvas") or "").strip()
    if canvas_kind not in CANVASES:
        canvas_kind = "single"
    meta_raw = summary_raw.get("meta")
    if meta_raw is None and raw.get("scene_type"):
        meta_raw = [raw.get("scene_type")]

    summary = {
        # 只有一个描述字段：老数据里的 caption_zh 并进来（英文在前）
        "caption": _merge_captions(summary_raw.get("caption"), summary_raw.get("caption_zh"))
                   or str(raw.get("gen_brief") or "").strip(),
        "meta": _as_list(meta_raw),
        "canvas": canvas_kind,
        "palette": _as_list(summary_raw.get("palette")),
    }

    raw_items = raw.get("items")
    if raw_items is None:
        raw_items = raw.get("elements")
    if raw_items is None:
        raw_items = []
    if not isinstance(raw_items, list):
        raise SpecError("items 必须是数组")

    # 编译稿：abs_centralized + yxyx，先转成左上原点像素
    central = space == "abs_centralized"
    yxyx = fmt == "yxyx"
    if central or yxyx:
        warnings.append("已按编译稿口径（中心原点 / yxyx）换算回草稿坐标")

    items = []
    clipped = 0
    for index, item in enumerate(raw_items):
        if not isinstance(item, dict):
            raise SpecError(f"items[{index}] 必须是对象")
        box = item.get("bbox")
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            raise SpecError(f"items[{index}].bbox 必须是四个数字")
        values = [_as_int(v) for v in box]
        if any(v is None for v in values):
            raise SpecError(f"items[{index}].bbox 含非数字")
        if yxyx:
            y1, x1, y2, x2 = values
        else:
            x1, y1, x2, y2 = values
        if central:
            x1 += canvas_w / 2
            y1 += canvas_h / 2
            x2 += canvas_w / 2
            y2 += canvas_h / 2
        x1, y1, x2, y2 = (_round_half_up(v) for v in (x1, y1, x2, y2))

        cx1, cy1 = max(0, min(canvas_w, x1)), max(0, min(canvas_h, y1))
        cx2, cy2 = max(0, min(canvas_w, x2)), max(0, min(canvas_h, y2))
        if (cx1, cy1, cx2, cy2) != (x1, y1, x2, y2):
            clipped += 1
        x1, y1, x2, y2 = cx1, cy1, cx2, cy2
        if x2 <= x1:
            x2 = min(canvas_w, x1 + 8)
        if y2 <= y1:
            y2 = min(canvas_h, y1 + 8)

        label = str(item.get("label") or item.get("type") or "object").strip()
        if label not in LABELS:
            warnings.append(f"#{index + 1} 的 label “{label}” 不认识，已按 object 处理")
            label = "object"

        items.append({
            "label": label,
            "caption": _merge_captions(item.get("caption"), item.get("caption_zh"))
                       or str(item.get("identity") or "").strip(),
            "text": str(item.get("text") or ""),
            "tags": _as_list(item.get("tags")),
            "palette": _as_list(item.get("palette")),
            "bbox": [x1, y1, x2, y2],
        })

    if clipped:
        warnings.append(f"{clipped} 个框越界，已裁进画布")

    return {
        "width": canvas_w,
        "height": canvas_h,
        "summary": summary,
        "items": items,
    }, warnings


def _fold_caption(target, zh):
    """把一段中文并进唯一的 caption；已有同一段中文时不重复追加。"""
    target["caption"] = _merge_captions(target.get("caption"), zh)


def merge_notes(doc, notes):
    """兼容旧数据：把 sidecar 里的中文参考并进 caption，然后抹掉 caption_zh。

    新写的稿子没有 notes，这函数就是一次深拷贝。
    """
    merged = json.loads(json.dumps(doc))
    if isinstance(notes, dict):
        summary_zh = notes.get("summary_zh")
        _fold_caption(merged["summary"], summary_zh)
        note_items = notes.get("items") or []
        if isinstance(note_items, list):
            for index, item in enumerate(merged["items"]):
                if index < len(note_items) and isinstance(note_items[index], dict):
                    _fold_caption(item, note_items[index].get("caption_zh"))
    for target in [merged["summary"], *merged["items"]]:
        _fold_caption(target, target.pop("caption_zh", None))
    return merged


def split_notes(doc):
    """只留官方认的字段：返回 (规范草稿, 空 notes)。"""
    canonical = {
        "width": int(doc["width"]),
        "height": int(doc["height"]),
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": {
            "caption": str(doc["summary"].get("caption") or ""),
            "meta": _as_list(doc["summary"].get("meta")),
            "canvas": doc["summary"].get("canvas")
            if doc["summary"].get("canvas") in CANVASES else "single",
            "palette": _as_list(doc["summary"].get("palette")),
        },
        "items": [],
    }
    for item in doc["items"]:
        canonical["items"].append({
            "label": item.get("label") if item.get("label") in LABELS else "object",
            "caption": str(item.get("caption") or ""),
            "text": str(item.get("text") or ""),
            "tags": _as_list(item.get("tags")),
            "palette": _as_list(item.get("palette")),
            "bbox": [int(v) for v in item["bbox"]],
        })
    # 中文参考已经并进 caption，不再需要 sidecar
    return canonical, {}


# ── 文案取值 ──────────────────────────────────────────────────────────────

def effective_caption(item, lang="en"):
    """唯一的描述字段；lang 只为兼容旧调用保留，不再参与取值。"""
    return str(item.get("caption") or "").strip()


def effective_summary(doc, lang="en"):
    return str(doc["summary"].get("caption") or "").strip()


# ── 重叠 ──────────────────────────────────────────────────────────────────

def _is_ground(box, width, height):
    return (box[2] - box[0]) >= width * 0.9 and (box[3] - box[1]) >= height * 0.9


def _contains(a, b):
    return a[0] <= b[0] and a[1] <= b[1] and a[2] >= b[2] and a[3] >= b[3]


OCCLUSION_RE = re.compile(r"in front of|behind|occlud|hidden", re.I)


def has_occlusion(item):
    return bool(OCCLUSION_RE.search(item.get("caption") or ""))


def overlap_pairs(doc):
    width, height = doc["width"], doc["height"]
    items = doc["items"]
    pairs = []
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            a, b = items[i]["bbox"], items[j]["bbox"]
            if _is_ground(a, width, height) or _is_ground(b, width, height):
                continue
            if _contains(a, b) or _contains(b, a):
                continue
            x1, y1 = max(a[0], b[0]), max(a[1], b[1])
            x2, y2 = min(a[2], b[2]), min(a[3], b[3])
            if x2 - x1 > 0 and y2 - y1 > 0:
                pairs.append({"i": i, "j": j, "rect": [x1, y1, x2, y2],
                              "area": (x2 - x1) * (y2 - y1)})
    pairs.sort(key=lambda pair: -pair["area"])
    return pairs


# ── 校验 ──────────────────────────────────────────────────────────────────

def validate(doc, lang="en"):
    errors, warnings = [], []
    width, height = doc["width"], doc["height"]
    if not isinstance(width, int) or width <= 0 or width % 16:
        errors.append("画布宽度必须是 16 的正整数倍")
    if not isinstance(height, int) or height <= 0 or height % 16:
        errors.append("画布高度必须是 16 的正整数倍")
    if not effective_summary(doc, lang):
        errors.append("整图描述为空：这里要写“整张图是什么”")

    items = doc["items"]
    if not items:
        errors.append("items 为空：至少给一个元素")

    for index, item in enumerate(items):
        tag = f"#{index + 1}"
        if not effective_caption(item, lang):
            errors.append(f"{tag} 的图层描述为空（每块都必须描述它长什么样）")
        if item.get("label") == "text" and not str(item.get("text") or "").strip():
            errors.append(f"{tag} 是文字块，但 text 为空")
        x1, y1, x2, y2 = item["bbox"]
        if not (x1 < x2 and y1 < y2):
            errors.append(f"{tag} 的框宽高必须为正")
        if x1 < 0 or y1 < 0 or x2 > width or y2 > height:
            errors.append(f"{tag} 的框超出画布")
        if item.get("label") == "text" and (y2 - y1) < 24:
            warnings.append(f"{tag} 框高只有 {y2 - y1}px，字会很小")
        if item.get("label") == "text" and len(str(item.get("text") or "")) > 200:
            warnings.append(f"{tag} 有 {len(item['text'])} 字，单块过多容易糊")

    if len(items) > 24:
        warnings.append(f"元素 {len(items)} 个，偏多；文字块越碎越难渲染")
    unresolved = [pair for pair in overlap_pairs(doc)
                  if not (has_occlusion(items[pair["i"]]) or has_occlusion(items[pair["j"]]))]
    if unresolved:
        warnings.append(f"{len(unresolved)} 对框重叠且没写前后关系 → 右侧「重叠与前后」可复制询问单")
    if items and not any(item["bbox"][0] <= 0 and item["bbox"][1] <= 0
                         and item["bbox"][2] >= width and item["bbox"][3] >= height
                         for item in items):
        warnings.append("没有铺满全画布的背景元素，背景可能由模型自己编")

    return errors, warnings


# ── 导出：草稿 / 编译稿 / 笔记 ─────────────────────────────────────────────

def _summary_obj(doc, lang):
    summary = {"caption": effective_summary(doc, lang)}
    raw = doc["summary"]
    if raw.get("meta"):
        summary["meta"] = list(raw["meta"])
    if raw.get("canvas"):
        summary["canvas"] = raw["canvas"]
    if raw.get("palette"):
        summary["palette"] = list(raw["palette"])
    return summary


def canonical_doc(doc, lang="en"):
    """只留官方认的字段，字段顺序与 canvas.py 导出时一致。"""
    items = []
    for item in doc["items"]:
        entry = {"label": item["label"], "caption": effective_caption(item, lang)}
        if item.get("label") == "text":
            entry["text"] = item["text"]
        if item.get("tags"):
            entry["tags"] = list(item["tags"])
        if item.get("palette"):
            entry["palette"] = list(item["palette"])
        entry["bbox"] = [int(v) for v in item["bbox"]]
        items.append(entry)
    return {
        "width": doc["width"],
        "height": doc["height"],
        "summary": _summary_obj(doc, lang),
        "items": items,
    }


def draft_obj(doc, lang="en"):
    data = canonical_doc(doc, lang)
    return {
        "width": data["width"],
        "height": data["height"],
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": data["summary"],
        "items": data["items"],
    }


def centered_box(box, width, height):
    """官方 compiler：先 floor 左上、ceil 右下，再各减半画布。"""
    x1, y1, x2, y2 = box
    return [
        math.floor(y1) - height // 2,
        math.floor(x1) - width // 2,
        math.ceil(y2) - height // 2,
        math.ceil(x2) - width // 2,
    ]


def compile_prompt(doc, lang="en"):
    data = canonical_doc(doc, lang)
    width, height = data["width"], data["height"]
    compiled_items = []
    for item in data["items"]:
        entry = {key: value for key, value in item.items() if key != "bbox"}
        entry["bbox"] = centered_box(item["bbox"], width, height)
        compiled_items.append(entry)
    result = {
        "summary": data["summary"],
        "items": compiled_items,
        "bbox_coord_space": "abs_centralized",
        "bbox_format": "yxyx",
    }
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def draft_json(doc, lang="en"):
    return json.dumps(draft_obj(doc, lang), ensure_ascii=False, indent=1)




# ── 导出：Klein i2i_bbox ──────────────────────────────────────────────────

def _klein_id(item, counters, text_prefix):
    if item["label"] == "text":
        counters["text"] = counters.get("text", 0) + 1
        if text_prefix in ("En", "Cn"):
            prefix = text_prefix
        else:
            prefix = "Cn" if CJK_RE.search(item.get("text") or "") else "En"
        return f"{prefix}_Text_{counters['text']}"
    word = ""
    for token in re.findall(r"[a-zA-Z][a-zA-Z\-]*", item.get("caption") or "")[:8]:
        lowered = token.lower()
        if lowered not in KLEIN_SKIP and len(lowered) > 2:
            word = lowered
            break
    word = re.sub(r"[^a-z\-]", "", word) or "object"
    counters[word] = counters.get(word, 0) + 1
    return f"{word}_{counters[word]}"


def klein_rows(doc, lang="en", task="t2i", refs=1, from_map=None, text_margin=8.0,
               text_prefix="auto"):
    width, height = doc["width"], doc["height"]
    from_map = from_map if isinstance(from_map, dict) else {}
    refs = max(1, min(4, _as_int(refs, 1) or 1))
    counters = {}
    rows = []

    def clamp(value):
        # 与 to_klein.py 的 round() 保持一致（Python 的 .5 取偶），CLI 结果逐字可对
        return int(max(0, min(1000, round(value))))

    for index, item in enumerate(doc["items"]):
        margin = float(text_margin) if item["label"] == "text" else 0.0
        x1, y1, x2, y2 = item["bbox"]
        box = [
            clamp(y1 / height * 1000 - margin),
            clamp(x1 / width * 1000 - margin),
            clamp(y2 / height * 1000 + margin),
            clamp(x2 / width * 1000 + margin),
        ]
        source = str(from_map.get(str(index), from_map.get(index, "target")))
        if task != "edit" or not re.fullmatch(r"ref_image_[0-3]", source):
            source = "target"
        elif int(source.rsplit("_", 1)[1]) >= refs:
            source = "target"
        # Klein 的 desc 压成一行（历史合并的 caption 可能带换行）
        desc = " ".join(effective_caption(item, lang).split())
        if item["label"] == "text" and item.get("text"):
            desc = f'{desc} Text reads: "{item["text"].replace(chr(10), " ")}".'.strip()
        rows.append({
            "id": _klein_id(item, counters, text_prefix),
            "from": source,
            "src_bbox": box if (task == "edit" and source != "target") else None,
            "tgt_bbox": box,
            "desc": desc,
        })
    return rows


def klein_instruction(instruction, task):
    text = str(instruction or "").strip()
    if task != "edit" or not text:
        return ""
    if not re.search(r"stays identical to the source\s*\.?$", text, re.I):
        text = re.sub(r"\.\s*$", "", text) + ". Everything else stays identical to the source."
    return text


def klein_warnings(rows, instruction):
    warnings = []
    if not instruction:
        warnings.append("指令段还是空的：第一次提到每个对象时要带 <id>，每个 id 恰好出现一次")
        return warnings
    missing = [row["id"] for row in rows if f"<{row['id']}>" not in instruction]
    repeated = [row["id"] for row in rows if instruction.count(f"<{row['id']}>") > 1]
    if missing:
        warnings.append("指令段里没引用这些 id：" + "、".join(missing))
    if repeated:
        warnings.append("这些 id 出现了不止一次：" + "、".join(repeated))
    return warnings


# ── 一次导出全部格式 ──────────────────────────────────────────────────────

def compile_all(doc, lang="en", klein=None):
    errors, warnings = validate(doc, lang)
    moss = None if errors else compile_prompt(doc, lang)
    drafts = draft_json(doc, lang)

    klein = klein if isinstance(klein, dict) else {}
    task = "edit" if klein.get("task") == "edit" else "t2i"
    rows = klein_rows(
        doc, lang,
        task=task,
        refs=klein.get("refs", 1),
        from_map=klein.get("from_map", {}),
        text_margin=klein.get("text_margin", 8),
        text_prefix=klein.get("text_prefix", "auto"),
    )
    instruction = klein_instruction(klein.get("instruction", ""), task)
    klein_text = None
    if task == "edit" and instruction and not errors:
        klein_text = instruction + " " + json.dumps(
            rows, ensure_ascii=False, separators=(",", ":"))
    klein_notes = klein_warnings(rows, instruction) if task == "edit" else []

    return {
        "validation": {"errors": errors, "warnings": warnings},
        "formats": {
            "moss": moss,
            "draft": drafts,
        },
        "klein": {
            "task": task,
            "text": klein_text,
            "rows": rows,
            "ids": [row["id"] for row in rows],
            "warnings": klein_notes,
            "instruction": instruction,
        },
        "stats": {
            "items": len(doc["items"]),
            "width": doc["width"],
            "height": doc["height"],
            "moss_chars": len(moss or ""),
        },
    }


def overlaps_payload(doc):
    items = doc["items"]
    pairs = overlap_pairs(doc)
    return [{
        "i": pair["i"],
        "j": pair["j"],
        "rect": pair["rect"],
        "done": has_occlusion(items[pair["i"]]) or has_occlusion(items[pair["j"]]),
    } for pair in pairs]
