"""
compare_schedules.py

Purpose:
- Compare system-generated schedule vs Vedanjay manual schedule.
- Output:
  1) Comparison CSV
  2) Plotly HTML graph

Supported usage:
1) Direct paths:
   python compare_schedules.py --system "<system_file_or_dir>" --vedanjay "<vedanjay_file_or_dir>" --out "<out_dir>"

2) Hierarchy mode:
   python compare_schedules.py --root "<comparisions_root>" --plant GSNP --date 2026-03-12
   Expects:
     <root>/<plant>/<date>/System/
     <root>/<plant>/<date>/vedanjay/
   Writes:
     <root>/<plant>/<date>/compared/
"""

import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime
from typing import Dict, List, Optional, Tuple

TOTAL_BLOCKS = 96
DEFAULT_PLANT_CAPACITY_MW = 5.0
DEFAULT_PENALTY_BAND_PCT = 0.10

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from utils.site_config_loader import load_site_config

# --------------------------------------------------------------------
# Editable defaults (optional): update these paths for quick local runs.
# Priority order used by script:
#   1) CLI args (--system/--vedanjay/--out/--date)
#   2) Defaults below (if set)
#   3) Hierarchy mode via --root + --plant + --date
# --------------------------------------------------------------------
DEFAULT_SYSTEM_PATH = ""
DEFAULT_VEDANJAY_PATH = ""
DEFAULT_OUT_DIR = ""
DEFAULT_DATE_LABEL = "2026-03-13"
DEFAULT_ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PLANT = "KILAJ"
COMPARISON_CONFIG_DIR = os.path.join(DEFAULT_ROOT, "config", "sites")


def resolve_default_path(path_value: str) -> str:
    if not path_value:
        return ""
    if os.path.isabs(path_value):
        return path_value
    normalized = os.path.normpath(path_value)
    prefix = f"comparisions{os.sep}"
    if normalized.lower().startswith(prefix):
        base_dir = os.path.dirname(DEFAULT_ROOT)  # global2/
        return os.path.join(base_dir, normalized)
    return os.path.join(DEFAULT_ROOT, normalized)


def build_time(block: int) -> str:
    idx = max(0, block - 1)
    hh = (idx * 15) // 60
    mm = (idx * 15) % 60
    return f"{hh:02d}:{mm:02d}"


def parse_block_number(raw: str) -> Optional[int]:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        return int(text)
    except Exception:
        pass

    for pattern in [r"[bB]\s*([0-9]{1,3})", r"([0-9]{1,3})"]:
        m = re.search(pattern, text)
        if m:
            try:
                return int(m.group(1))
            except Exception:
                return None
    return None


def to_header_key(v: str) -> str:
    return (
        str(v or "")
        .lower()
        .replace('"', "")
        .replace("'", "")
        .replace(" ", "")
        .replace("_", "")
        .replace("-", "")
    )


def detect_csv_header(lines: List[str]) -> Tuple[int, str]:
    delimiter_candidates = [",", ";", "\t"]

    def score(line: str) -> int:
        lowered = line.lower()
        if not any(d in lowered for d in delimiter_candidates):
            return -1
        s = 0
        if "block" in lowered or "blk" in lowered:
            s += 5
        if "time" in lowered or "timestamp" in lowered or "date" in lowered:
            s += 4
        if "forecast" in lowered or "intraday" in lowered or "dayahead" in lowered:
            s += 6
        if "mw" in lowered or "kw" in lowered or "power" in lowered or "generation" in lowered:
            s += 2
        return s

    scan_limit = min(len(lines), 25)
    best_idx = 0
    best_score = -1
    for i in range(scan_limit):
        sc = score(lines[i])
        if sc > best_score:
            best_score = sc
            best_idx = i

    header_sample = lines[best_idx] if lines else ""
    best_delim = ","
    best_count = -1
    for d in delimiter_candidates:
        c = header_sample.count(d)
        if c > best_count:
            best_delim = d
            best_count = c

    return best_idx, best_delim


