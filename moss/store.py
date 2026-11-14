# -*- coding: utf-8 -*-
"""SQLite 存储：一份 layout = 草稿 JSON + 可选底图。"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import sqlite3
import time
from datetime import datetime, timezone

from . import spec

SCHEMA = """
CREATE TABLE IF NOT EXISTS layouts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    doc         TEXT    NOT NULL,
    notes       TEXT    NOT NULL DEFAULT '{}',
    image       TEXT,
    image_name  TEXT,
    item_count  INTEGER NOT NULL DEFAULT 0,
    rev         INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_layouts_updated ON layouts(updated_at DESC);
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class Store:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.db_path = os.path.join(self.root, "app.db")
        self.upload_dir = os.path.join(self.root, "uploads")
        os.makedirs(self.root, exist_ok=True)
        os.makedirs(self.upload_dir, exist_ok=True)
        with self._db() as conn:
            conn.executescript(SCHEMA)
        self._migrate_legacy_notes()

    def _migrate_legacy_notes(self):
        """老库里中文参考单独存在 notes 列：一次性并进 caption，然后清空 notes。"""
        with self._db() as conn:
            rows = conn.execute(
                "SELECT id, doc, notes FROM layouts WHERE notes NOT IN ('', '{}', 'null')"
            ).fetchall()
            for row in rows:
                doc = _loads(row["doc"], None)
                if not isinstance(doc, dict):
                    continue
                merged = spec.merge_notes(doc, _loads(row["notes"], None))
                conn.execute("UPDATE layouts SET doc = ?, notes = '{}' WHERE id = ?",
                             (_dumps(merged), row["id"]))

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    @contextlib.contextmanager
    def _db(self):
        conn = self._connect()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ── 读 ────────────────────────────────────────────────────────────────
    def list_layouts(self):
        with self._db() as conn:
            rows = conn.execute(
                "SELECT id, name, width, height, doc, image, item_count, rev, "
                "created_at, updated_at FROM layouts ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        return [self._summary(row) for row in rows]

    def _summary(self, row):
        doc = _loads(row["doc"], {})
        summary = doc.get("summary") or {}
        items = doc.get("items") or []
        return {
            "id": row["id"],
            "name": row["name"],
            "width": row["width"],
            "height": row["height"],
            "caption": summary.get("caption") or "",
            "item_count": row["item_count"],
            "has_image": bool(row["image"]),
            "rev": row["rev"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            # 列表缩略图只需要框和类型
            "items": [
                {"label": item.get("label") or "object", "bbox": item.get("bbox") or [0, 0, 0, 0]}
                for item in items[:80] if isinstance(item, dict)
            ],
        }

    def get(self, layout_id):
        with self._db() as conn:
            row = conn.execute("SELECT * FROM layouts WHERE id = ?", (layout_id,)).fetchone()
        if row is None:
            return None
        doc = _loads(row["doc"], None)
        notes = _loads(row["notes"], {})
        return {
            "id": row["id"],
            "name": row["name"],
            "width": row["width"],
            "height": row["height"],
            "doc": doc,
            "notes": notes,
            "image": row["image"],
            "image_name": row["image_name"],
            "item_count": row["item_count"],
            "rev": row["rev"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # ── 写 ────────────────────────────────────────────────────────────────
    def create(self, name, width, height, doc, notes):
        stamp = now_iso()
        with self._db() as conn:
            cursor = conn.execute(
                "INSERT INTO layouts (name, width, height, doc, notes, item_count, rev, "
                "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (name, width, height, _dumps(doc), _dumps(notes), len(doc.get("items") or []),
                 1, stamp, stamp),
            )
            layout_id = cursor.lastrowid
        return self.get(layout_id)

    def update(self, layout_id, doc=None, notes=None, name=None, rev=None, force=False):
        current = self.get(layout_id)
        if current is None:
            return None, "not_found"
        if doc is not None and rev is not None and int(rev) != current["rev"] and not force:
            return None, "conflict"
        fields, values = [], []
        if name is not None:
            fields.append("name = ?")
            values.append(name)
        if doc is not None:
            fields += ["doc = ?", "width = ?", "height = ?", "item_count = ?"]
            values += [_dumps(doc), int(doc["width"]), int(doc["height"]),
                       len(doc.get("items") or [])]
        if notes is not None:
            fields.append("notes = ?")
            values.append(_dumps(notes))
        if doc is not None:
            fields.append("rev = rev + 1")
        fields.append("updated_at = ?")
        values.append(now_iso())
        values.append(layout_id)
        with self._db() as conn:
            conn.execute(f"UPDATE layouts SET {', '.join(fields)} WHERE id = ?", values)
        return self.get(layout_id), None

    def delete(self, layout_id):
        current = self.get(layout_id)
        if current is None:
            return False
        image = current.get("image")
        with self._db() as conn:
            conn.execute("DELETE FROM layouts WHERE id = ?", (layout_id,))
        if image:
            try:
                os.remove(os.path.join(self.upload_dir, os.path.basename(image)))
            except OSError:
                pass
        return True

    def duplicate(self, layout_id):
        current = self.get(layout_id)
        if current is None:
            return None
        with self._db() as conn:
            row = conn.execute("SELECT image, image_name FROM layouts WHERE id = ?",
                               (layout_id,)).fetchone()
        created = self.create(f"{current['name']} 副本", current["width"], current["height"],
                              current["doc"], current["notes"])
        if row and row["image"]:
            source = os.path.join(self.upload_dir, os.path.basename(row["image"]))
            if os.path.exists(source):
                ext = os.path.splitext(source)[1] or ".png"
                copy_name = f"{created['id']}-{int(time.time() * 1000)}{ext}"
                shutil.copyfile(source, os.path.join(self.upload_dir, copy_name))
                self.set_image(created["id"], copy_name, row["image_name"] or "")
                created = self.get(created["id"])
        return created

    # ── 底图 ──────────────────────────────────────────────────────────────
    def set_image(self, layout_id, path, original_name=""):
        current = self.get(layout_id)
        if current and current.get("image") and current["image"] != path:
            try:
                os.remove(os.path.join(self.upload_dir, os.path.basename(current["image"])))
            except OSError:
                pass
        with self._db() as conn:
            conn.execute("UPDATE layouts SET image = ?, image_name = ?, updated_at = ? WHERE id = ?",
                         (path, original_name, now_iso(), layout_id))
        return self.get(layout_id)

    def clear_image(self, layout_id):
        current = self.get(layout_id)
        if not current:
            return
        if current.get("image"):
            path = os.path.join(self.upload_dir, os.path.basename(current["image"]))
            try:
                os.remove(path)
            except OSError:
                pass
        with self._db() as conn:
            conn.execute("UPDATE layouts SET image = NULL, image_name = NULL, updated_at = ? "
                         "WHERE id = ?", (now_iso(), layout_id))

    def image_path(self, layout_id):
        current = self.get(layout_id)
        if not current or not current.get("image"):
            return None
        path = os.path.join(self.upload_dir, os.path.basename(current["image"]))
        return path if os.path.exists(path) else None


def _dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _loads(text, default):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default
