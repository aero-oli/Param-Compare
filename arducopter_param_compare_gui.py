#!/usr/bin/env python3
"""
ArduCopter parameter file comparison tool with a desktop UI.

What it does:
- Compare two ArduPilot/ArduCopter parameter files
- Pull current parameter metadata from ArduPilot's published machine-readable
  parameter definitions (JSON first, XML fallback)
- Highlight changed / added / removed parameters
- Decode enum values and bitmasks where metadata is available
- Show parameter descriptions, units, and documented ranges
- Export HTML and CSV reports

The UI is built with tkinter so it has no third-party dependencies.
"""

from __future__ import annotations

import csv
import html
import json
import math
import queue
import re
import threading
import traceback
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

# =============================================================================
# CONFIG - edit these defaults if you want
# =============================================================================
DEFAULT_VEHICLE = "ArduCopter"
DEFAULT_VERSION_REF = ""
DEFAULT_METADATA_URL = f"https://autotest.ardupilot.org/Parameters/{DEFAULT_VEHICLE}/apm.pdef.json"
DEFAULT_VERSIONED_METADATA_URL_TEMPLATE = (
    "https://autotest.ardupilot.org/Parameters/versioned/Copter/{version}/apm.pdef.json"
)
DEFAULT_CACHE_DIR = ".ardupilot_param_compare_cache"
DEFAULT_OUTPUT_HTML = "arducopter_param_diff.html"
DEFAULT_OUTPUT_CSV = "arducopter_param_diff.csv"
DEFAULT_SORT_BY = "name"  # "name" or "status"
DEFAULT_SHOW_UNCHANGED = False
DEFAULT_OPEN_HTML_WHEN_EXPORTED = False
FLOAT_REL_TOL = 1e-9
FLOAT_ABS_TOL = 1e-12
WINDOW_TITLE = "ArduCopter Parameter Compare"
WINDOW_SIZE = "1600x950"
# =============================================================================

STATUS_ORDER = {"changed": 0, "added": 1, "removed": 2, "same": 3}
PARAM_SPLIT_RE = re.compile(r"[\t,= ]+")
PARAM_META_HINT_KEYS = {
    "Description",
    "DisplayName",
    "Units",
    "Range",
    "Values",
    "Bitmask",
    "User",
    "RebootRequired",
}


@dataclass(slots=True)
class ParamMeta:
    name: str
    display_name: str = ""
    description: str = ""
    units: str = ""
    user: str = ""
    low: str = ""
    high: str = ""
    values: dict[str, str] | None = None
    bitmask: dict[int, str] | None = None
    reboot_required: str = ""


@dataclass(slots=True)
class DiffRow:
    status: str
    name: str
    old_value: str
    new_value: str
    display_name: str
    units: str
    allowed_range: str
    old_decoded: str
    new_decoded: str
    description: str
    notes: str


# ----------------------------- file parsing --------------------------------- #

def strip_inline_comment(line: str) -> str:
    for marker in ("#", "//", ";"):
        if marker in line:
            line = line.split(marker, 1)[0]
    return line.strip()


def parse_param_file(path: Path) -> dict[str, str]:
    if not path.exists():
        raise FileNotFoundError(f"Parameter file not found: {path}")

    params: dict[str, str] = {}
    with path.open("r", encoding="utf-8-sig", errors="replace") as handle:
        for raw_line in handle:
            line = strip_inline_comment(raw_line)
            if not line:
                continue

            parts = [p for p in PARAM_SPLIT_RE.split(line.strip()) if p]
            if len(parts) < 2:
                continue

            name = parts[0].strip()
            value = parts[1].strip()
            if name:
                params[name] = value

    return params


# ---------------------------- metadata loading ------------------------------ #