def parse_csv_with_header_detection(text: str) -> Tuple[List[str], List[List[str]]]:
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return [], []
    header_idx, delim = detect_csv_header(lines)

    def parse_line(line: str) -> List[str]:
        cells = []
        cur = ""
        in_quotes = False
        i = 0
        while i < len(line):
            ch = line[i]
            if ch == '"':
                if in_quotes and i + 1 < len(line) and line[i + 1] == '"':
                    cur += '"'
                    i += 1
                else:
                    in_quotes = not in_quotes
            elif ch == delim and not in_quotes:
                cells.append(cur.strip())
                cur = ""
            else:
                cur += ch
            i += 1
        cells.append(cur.strip())
        return cells

    header1 = parse_line(lines[header_idx])
    header2 = parse_line(lines[header_idx + 1]) if header_idx + 1 < len(lines) else []
    use_second = any(("forecast" in h.lower() or "availability" in h.lower()) for h in header2)

    max_cols = max(len(header1), len(header2))
    headers = []
    for i in range(max_cols):
        h1 = header1[i] if i < len(header1) else ""
        h2 = header2[i] if i < len(header2) else ""
        headers.append((f"{h1} {h2}".strip()) if (h1 and h2 and use_second) else (h1 or h2))

    data_start = header_idx + (2 if use_second else 1)
    rows = [parse_line(line) for line in lines[data_start:]]
    return headers, rows


def parse_csv_simple(text: str) -> Tuple[List[str], List[List[str]]]:
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return [], []
    header = lines[0]
    delim = ","
    if header.count(";") > header.count(",") and header.count(";") >= header.count("\t"):
        delim = ";"
    elif header.count("\t") > header.count(",") and header.count("\t") > header.count(";"):
        delim = "\t"
    reader = csv.reader(lines, delimiter=delim)
    rows = list(reader)
    headers = [h.replace("\ufeff", "").strip() for h in rows[0]]
    return headers, rows[1:]


def normalize_to_mw(values: List[float], header_key: str) -> float:
    explicit_kw = "kw" in header_key and "mw" not in header_key
    explicit_mw = "mw" in header_key
    explicit_w = ((header_key.endswith("w") and not explicit_mw and not explicit_kw) or "(w)" in header_key)

    non_zero = [abs(v) for v in values if v and abs(v) > 0]
    avg = sum(non_zero) / len(non_zero) if non_zero else 0
    assume_kw = explicit_kw or (not explicit_mw and not explicit_w and avg > 200)

    if explicit_w:
        return 1 / 1_000_000
    if assume_kw:
        return 1 / 1000
    return 1


def _normalize_penalty_band_fraction(raw_pct: float) -> float:
    return raw_pct / 100.0 if raw_pct > 1.0 else raw_pct


def _resolve_band_mw(site_id: str) -> float:
    try:
        cfg = load_site_config(site_id)
    except Exception:
        return float(DEFAULT_PLANT_CAPACITY_MW) * float(DEFAULT_PENALTY_BAND_PCT)

    band_mw = cfg.get("penalty_band_mw")
    if band_mw is not None:
        return float(band_mw)

    plant_capacity = float(cfg.get("plant_capacity_mw", DEFAULT_PLANT_CAPACITY_MW))
    penalty_band_pct_raw = float(cfg.get("penalty_band_pct", DEFAULT_PENALTY_BAND_PCT))
    penalty_band_frac = _normalize_penalty_band_fraction(penalty_band_pct_raw)
    return plant_capacity * penalty_band_frac


def _resolve_site_name(site_id: str) -> str:
    try:
        cfg = load_site_config(site_id)
        return str(cfg.get("site_name") or cfg.get("site_id") or site_id)
    except Exception:
        return site_id


def load_comparison_site_config(plant: str) -> Dict:
    if not plant:
        return {}
    cfg_path = os.path.join(COMPARISON_CONFIG_DIR, f"{plant.lower()}.json")
    if not os.path.exists(cfg_path):
        return {}
    with open(cfg_path, "r", encoding="utf-8") as f:
        return json.load(f) or {}


def _normalize_col_name(v: str) -> str:
    return to_header_key(v)


def parse_schedule_series_map(text: str, mode: str, site_cfg: Optional[Dict] = None) -> Dict[int, float]:
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return {}

    header_idx = -1
    for i, line in enumerate(lines[:50]):
        l = line.lower()
        if "block" in l and ("schedule" in l or "forecast" in l or "timestamp" in l):
            header_idx = i
            break
    if header_idx > 0:
        text = "\n".join(lines[header_idx:])

    mode_cfg = ((site_cfg or {}).get("comparison", {}) or {}).get(mode, {}) or {}
    configured_value_columns = mode_cfg.get("value_column")
    configured_block_columns = mode_cfg.get("block_column")
    if isinstance(configured_value_columns, str):
        configured_value_columns = [configured_value_columns]
    if isinstance(configured_block_columns, str):
        configured_block_columns = [configured_block_columns]

    headers, rows = parse_csv_simple(text)
    if not headers:
        headers, rows = parse_csv_with_header_detection(text)
    if not headers:
        return {}

    normalized = [to_header_key(h) for h in headers]
    header_has_schedule_signals = any(
        ("block" in h or "schedule" in h or "forecast" in h or "forcast" in h) for h in normalized
    )
    if not header_has_schedule_signals:
        headers2, rows2 = parse_csv_with_header_detection(text)
        if headers2:
            headers, rows = headers2, rows2
            normalized = [to_header_key(h) for h in headers]

    def find_col(matchers: List[str]) -> int:
        for idx, h in enumerate(normalized):
            if any(m in h for m in matchers):
                return idx
        return -1

    def find_col_exact(exacts: List[str]) -> int:
        exact_set = set(exacts)
        for idx, h in enumerate(normalized):
            if h in exact_set:
                return idx
        return -1

    def find_col_from_config(key: str) -> int:
        configured = mode_cfg.get(key)
        if not configured:
            return -1
        if isinstance(configured, str):
            configured = [configured]
        normalized_targets = [_normalize_col_name(v) for v in configured]
        return find_col_exact(normalized_targets)

    block_idx = find_col_from_config("block_column")
    if block_idx == -1:
        block_idx = find_col(["block", "blockno", "blk"])
    start_idx = find_col(["start"])
    time_idx = find_col(["time", "timestamp"])
    is_meta = lambda h, i: i == block_idx or i == time_idx or "date" in h

    value_idx = find_col_from_config("value_column")
    if mode == "system":
        if value_idx == -1:
            # Strict preference for system output column.
            value_idx = find_col_exact(["algoschedulemw"])
        if value_idx == -1:
            value_idx = find_col(
                [
                    "algoschedulemw",
                    "algoschedule",
                    "systemschedule",
                    "finalschedule",
                    "scheduledmw",
                    "scheduled",
                    "schedule",
                ]
            )
        if value_idx == -1:
            value_idx = find_col(["forecast"])
    else:
        if value_idx == -1:
            # Strict preference for Vedanjay template final schedule column.
            value_idx = find_col_exact(["schedule"])
        if value_idx == -1:
            # Vedanjay templates usually contain both "Declared Forecast" and "Schedule".
            # For comparison we must use final "Schedule" first.
            value_idx = find_col(["finalschedule", "scheduledmw", "scheduled", "schedule"])
        if value_idx == -1:
            value_idx = find_col(["forecast", "forcast"])
        if value_idx == -1:
            for i, h in enumerate(normalized):
                if is_meta(h, i):
                    continue
                if "availability" in h or "capacity" in h:
                    continue
                value_idx = i
                break

    if configured_value_columns and value_idx == -1:
        expected = ", ".join(configured_value_columns)
        raise ValueError(f"[{mode}] Could not find configured value column(s): {expected}")
    if configured_block_columns and block_idx == -1:
        # Allow Start/Time-based block derivation when a start column exists.
        if start_idx == -1:
            expected = ", ".join(configured_block_columns)
            raise ValueError(f"[{mode}] Could not find configured block column(s): {expected}")

    if value_idx == -1:
        return {}

    def _parse_dt(value: str) -> Optional[datetime]:
        val = str(value).strip()
        if not val:
            return None
        for fmt in ("%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M"):
            try:
                return datetime.strptime(val, fmt)
            except Exception:
                continue
        try:
            # Fallback: let pandas try to parse if available
            import pandas as pd

            dt = pd.to_datetime(val, errors="coerce", dayfirst=True)
            if pd.isna(dt):
                return None
            return dt.to_pydatetime()
        except Exception:
            return None

    raw_points = []
    for i, cols in enumerate(rows):
        blk = None
        if block_idx != -1 and block_idx < len(cols):
            blk = parse_block_number(cols[block_idx])
        if not blk and start_idx != -1 and start_idx < len(cols):
            dt = _parse_dt(cols[start_idx])
            if dt is not None:
                blk = int((dt.hour * 60 + dt.minute) / 15) + 1
        if not blk:
            blk = i + 1
        if not (1 <= blk <= TOTAL_BLOCKS):
            continue
        if value_idx >= len(cols):
            continue
        try:
            val = float(str(cols[value_idx]).strip())
        except Exception:
            continue
        raw_points.append((blk, val))

    if not raw_points:
        return {}

    header_key = normalized[value_idx] if value_idx < len(normalized) else ""
    values_only = [v for _, v in raw_points]
    factor = normalize_to_mw(values_only, header_key)

    series = {}
    for blk, val in raw_points:
        series[blk] = val * factor
    return series