def cache_path_for_url(cache_dir: Path, url: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", url)
    return cache_dir / safe


def read_text_file(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def download_text(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "ArduPilotParamCompareGUI/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def normalize_version_ref(version_ref: str) -> str:
    raw = version_ref.strip()
    if not raw:
        return ""

    lower = raw.lower()
    if lower.startswith("stable-"):
        return raw

    match = re.search(r"(\d+\.\d+\.\d+)$", raw)
    if match:
        return f"stable-{match.group(1)}"

    return raw


def resolve_metadata_url(metadata_url: str, version_ref: str) -> str:
    metadata_url = metadata_url.strip() or DEFAULT_METADATA_URL
    version_ref = normalize_version_ref(version_ref)
    if not version_ref:
        return metadata_url
    if "{version}" in metadata_url:
        return metadata_url.format(version=version_ref)
    if metadata_url == DEFAULT_METADATA_URL:
        return DEFAULT_VERSIONED_METADATA_URL_TEMPLATE.format(version=version_ref)
    return metadata_url


def looks_like_param_meta(node: Any) -> bool:
    return isinstance(node, dict) and any(key in node for key in PARAM_META_HINT_KEYS)


def decimalish(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_value_map(values: Any) -> dict[str, str] | None:
    if not isinstance(values, dict):
        return None
    out: dict[str, str] = {}
    for k, v in values.items():
        out[str(k).strip()] = str(v).strip()
    return out or None


def normalize_bitmask_map(values: Any) -> dict[int, str] | None:
    if not isinstance(values, dict):
        return None
    out: dict[int, str] = {}
    for k, v in values.items():
        try:
            out[int(str(k).strip())] = str(v).strip()
        except ValueError:
            continue
    return out or None


def flatten_json_metadata(node: Any, output: dict[str, ParamMeta]) -> None:
    if not isinstance(node, dict):
        return

    for key, value in node.items():
        if isinstance(value, dict) and looks_like_param_meta(value):
            rng = value.get("Range") if isinstance(value.get("Range"), dict) else {}
            output[str(key)] = ParamMeta(
                name=str(key),
                display_name=decimalish(value.get("DisplayName")),
                description=decimalish(value.get("Description")),
                units=decimalish(value.get("Units")),
                user=decimalish(value.get("User")),
                low=decimalish(rng.get("low")),
                high=decimalish(rng.get("high")),
                values=normalize_value_map(value.get("Values")),
                bitmask=normalize_bitmask_map(value.get("Bitmask")),
                reboot_required=decimalish(value.get("RebootRequired")),
            )
        elif isinstance(value, dict):
            flatten_json_metadata(value, output)


def parse_json_metadata(text: str) -> dict[str, ParamMeta]:
    obj = json.loads(text)
    output: dict[str, ParamMeta] = {}
    flatten_json_metadata(obj, output)
    return output


def child_text(elem: ET.Element, child_name: str) -> str:
    child = elem.find(child_name)
    if child is None or child.text is None:
        return ""
    return child.text.strip()


def field_text_map(elem: ET.Element) -> dict[str, str]:
    output: dict[str, str] = {}
    for field in elem.findall("./field"):
        name = (field.get("name") or "").strip()
        text = "".join(field.itertext()).strip()
        if name:
            output[name] = text
    return output


def parse_xml_metadata(text: str) -> dict[str, ParamMeta]:
    root = ET.fromstring(text)
    output: dict[str, ParamMeta] = {}

    for param_elem in root.findall(".//param"):
        name = (param_elem.get("name") or "").strip()
        if ":" in name:
            name = name.split(":", 1)[1]
        if not name:
            continue

        fields = field_text_map(param_elem)
        values: dict[str, str] = {}
        for value_elem in param_elem.findall("./values/value"):
            code = (value_elem.get("code") or "").strip()
            text_val = "".join(value_elem.itertext()).strip()
            if code:
                values[code] = text_val

        bitmask: dict[int, str] = {}
        for bit_elem in param_elem.findall("./bitmask/bit"):
            code = (bit_elem.get("code") or "").strip()
            text_val = "".join(bit_elem.itertext()).strip()
            try:
                bitmask[int(code)] = text_val
            except ValueError:
                continue

        range_text = fields.get("Range", "")
        low = ""
        high = ""
        parts = range_text.split()
        if len(parts) >= 2:
            low, high = parts[0], parts[1]

        if not bitmask and fields.get("Bitmask"):
            for item in fields["Bitmask"].split(","):
                bit, _, label = item.partition(":")
                bit = bit.strip()
                label = label.strip()
                if not bit or not label:
                    continue
                try:
                    bitmask[int(bit)] = label
                except ValueError:
                    continue

        output[name] = ParamMeta(
            name=name,
            display_name=(param_elem.get("humanName") or "").strip() or fields.get("DisplayName", ""),
            description=(param_elem.get("documentation") or "").strip() or fields.get("Description", ""),
            units=fields.get("Units", "") or child_text(param_elem, "Units"),
            user=(param_elem.get("user") or "").strip() or fields.get("User", ""),
            low=low,
            high=high,
            values=values or None,
            bitmask=bitmask or None,
            reboot_required=fields.get("RebootRequired", "") or child_text(param_elem, "RebootRequired"),
        )

    return output


def load_metadata(
    metadata_url: str,
    version_ref: str,
    metadata_file: str,
    cache_dir: Path,
    cache_enabled: bool = True,
) -> tuple[dict[str, ParamMeta], str]:
    cache_dir.mkdir(parents=True, exist_ok=True)

    if metadata_file:
        path = Path(metadata_file)
        text = read_text_file(path)
        if path.suffix.lower() == ".xml":
            return parse_xml_metadata(text), f"local XML: {path}"
        return parse_json_metadata(text), f"local JSON: {path}"

    resolved_url = resolve_metadata_url(metadata_url, version_ref)
    cache_path = cache_path_for_url(cache_dir, resolved_url)

    try:
        text = download_text(resolved_url)
        if cache_enabled:
            cache_path.write_text(text, encoding="utf-8")
        return parse_json_metadata(text), f"downloaded JSON: {resolved_url}"
    except Exception as json_exc:
        xml_url = resolved_url[:-5] + ".xml" if resolved_url.lower().endswith(".json") else ""
        if xml_url:
            xml_cache_path = cache_path_for_url(cache_dir, xml_url)
            try:
                text = download_text(xml_url)
                if cache_enabled:
                    xml_cache_path.write_text(text, encoding="utf-8")
                return parse_xml_metadata(text), f"downloaded XML fallback: {xml_url}"
            except Exception as xml_exc:
                if cache_enabled and cache_path.exists():
                    text = cache_path.read_text(encoding="utf-8", errors="replace")
                    return parse_json_metadata(text), f"cached JSON: {cache_path} (download failed: {json_exc})"
                if cache_enabled and xml_cache_path.exists():
                    text = xml_cache_path.read_text(encoding="utf-8", errors="replace")
                    return parse_xml_metadata(text), f"cached XML: {xml_cache_path} (download failed: {xml_exc})"
                raise RuntimeError(
                    f"Could not load metadata from {resolved_url!r} or XML fallback {xml_url!r}, and no cache was available. "
                    f"Use a published Copter version such as 4.5.7, stable-4.5.7, or Copter-4.5.7. "
                    f"If this ArduCopter version does not publish metadata, generate apm.pdef.json/xml from that ArduPilot tag/branch and load it as a local metadata file."
                ) from xml_exc

        if cache_enabled and cache_path.exists():
            text = cache_path.read_text(encoding="utf-8", errors="replace")
            return parse_json_metadata(text), f"cached JSON: {cache_path} (download failed: {json_exc})"
        raise RuntimeError(
            f"Could not load metadata from {resolved_url!r} and no cache was available. "
            f"Use a published Copter version such as 4.5.7, stable-4.5.7, or Copter-4.5.7. "
            f"If this ArduCopter version does not publish metadata, generate apm.pdef.json/xml from that ArduPilot tag/branch and load it as a local metadata file."
        ) from json_exc


# --------------------------- comparison helpers ----------------------------- #

def to_decimal(value: str) -> Decimal | None:
    try:
        return Decimal(value)
    except (InvalidOperation, ValueError):
        return None


def values_equal(a: str, b: str) -> bool:
    if a == b:
        return True

    da = to_decimal(a)
    db = to_decimal(b)
    if da is None or db is None:
        return False

    fa = float(da)
    fb = float(db)
    return math.isclose(fa, fb, rel_tol=FLOAT_REL_TOL, abs_tol=FLOAT_ABS_TOL)


def format_range(meta: ParamMeta | None) -> str:
    if meta is None:
        return ""
    if meta.low or meta.high:
        return f"{meta.low} .. {meta.high}".strip()
    return ""


def decode_enum_or_bitmask(raw_value: str, meta: ParamMeta | None) -> str:
    if meta is None:
        return ""

    if meta.values:
        if raw_value in meta.values:
            return meta.values[raw_value]
        dec = to_decimal(raw_value)
        if dec is not None:
            canon = format(dec.normalize(), "f").rstrip("0").rstrip(".")
            candidates = {raw_value, canon}
            if dec == dec.to_integral():
                candidates.add(str(int(dec)))
            for candidate in candidates:
                if candidate in meta.values:
                    return meta.values[candidate]

    if meta.bitmask:
        dec = to_decimal(raw_value)
        if dec is None:
            return ""
        try:
            mask_value = int(dec)
        except Exception:
            return ""

        bits = [label for bit, label in sorted(meta.bitmask.items()) if mask_value & (1 << bit)]
        if bits:
            return " | ".join(bits)
        if mask_value == 0 and 0 in meta.bitmask:
            return meta.bitmask[0]

    return ""


def range_note(raw_value: str, meta: ParamMeta | None) -> str:
    if meta is None or not (meta.low or meta.high):
        return ""

    value = to_decimal(raw_value)
    low = to_decimal(meta.low) if meta.low else None
    high = to_decimal(meta.high) if meta.high else None
    if value is None:
        return ""

    notes: list[str] = []
    if low is not None and value < low:
        notes.append("below documented range")
    if high is not None and value > high:
        notes.append("above documented range")
    return "; ".join(notes)


def build_rows(
    old_params: dict[str, str],
    new_params: dict[str, str],
    metadata: dict[str, ParamMeta],
    show_only_differences: bool,
    ignore_params: set[str],
) -> list[DiffRow]:
    all_names = sorted(set(old_params) | set(new_params))
    rows: list[DiffRow] = []

    for name in all_names:
        if name in ignore_params:
            continue

        old_value = old_params.get(name, "")
        new_value = new_params.get(name, "")
        meta = metadata.get(name)

        if name not in old_params:
            status = "added"
        elif name not in new_params:
            status = "removed"
        elif values_equal(old_value, new_value):
            status = "same"
        else:
            status = "changed"

        if show_only_differences and status == "same":
            continue

        notes = "; ".join(
            note
            for note in [range_note(old_value, meta), range_note(new_value, meta), meta.reboot_required if meta else ""]
            if note
        )

        rows.append(
            DiffRow(
                status=status,
                name=name,
                old_value=old_value,
                new_value=new_value,
                display_name=meta.display_name if meta else "",
                units=meta.units if meta else "",
                allowed_range=format_range(meta),
                old_decoded=decode_enum_or_bitmask(old_value, meta),
                new_decoded=decode_enum_or_bitmask(new_value, meta),
                description=meta.description if meta else "",
                notes=notes,
            )
        )

    return rows


def sort_rows(rows: list[DiffRow], sort_by: str) -> list[DiffRow]:
    if sort_by == "status":
        return sorted(rows, key=lambda r: (STATUS_ORDER.get(r.status, 99), r.name))
    return sorted(rows, key=lambda r: r.name)


def status_counts(rows: list[DiffRow]) -> dict[str, int]:
    counts = {"changed": 0, "added": 0, "removed": 0, "same": 0}
    for row in rows:
        counts[row.status] = counts.get(row.status, 0) + 1
    return counts


# ------------------------------ report export ------------------------------- #

def esc(text: str) -> str:
    return html.escape(text or "")


def write_csv(path: Path, rows: list[DiffRow]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "status",
                "name",
                "old_value",
                "new_value",
                "display_name",
                "units",
                "allowed_range",
                "old_decoded",
                "new_decoded",
                "description",
                "notes",
            ]
        )
        for row in rows:
            writer.writerow(
                [
                    row.status,
                    row.name,
                    row.old_value,
                    row.new_value,
                    row.display_name,
                    row.units,
                    row.allowed_range,
                    row.old_decoded,
                    row.new_decoded,
                    row.description,
                    row.notes,
                ]
            )


def write_html(
    path: Path,
    rows: list[DiffRow],
    old_file: Path,
    new_file: Path,
    metadata_source: str,
    metadata_count: int,
) -> None:
    counts = status_counts(rows)
    table_rows: list[str] = []

    for row in rows:
        cls = f"row-{row.status}"
        table_rows.append(
            "<tr class='{cls}'>"
            "<td>{status}</td>"
            "<td><code>{name}</code></td>"
            "<td>{old_value}</td>"
            "<td>{new_value}</td>"
            "<td>{old_decoded}</td>"
            "<td>{new_decoded}</td>"
            "<td>{display_name}</td>"
            "<td>{units}</td>"
            "<td>{allowed_range}</td>"
            "<td>{description}</td>"
            "<td>{notes}</td>"
            "</tr>".format(
                cls=cls,
                status=esc(row.status),
                name=esc(row.name),
                old_value=esc(row.old_value),
                new_value=esc(row.new_value),
                old_decoded=esc(row.old_decoded),
                new_decoded=esc(row.new_decoded),
                display_name=esc(row.display_name),
                units=esc(row.units),
                allowed_range=esc(row.allowed_range),
                description=esc(row.description),
                notes=esc(row.notes),
            )
        )

    html_text = f"""<!doctype html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<title>ArduPilot Parameter Diff</title>
<style>
    body {{ font-family: Arial, sans-serif; margin: 24px; color: #222; }}
    h1 {{ margin-bottom: 0.2rem; }}
    .meta {{ color: #555; margin-bottom: 1rem; }}
    .summary {{ display: flex; gap: 12px; flex-wrap: wrap; margin: 1rem 0 1.5rem; }}
    .card {{ border: 1px solid #ddd; border-radius: 10px; padding: 12px 16px; min-width: 120px; }}
    .card .label {{ color: #666; font-size: 0.9rem; }}
    .card .value {{ font-size: 1.6rem; font-weight: 700; }}
    .controls {{ margin: 1rem 0; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }}
    input[type=\"search\"] {{ padding: 8px 10px; min-width: 280px; }}
    table {{ border-collapse: collapse; width: 100%; table-layout: fixed; }}
    th, td {{ border: 1px solid #ddd; padding: 8px; vertical-align: top; word-wrap: break-word; }}
    th {{ position: sticky; top: 0; background: #f7f7f7; z-index: 1; }}
    .row-changed {{ background: #fff8d6; }}
    .row-added {{ background: #e8faec; }}
    .row-removed {{ background: #fdeaea; }}
    .row-same {{ background: #f7f7f7; }}
    code {{ background: #f3f3f3; padding: 1px 4px; border-radius: 4px; }}
</style>
</head>
<body>
    <h1>ArduPilot Parameter Diff</h1>
    <div class=\"meta\"><strong>Old file:</strong> {esc(str(old_file))}<br>
    <strong>New file:</strong> {esc(str(new_file))}<br>
    <strong>Metadata source:</strong> {esc(metadata_source)}<br>
    <strong>Metadata entries loaded:</strong> {metadata_count}</div>

    <div class=\"summary\">
        <div class=\"card\"><div class=\"label\">Changed</div><div class=\"value\">{counts['changed']}</div></div>
        <div class=\"card\"><div class=\"label\">Added</div><div class=\"value\">{counts['added']}</div></div>
        <div class=\"card\"><div class=\"label\">Removed</div><div class=\"value\">{counts['removed']}</div></div>
        <div class=\"card\"><div class=\"label\">Shown rows</div><div class=\"value\">{len(rows)}</div></div>
    </div>

    <div class=\"controls\">
        <label>Search <input id=\"searchBox\" type=\"search\" placeholder=\"Search parameter name, description, values...\"></label>
        <label><input type=\"checkbox\" class=\"statusFilter\" value=\"changed\" checked> Changed</label>
        <label><input type=\"checkbox\" class=\"statusFilter\" value=\"added\" checked> Added</label>
        <label><input type=\"checkbox\" class=\"statusFilter\" value=\"removed\" checked> Removed</label>
        <label><input type=\"checkbox\" class=\"statusFilter\" value=\"same\" checked> Same</label>
    </div>

    <table id=\"diffTable\">
        <thead>
            <tr>
                <th style=\"width: 90px;\">Status</th>
                <th style=\"width: 150px;\">Parameter</th>
                <th style=\"width: 110px;\">Old value</th>
                <th style=\"width: 110px;\">New value</th>
                <th style=\"width: 180px;\">Old decoded</th>
                <th style=\"width: 180px;\">New decoded</th>
                <th style=\"width: 180px;\">Display name</th>
                <th style=\"width: 70px;\">Units</th>
                <th style=\"width: 120px;\">Range</th>
                <th>Description</th>
                <th style=\"width: 180px;\">Notes</th>
            </tr>
        </thead>
        <tbody>
            {''.join(table_rows)}
        </tbody>
    </table>
<script>
const searchBox = document.getElementById('searchBox');
const filters = Array.from(document.querySelectorAll('.statusFilter'));
const rows = Array.from(document.querySelectorAll('#diffTable tbody tr'));
function applyFilters() {{
    const query = searchBox.value.toLowerCase().trim();
    const enabled = new Set(filters.filter(f => f.checked).map(f => f.value));
    for (const row of rows) {{
        const status = row.children[0].innerText.trim().toLowerCase();
        const text = row.innerText.toLowerCase();
        const statusOk = enabled.has(status);
        const textOk = !query || text.includes(query);
        row.style.display = statusOk && textOk ? '' : 'none';
    }}
}}
searchBox.addEventListener('input', applyFilters);
for (const f of filters) {{ f.addEventListener('change', applyFilters); }}
</script>
</body>
</html>
"""
    path.write_text(html_text, encoding="utf-8")


# ---------------------------------- UI -------------------------------------- #
class App:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(WINDOW_TITLE)
        self.root.geometry(WINDOW_SIZE)
        self.root.minsize(1200, 760)

        self.work_queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.all_rows: list[DiffRow] = []
        self.filtered_rows: list[DiffRow] = []
        self.metadata: dict[str, ParamMeta] = {}
        self.metadata_source = ""
        self.old_file_path = ""
        self.new_file_path = ""
        self.row_lookup: dict[str, DiffRow] = {}
        self.hovered_item_id = ""
        self.tooltip_window: tk.Toplevel | None = None
        self.tooltip_label: tk.Label | None = None

        self._configure_style()
        self._build_variables()
        self._build_layout()
        self._poll_worker_queue()

    def _configure_style(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Accent.TButton", font=("Segoe UI", 10, "bold"))
        style.configure("Summary.TLabelframe", padding=10)
        style.configure("Detail.TLabelframe", padding=8)
        style.configure("Treeview", rowheight=24)

    def _build_variables(self) -> None:
        self.old_file_var = tk.StringVar()
        self.new_file_var = tk.StringVar()
        self.metadata_file_var = tk.StringVar()
        self.version_ref_var = tk.StringVar(value=DEFAULT_VERSION_REF)
        self.metadata_url_var = tk.StringVar(value=DEFAULT_METADATA_URL)
        self.cache_dir_var = tk.StringVar(value=DEFAULT_CACHE_DIR)
        self.output_html_var = tk.StringVar(value=DEFAULT_OUTPUT_HTML)
        self.output_csv_var = tk.StringVar(value=DEFAULT_OUTPUT_CSV)
        self.search_var = tk.StringVar()
        self.ignore_var = tk.StringVar()
        self.sort_by_var = tk.StringVar(value=DEFAULT_SORT_BY)
        self.show_same_var = tk.BooleanVar(value=DEFAULT_SHOW_UNCHANGED)
        self.open_html_var = tk.BooleanVar(value=DEFAULT_OPEN_HTML_WHEN_EXPORTED)
        self.status_var = tk.StringVar(value="Choose the two parameter files, then click Compare.")
        self.metadata_status_var = tk.StringVar(value="Metadata: not loaded yet")

        self.filter_changed_var = tk.BooleanVar(value=True)
        self.filter_added_var = tk.BooleanVar(value=True)
        self.filter_removed_var = tk.BooleanVar(value=True)
        self.filter_same_var = tk.BooleanVar(value=True)

        self.summary_changed_var = tk.StringVar(value="0")
        self.summary_added_var = tk.StringVar(value="0")
        self.summary_removed_var = tk.StringVar(value="0")
        self.summary_same_var = tk.StringVar(value="0")
        self.summary_shown_var = tk.StringVar(value="0")

    def _build_layout(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(2, weight=1)

        top = ttk.Frame(self.root, padding=10)
        top.grid(row=0, column=0, sticky="nsew")
        top.columnconfigure(1, weight=1)

        self._add_file_row(top, 0, "Old parameter file", self.old_file_var, self._browse_old_file)
        self._add_file_row(top, 1, "New parameter file", self.new_file_var, self._browse_new_file)
        self._add_file_row(top, 2, "Optional metadata file", self.metadata_file_var, self._browse_metadata_file)

        ttk.Label(top, text="ArduCopter version/ref").grid(row=3, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(top, textvariable=self.version_ref_var).grid(row=3, column=1, sticky="ew", pady=4)
        ttk.Button(top, text="Latest", command=self._use_latest_metadata).grid(row=3, column=2, padx=(8, 0), pady=4)

        ttk.Label(top, text="Metadata URL").grid(row=4, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(top, textvariable=self.metadata_url_var).grid(row=4, column=1, sticky="ew", pady=4)
        ttk.Button(top, text="Reset URL", command=self._reset_metadata_url).grid(row=4, column=2, padx=(8, 0), pady=4)

        ttk.Label(top, text="Cache directory").grid(row=5, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(top, textvariable=self.cache_dir_var).grid(row=5, column=1, sticky="ew", pady=4)
        ttk.Button(top, text="Browse", command=self._browse_cache_dir).grid(row=5, column=2, padx=(8, 0), pady=4)

        options = ttk.Frame(top)
        options.grid(row=6, column=0, columnspan=3, sticky="ew", pady=(10, 0))
        options.columnconfigure(1, weight=1)
        options.columnconfigure(3, weight=1)

        ttk.Label(options, text="Ignore params").grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Entry(options, textvariable=self.ignore_var).grid(row=0, column=1, sticky="ew", padx=(0, 16))
        ttk.Label(options, text="Sort by").grid(row=0, column=2, sticky="w", padx=(0, 8))
        ttk.Combobox(options, textvariable=self.sort_by_var, values=["name", "status"], width=10, state="readonly").grid(row=0, column=3, sticky="w")
        ttk.Checkbutton(options, text="Include unchanged", variable=self.show_same_var, command=self._apply_filters).grid(row=0, column=4, padx=(16, 8))
        ttk.Button(options, text="Compare", style="Accent.TButton", command=self._start_compare).grid(row=0, column=5)

        summary = ttk.LabelFrame(self.root, text="Summary", style="Summary.TLabelframe", padding=10)
        summary.grid(row=1, column=0, sticky="ew", padx=10, pady=(0, 10))
        for i in range(10):
            summary.columnconfigure(i, weight=1)

        self._make_summary_cell(summary, 0, "Changed", self.summary_changed_var)
        self._make_summary_cell(summary, 2, "Added", self.summary_added_var)
        self._make_summary_cell(summary, 4, "Removed", self.summary_removed_var)
        self._make_summary_cell(summary, 6, "Same", self.summary_same_var)
        self._make_summary_cell(summary, 8, "Shown", self.summary_shown_var)

        middle = ttk.Panedwindow(self.root, orient=tk.VERTICAL)
        middle.grid(row=2, column=0, sticky="nsew", padx=10, pady=(0, 10))

        upper = ttk.Frame(middle)
        lower = ttk.Frame(middle)
        upper.columnconfigure(0, weight=1)
        upper.rowconfigure(1, weight=1)
        lower.columnconfigure(0, weight=1)
        lower.rowconfigure(1, weight=1)
        middle.add(upper, weight=4)
        middle.add(lower, weight=2)

        controls = ttk.Frame(upper)
        controls.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        controls.columnconfigure(1, weight=1)

        ttk.Label(controls, text="Search").grid(row=0, column=0, padx=(0, 8))
        search_entry = ttk.Entry(controls, textvariable=self.search_var)
        search_entry.grid(row=0, column=1, sticky="ew")
        search_entry.bind("<KeyRelease>", lambda _event: self._apply_filters())

        ttk.Checkbutton(controls, text="Changed", variable=self.filter_changed_var, command=self._apply_filters).grid(row=0, column=2, padx=(12, 0))
        ttk.Checkbutton(controls, text="Added", variable=self.filter_added_var, command=self._apply_filters).grid(row=0, column=3)
        ttk.Checkbutton(controls, text="Removed", variable=self.filter_removed_var, command=self._apply_filters).grid(row=0, column=4)
        ttk.Checkbutton(controls, text="Same", variable=self.filter_same_var, command=self._apply_filters).grid(row=0, column=5)
        ttk.Button(controls, text="Export HTML", command=self._export_html).grid(row=0, column=6, padx=(16, 6))
        ttk.Button(controls, text="Export CSV", command=self._export_csv).grid(row=0, column=7)

        table_frame = ttk.Frame(upper)
        table_frame.grid(row=1, column=0, sticky="nsew")
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)

        columns = (
            "status",
            "name",
            "old_value",
            "new_value",
            "old_decoded",
            "new_decoded",
            "display_name",
            "units",
            "allowed_range",
            "notes",
        )
        self.tree = ttk.Treeview(table_frame, columns=columns, show="headings", selectmode="browse")
        self.tree.grid(row=0, column=0, sticky="nsew")
        self.tree.bind("<<TreeviewSelect>>", self._on_tree_select)
        self.tree.bind("<Motion>", self._on_tree_hover)
        self.tree.bind("<Leave>", self._hide_tree_tooltip)
        self.tree.bind("<ButtonPress-1>", self._hide_tree_tooltip)
        self.tree.bind("<MouseWheel>", self._hide_tree_tooltip)

        y_scroll = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self.tree.yview)
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll = ttk.Scrollbar(table_frame, orient=tk.HORIZONTAL, command=self.tree.xview)
        x_scroll.grid(row=1, column=0, sticky="ew")
        self.tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)

        headers = {
            "status": ("Status", 85),
            "name": ("Parameter", 170),
            "old_value": ("Old value", 90),
            "new_value": ("New value", 90),
            "old_decoded": ("Old decoded", 200),
            "new_decoded": ("New decoded", 200),
            "display_name": ("Display name", 180),
            "units": ("Units", 70),
            "allowed_range": ("Range", 110),
            "notes": ("Notes", 240),
        }
        for key, (title, width) in headers.items():
            self.tree.heading(key, text=title)
            self.tree.column(key, width=width, stretch=True, anchor="w")

        self.tree.tag_configure("changed", background="#fff4c9")
        self.tree.tag_configure("added", background="#eaf9ee")
        self.tree.tag_configure("removed", background="#fdeaea")
        self.tree.tag_configure("same", background="#f4f4f4")

        detail_top = ttk.Frame(lower)
        detail_top.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        detail_top.columnconfigure(1, weight=1)
        ttk.Label(detail_top, text="Metadata source").grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Label(detail_top, textvariable=self.metadata_status_var).grid(row=0, column=1, sticky="w")

        details = ttk.LabelFrame(lower, text="Selected parameter", style="Detail.TLabelframe")
        details.grid(row=1, column=0, sticky="nsew")
        details.columnconfigure(1, weight=1)
        details.rowconfigure(7, weight=1)

        self.detail_vars = {
            "name": tk.StringVar(),
            "status": tk.StringVar(),
            "old_value": tk.StringVar(),
            "new_value": tk.StringVar(),
            "display_name": tk.StringVar(),
            "units": tk.StringVar(),
            "range": tk.StringVar(),
            "decoded": tk.StringVar(),
            "notes": tk.StringVar(),
        }

        row_idx = 0
        for label, key in [
            ("Parameter", "name"),
            ("Status", "status"),
            ("Old value", "old_value"),
            ("New value", "new_value"),
            ("Display name", "display_name"),
            ("Units", "units"),
            ("Documented range", "range"),
            ("Decoded", "decoded"),
            ("Notes", "notes"),
        ]:
            ttk.Label(details, text=label).grid(row=row_idx, column=0, sticky="nw", padx=(0, 8), pady=2)
            ttk.Label(details, textvariable=self.detail_vars[key], wraplength=1050, justify="left").grid(row=row_idx, column=1, sticky="nw", pady=2)
            row_idx += 1

        ttk.Label(details, text="Description").grid(row=row_idx, column=0, sticky="nw", padx=(0, 8), pady=(8, 2))
        self.description_text = tk.Text(details, height=8, wrap="word")
        self.description_text.grid(row=row_idx, column=1, sticky="nsew", pady=(8, 2))
        self.description_text.configure(state="disabled")

        status_bar = ttk.Frame(self.root, padding=(10, 0, 10, 10))
        status_bar.grid(row=3, column=0, sticky="ew")
        status_bar.columnconfigure(0, weight=1)
        ttk.Label(status_bar, textvariable=self.status_var).grid(row=0, column=0, sticky="w")

    def _add_file_row(self, parent: ttk.Frame, row: int, label: str, variable: tk.StringVar, browse_command) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(parent, textvariable=variable).grid(row=row, column=1, sticky="ew", pady=4)
        ttk.Button(parent, text="Browse", command=browse_command).grid(row=row, column=2, padx=(8, 0), pady=4)

    def _make_summary_cell(self, parent: ttk.LabelFrame, column: int, label: str, value_var: tk.StringVar) -> None:
        box = ttk.Frame(parent)
        box.grid(row=0, column=column, sticky="ew", padx=6)
        ttk.Label(box, text=label).grid(row=0, column=0)
        ttk.Label(box, textvariable=value_var, font=("Segoe UI", 18, "bold")).grid(row=1, column=0)

    def _browse_old_file(self) -> None:
        path = filedialog.askopenfilename(title="Select old parameter file")
        if path:
            self.old_file_var.set(path)

    def _browse_new_file(self) -> None:
        path = filedialog.askopenfilename(title="Select new parameter file")
        if path:
            self.new_file_var.set(path)

    def _browse_metadata_file(self) -> None:
        path = filedialog.askopenfilename(
            title="Select optional metadata file",
            filetypes=[("Parameter metadata", "*.json *.xml"), ("All files", "*.*")],
        )
        if path:
            self.metadata_file_var.set(path)

    def _browse_cache_dir(self) -> None:
        path = filedialog.askdirectory(title="Select cache directory")
        if path:
            self.cache_dir_var.set(path)

    def _reset_metadata_url(self) -> None:
        self.metadata_url_var.set(DEFAULT_METADATA_URL)

    def _use_latest_metadata(self) -> None:
        self.version_ref_var.set(DEFAULT_VERSION_REF)
        self.metadata_url_var.set(DEFAULT_METADATA_URL)

    def _set_busy(self, busy: bool, message: str | None = None) -> None:
        self.root.config(cursor="watch" if busy else "")
        if message:
            self.status_var.set(message)

    def _start_compare(self) -> None:
        old_path = self.old_file_var.get().strip()
        new_path = self.new_file_var.get().strip()
        if not old_path or not new_path:
            messagebox.showerror("Missing files", "Select both the old and new parameter files.")
            return

        ignore_params = {
            item.strip()
            for item in re.split(r"[,;\s]+", self.ignore_var.get().strip())
            if item.strip()
        }
        show_only_differences = not self.show_same_var.get()
        sort_by = self.sort_by_var.get().strip() or DEFAULT_SORT_BY

        payload = {
            "old_file": old_path,
            "new_file": new_path,
            "metadata_file": self.metadata_file_var.get().strip(),
            "version_ref": self.version_ref_var.get().strip(),
            "metadata_url": self.metadata_url_var.get().strip() or DEFAULT_METADATA_URL,
            "cache_dir": self.cache_dir_var.get().strip() or DEFAULT_CACHE_DIR,
            "ignore_params": ignore_params,
            "show_only_differences": show_only_differences,
            "sort_by": sort_by,
        }

        self._set_busy(True, "Comparing parameter files and loading metadata...")
        thread = threading.Thread(target=self._compare_worker, args=(payload,), daemon=True)
        thread.start()

    def _compare_worker(self, payload: dict[str, Any]) -> None:
        try:
            old_file = Path(payload["old_file"])
            new_file = Path(payload["new_file"])
            old_params = parse_param_file(old_file)
            new_params = parse_param_file(new_file)
            metadata, metadata_source = load_metadata(
                metadata_url=payload["metadata_url"],
                version_ref=payload["version_ref"],
                metadata_file=payload["metadata_file"],
                cache_dir=Path(payload["cache_dir"]),
                cache_enabled=True,
            )
            rows = build_rows(
                old_params=old_params,
                new_params=new_params,
                metadata=metadata,
                show_only_differences=payload["show_only_differences"],
                ignore_params=payload["ignore_params"],
            )
            rows = sort_rows(rows, payload["sort_by"])
            self.work_queue.put(
                (
                    "success",
                    {
                        "rows": rows,
                        "metadata": metadata,
                        "metadata_source": metadata_source,
                        "old_file": str(old_file),
                        "new_file": str(new_file),
                    },
                )
            )
        except Exception as exc:
            self.work_queue.put(("error", {"message": str(exc), "traceback": traceback.format_exc()}))

    def _poll_worker_queue(self) -> None:
        try:
            while True:
                event_type, payload = self.work_queue.get_nowait()
                if event_type == "success":
                    self._finish_compare(payload)
                elif event_type == "error":
                    self._set_busy(False, "Comparison failed.")
                    messagebox.showerror("Comparison failed", f"{payload['message']}\n\n{payload['traceback']}")
        except queue.Empty:
            pass
        self.root.after(150, self._poll_worker_queue)

    def _finish_compare(self, payload: dict[str, Any]) -> None:
        self.all_rows = payload["rows"]
        self.metadata = payload["metadata"]
        self.metadata_source = payload["metadata_source"]
        self.old_file_path = payload["old_file"]
        self.new_file_path = payload["new_file"]
        self.metadata_status_var.set(f"{self.metadata_source} | {len(self.metadata)} metadata entries loaded")

        counts = status_counts(self.all_rows)
        self.summary_changed_var.set(str(counts["changed"]))
        self.summary_added_var.set(str(counts["added"]))
        self.summary_removed_var.set(str(counts["removed"]))
        self.summary_same_var.set(str(counts["same"]))
        self._apply_filters()
        self._set_busy(False, f"Comparison complete. Loaded {len(self.all_rows)} rows.")

    def _apply_filters(self) -> None:
        enabled_statuses = set()
        if self.filter_changed_var.get():
            enabled_statuses.add("changed")
        if self.filter_added_var.get():
            enabled_statuses.add("added")
        if self.filter_removed_var.get():
            enabled_statuses.add("removed")
        if self.filter_same_var.get() and self.show_same_var.get():
            enabled_statuses.add("same")

        query = self.search_var.get().strip().lower()
        self.filtered_rows = []
        self.row_lookup = {}
        self._hide_tree_tooltip()

        self.tree.delete(*self.tree.get_children())
        for index, row in enumerate(self.all_rows):
            if row.status not in enabled_statuses:
                continue
            haystack = " ".join(
                [
                    row.status,
                    row.name,
                    row.old_value,
                    row.new_value,
                    row.old_decoded,
                    row.new_decoded,
                    row.display_name,
                    row.units,
                    row.allowed_range,
                    row.description,
                    row.notes,
                ]
            ).lower()
            if query and query not in haystack:
                continue

            self.filtered_rows.append(row)
            item_id = str(index)
            self.row_lookup[item_id] = row
            self.tree.insert(
                "",
                "end",
                iid=item_id,
                values=(
                    row.status,
                    row.name,
                    row.old_value,
                    row.new_value,
                    row.old_decoded,
                    row.new_decoded,
                    row.display_name,
                    row.units,
                    row.allowed_range,
                    row.notes,
                ),
                tags=(row.status,),
            )

        self.summary_shown_var.set(str(len(self.filtered_rows)))
        self._clear_details()

    def _clear_details(self) -> None:
        for variable in self.detail_vars.values():
            variable.set("")
        self.description_text.configure(state="normal")
        self.description_text.delete("1.0", tk.END)
        self.description_text.configure(state="disabled")

    def _ensure_tree_tooltip(self) -> None:
        if self.tooltip_window is not None:
            return
        self.tooltip_window = tk.Toplevel(self.root)
        self.tooltip_window.withdraw()
        self.tooltip_window.overrideredirect(True)
        self.tooltip_window.attributes("-topmost", True)
        self.tooltip_label = tk.Label(
            self.tooltip_window,
            text="",
            justify="left",
            wraplength=520,
            relief="solid",
            borderwidth=1,
            bg="#fffde8",
            padx=8,
            pady=8,
        )
        self.tooltip_label.pack()

    def _show_tree_tooltip(self, text: str, x_root: int, y_root: int) -> None:
        if not text.strip():
            self._hide_tree_tooltip()
            return
        self._ensure_tree_tooltip()
        if self.tooltip_window is None or self.tooltip_label is None:
            return
        self.tooltip_label.configure(text=text)
        self.tooltip_window.geometry(f"+{x_root + 16}+{y_root + 16}")
        self.tooltip_window.deiconify()

    def _hide_tree_tooltip(self, _event: Any = None) -> None:
        self.hovered_item_id = ""
        if self.tooltip_window is not None:
            self.tooltip_window.withdraw()

    def _on_tree_hover(self, event: tk.Event) -> None:
        item_id = self.tree.identify_row(event.y)
        if not item_id:
            self._hide_tree_tooltip()
            return

        row = self.row_lookup.get(item_id)
        if row is None:
            self._hide_tree_tooltip()
            return

        tooltip_text = row.description.strip() or f"{row.name}: no description available."
        if item_id != self.hovered_item_id:
            self.hovered_item_id = item_id
            self._show_tree_tooltip(tooltip_text, event.x_root, event.y_root)
            return

        if self.tooltip_window is not None and str(self.tooltip_window.state()) != "withdrawn":
            self.tooltip_window.geometry(f"+{event.x_root + 16}+{event.y_root + 16}")
        else:
            self._show_tree_tooltip(tooltip_text, event.x_root, event.y_root)

    def _on_tree_select(self, _event: Any = None) -> None:
        selection = self.tree.selection()
        if not selection:
            return
        row = self.row_lookup.get(selection[0])
        if row is None:
            return

        self.detail_vars["name"].set(row.name)
        self.detail_vars["status"].set(row.status)
        self.detail_vars["old_value"].set(row.old_value)
        self.detail_vars["new_value"].set(row.new_value)
        self.detail_vars["display_name"].set(row.display_name)
        self.detail_vars["units"].set(row.units)
        self.detail_vars["range"].set(row.allowed_range)
        decoded = []
        if row.old_decoded:
            decoded.append(f"Old: {row.old_decoded}")
        if row.new_decoded:
            decoded.append(f"New: {row.new_decoded}")
        self.detail_vars["decoded"].set(" | ".join(decoded))
        self.detail_vars["notes"].set(row.notes)

        self.description_text.configure(state="normal")
        self.description_text.delete("1.0", tk.END)
        self.description_text.insert("1.0", row.description)
        self.description_text.configure(state="disabled")

    def _default_export_stem(self) -> str:
        old_stem = Path(self.old_file_path).stem if self.old_file_path else "old"
        new_stem = Path(self.new_file_path).stem if self.new_file_path else "new"
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"arducopter_param_diff_{old_stem}_vs_{new_stem}_{timestamp}"

    def _export_html(self) -> None:
        if not self.filtered_rows:
            messagebox.showerror("Nothing to export", "Run a comparison first, and make sure at least one row is visible.")
            return

        initial = self.output_html_var.get().strip() or f"{self._default_export_stem()}.html"
        path = filedialog.asksaveasfilename(
            title="Export HTML report",
            defaultextension=".html",
            initialfile=initial,
            filetypes=[("HTML files", "*.html"), ("All files", "*.*")],
        )
        if not path:
            return

        output_path = Path(path)
        write_html(
            output_path,
            self.filtered_rows,
            Path(self.old_file_path),
            Path(self.new_file_path),
            self.metadata_source,
            len(self.metadata),
        )
        self.status_var.set(f"HTML report written to {output_path}")
        if self.open_html_var.get():
            import webbrowser
            webbrowser.open(output_path.resolve().as_uri())

    def _export_csv(self) -> None:
        if not self.filtered_rows:
            messagebox.showerror("Nothing to export", "Run a comparison first, and make sure at least one row is visible.")
            return

        initial = self.output_csv_var.get().strip() or f"{self._default_export_stem()}.csv"
        path = filedialog.asksaveasfilename(
            title="Export CSV",
            defaultextension=".csv",
            initialfile=initial,
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        if not path:
            return

        output_path = Path(path)
        write_csv(output_path, self.filtered_rows)
        self.status_var.set(f"CSV export written to {output_path}")


def main() -> int:
    root = tk.Tk()
    app = App(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