def read_text_or_excel(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".xlsx") or lower.endswith(".xls"):
        try:
            import pandas as pd
        except Exception:
            raise RuntimeError("XLSX input requires pandas (and openpyxl). Install: pip install pandas openpyxl")
        df = pd.read_excel(path, sheet_name=0)
        return df.to_csv(index=False)
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        return f.read()


def pick_latest_file(path: str) -> str:
    if os.path.isfile(path):
        return path
    if not os.path.isdir(path):
        raise FileNotFoundError(f"Path not found: {path}")
    candidates = []
    for name in os.listdir(path):
        if name.lower().endswith((".csv", ".xlsx", ".xls")):
            full = os.path.join(path, name)
            if os.path.isfile(full):
                candidates.append(full)
    if not candidates:
        raise FileNotFoundError(f"No CSV/XLSX files found in directory: {path}")
    candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return candidates[0]


def write_comparison_csv(
    out_path: str,
    system_map: Dict[int, float],
    vedanjay_map: Dict[int, float],
) -> None:
    headers = [
        "Block",
        "Time",
        "System Schedule (MW)",
        "Vedanjay Schedule (MW)",
        "Diff (MW)",
        "Abs Diff (MW)",
        "Diff % of System",
    ]
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        for block in range(1, TOTAL_BLOCKS + 1):
            sys_val = system_map.get(block)
            vj_val = vedanjay_map.get(block)
            diff = (vj_val - sys_val) if (sys_val is not None and vj_val is not None) else None
            abs_diff = abs(diff) if diff is not None else None
            pct = (diff / sys_val * 100.0) if (diff is not None and sys_val not in (None, 0)) else None
            writer.writerow(
                [
                    block,
                    build_time(block),
                    f"{sys_val:.3f}" if sys_val is not None else "",
                    f"{vj_val:.3f}" if vj_val is not None else "",
                    f"{diff:.3f}" if diff is not None else "",
                    f"{abs_diff:.3f}" if abs_diff is not None else "",
                    f"{pct:.2f}" if pct is not None else "",
                ]
            )


def write_plot_html(
    out_path: str,
    system_map: Dict[int, float],
    vedanjay_map: Dict[int, float],
    title: str,
    site_name: Optional[str] = None,
    band_mw: Optional[float] = None,
) -> None:
    try:
        import plotly.graph_objects as go
    except Exception:
        raise RuntimeError("Plotly is required. Install: pip install plotly")

    x = list(range(1, TOTAL_BLOCKS + 1))
    y_sys = [system_map.get(b) for b in x]
    y_vj = [vedanjay_map.get(b) for b in x]

    fig = go.Figure()
    fig.add_trace(
        go.Scatter(
            x=x,
            y=y_sys,
            mode="lines+markers",
            name="System Schedule (MW)",
            line=dict(width=2.5, color="#1f77b4"),
        )
    )
    fig.add_trace(
        go.Scatter(
            x=x,
            y=y_vj,
            mode="lines+markers",
            name="Vedanjay Schedule (MW)",
            line=dict(width=2.0, color="#ff7f0e"),
        )
    )

    if band_mw is not None:
        max_tolerable = [(v + band_mw) if v is not None else None for v in y_sys]
        min_tolerable = [(v - band_mw) if v is not None else None for v in y_sys]
        fig.add_trace(
            go.Scatter(
                x=x,
                y=max_tolerable,
                mode="lines",
                name="Max Tolerable",
                line=dict(width=1.2, dash="dot", color="#7f7f7f"),
            )
        )
        fig.add_trace(
            go.Scatter(
                x=x,
                y=min_tolerable,
                mode="lines",
                name="Min Tolerable",
                line=dict(width=1.2, dash="dot", color="#7f7f7f"),
            )
        )

    fig.update_layout(
        title=title,
        xaxis_title="Block",
        yaxis_title="Power (MW)",
        hovermode="x unified",
        xaxis=dict(tickmode="linear", dtick=1),
    )
    if site_name:
        fig.add_annotation(
            x=0.0,
            y=1.08,
            xref="paper",
            yref="paper",
            text=f"<b>{site_name}</b>",
            showarrow=False,
            xanchor="left",
            yanchor="top",
        )
    fig.write_html(out_path, include_plotlyjs="cdn")


def resolve_hierarchy_paths(root: str, plant: str, date_s: str) -> Tuple[str, str, str]:
    base = os.path.join(root, plant.upper(), date_s)
    system_dir = os.path.join(base, "System")
    vedanjay_dir = os.path.join(base, "vedanjay")
    out_dir = os.path.join(base, "compared")
    return system_dir, vedanjay_dir, out_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare system vs Vedanjay schedules and generate HTML + CSV.")
    parser.add_argument("--system", default=None, help="Path to system schedule file or directory")
    parser.add_argument("--vedanjay", default=None, help="Path to Vedanjay schedule file or directory")
    parser.add_argument("--out", default=None, help="Output directory")
    parser.add_argument("--date", default=None, help="Date label for output files (YYYY-MM-DD).")
    parser.add_argument(
        "--root",
        default=os.path.dirname(os.path.abspath(__file__)),
        help="Comparisions root path for hierarchy mode",
    )
    parser.add_argument("--plant", default=None, help="Plant name for hierarchy mode (e.g. GSNP, CME)")
    args = parser.parse_args()

    # Prefer CLI args, fallback to defaults, then hierarchy.
    date_label = args.date or DEFAULT_DATE_LABEL or datetime.now().strftime("%Y-%m-%d")
    root_path = args.root or DEFAULT_ROOT
    plant_name = args.plant or DEFAULT_PLANT

    system_path = args.system or resolve_default_path(DEFAULT_SYSTEM_PATH)
    vedanjay_path = args.vedanjay or resolve_default_path(DEFAULT_VEDANJAY_PATH)
    out_dir = args.out or resolve_default_path(DEFAULT_OUT_DIR)

    # If defaults are empty but plant/date are set, derive hierarchy paths.
    if not system_path and not vedanjay_path and not out_dir and plant_name and date_label:
        h_system, h_vedanjay, h_out = resolve_hierarchy_paths(root_path, plant_name, date_label)
        system_path = h_system
        vedanjay_path = h_vedanjay
        out_dir = h_out

    needs_hierarchy = not (system_path and vedanjay_path and out_dir)
    if not needs_hierarchy:
        if not os.path.exists(system_path) or not os.path.exists(vedanjay_path):
            needs_hierarchy = True

    if needs_hierarchy:
        if not plant_name or not date_label:
            raise ValueError(
                "Either provide --system --vedanjay --out OR provide --root --plant --date for hierarchy mode."
            )
        h_system, h_vedanjay, h_out = resolve_hierarchy_paths(root_path, plant_name, date_label)
        system_path = system_path or h_system
        vedanjay_path = vedanjay_path or h_vedanjay
        out_dir = out_dir or h_out

    sys_file = pick_latest_file(system_path)
    vj_file = pick_latest_file(vedanjay_path)
    os.makedirs(out_dir, exist_ok=True)

    sys_text = read_text_or_excel(sys_file)
    vj_text = read_text_or_excel(vj_file)
    site_cfg = load_comparison_site_config(plant_name)

    system_map = parse_schedule_series_map(sys_text, mode="system", site_cfg=site_cfg)
    vedanjay_map = parse_schedule_series_map(vj_text, mode="vedanjay", site_cfg=site_cfg)

    if not system_map and not vedanjay_map:
        print("No valid data parsed from either file.")
        sys.exit(1)

    csv_out = os.path.join(out_dir, f"schedule-comparison-{date_label}.csv")
    html_out = os.path.join(out_dir, f"schedule-comparison-{date_label}.html")

    write_comparison_csv(csv_out, system_map, vedanjay_map)
    plant_label = (plant_name or "PLANT").upper()
    band_mw = _resolve_band_mw(plant_name) if plant_name else None
    site_name = _resolve_site_name(plant_name) if plant_name else None
    write_plot_html(
        html_out,
        system_map,
        vedanjay_map,
        f"<b>{plant_label}</b> Schedule Comparison - {date_label}",
        site_name=site_name,
        band_mw=band_mw,
    )

    print("System file:", sys_file)
    print("Vedanjay file:", vj_file)
    print("CSV:", csv_out)
    print("HTML:", html_out)


if __name__ == "__main__":
    main()
