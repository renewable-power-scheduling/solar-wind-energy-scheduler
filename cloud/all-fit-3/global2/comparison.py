# compare_schedules.py
# Usage:
#   python compare_schedules.py --system "C:\\path\\to\\system_dir" --vedanjay "C:\\path\\to\\vedanjay_dir" --out "C:\\path\\to\\out"
# Or pass files directly:
#   python compare_schedules.py --system "C:\\path\\to\\system.csv" --vedanjay "C:\\path\\to\\vedanjay.xlsx" --out "C:\\path\\to\\out"

import argparse
import csv
import os
import sys
from datetime import datetime
from typing import List, Tuple, Dict, Optional

TOTAL_BLOCKS = 96

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
        v = int(text)
        return v
    except Exception:
        pass
    for pattern in [r"[bB]\s*([0-9]{1,3})", r"([0-9]{1,3})"]:
        import re
        m = re.search(pattern, text)
        if m:
            try:
                return int(m.group(1))
            except Exception:
                return None
    return None

def to_header_key(v: str) -> str:
    return str(v or "").lower().replace('"', "").replace("'", "").replace(" ", "").replace("_", "").replace("-", "")

def detect_csv_header(lines: List[str]) -> Tuple[int, str]:
    # Choose best header line in first 25 lines, then delimiter.
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
    delim = "," if header.count(",") >= max(header.count(";"), header.count("\t")) else (";" if header.count(";") >= header.count("\t") else "\t")
    reader = csv.reader(lines, delimiter=delim)
    rows = list(reader)
    headers = [h.replace("\ufeff", "").strip() for h in rows[0]]
    return headers, rows[1:]

def normalize_to_mw(values: List[float], header_key: str) -> float:
    # Determine unit factor based on header or magnitude.
    explicit_kw = "kw" in header_key and "mw" not in header_key
    explicit_mw = "mw" in header_key
    explicit_w = header_key.endswith("w") or "(w)" in header_key

    non_zero = [abs(v) for v in values if v and abs(v) > 0]
    avg = sum(non_zero) / len(non_zero) if non_zero else 0
    assume_kw = explicit_kw or (not explicit_mw and not explicit_w and avg > 200)

    if explicit_w:
        return 1 / 1_000_000
    if assume_kw:
        return 1 / 1000
    return 1

def parse_schedule_series_map(text: str, mode: str) -> Dict[int, float]:
    # mode: "system" or "vedanjay"
    # system: prefer schedule/algoschedule columns
    # vedanjay: prefer forecast/forcast column
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return {}

    # For system schedule, try to detect header line even if metadata lines exist.
    header_idx = -1
    for i, line in enumerate(lines[:50]):
        l = line.lower()
        if "block" in l and ("schedule" in l or "forecast" in l or "timestamp" in l):
            header_idx = i
            break
    if header_idx > 0:
        text = "\n".join(lines[header_idx:])

    headers, rows = parse_csv_simple(text)
    if not headers:
        headers, rows = parse_csv_with_header_detection(text)
    if not headers:
        return {}

    normalized = [to_header_key(h) for h in headers]

    def find_col(matchers: List[str]) -> int:
        for idx, h in enumerate(normalized):
            if any(m in h for m in matchers):
                return idx
        return -1

    block_idx = find_col(["block", "blockno", "blk"])
    time_idx = find_col(["time", "timestamp"])
    is_meta = lambda h, i: i == block_idx or i == time_idx or "date" in h

    value_idx = -1
    if mode == "system":
        value_idx = find_col(["algoschedulemw", "algoschedule", "systemschedule", "finalschedule", "scheduledmw", "scheduled", "schedule"])
        if value_idx == -1:
            value_idx = find_col(["forecast"])
    else:
        value_idx = find_col(["forecast", "forcast"])
        if value_idx == -1:
            # fallback: numeric non-meta column
            for i, h in enumerate(normalized):
                if is_meta(h, i):
                    continue
                if "availability" in h or "capacity" in h:
                    continue
                value_idx = i
                break

    if value_idx == -1:
        return {}

    raw_points = []
    for i, cols in enumerate(rows):
        blk = None
        if block_idx != -1 and block_idx < len(cols):
            blk = parse_block_number(cols[block_idx])
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

def write_comparison_csv(out_path: str, system_map: Dict[int, float], vedanjay_map: Dict[int, float]):
    headers = [
        "Block",
        "Time",
        "System Schedule (MW)",
        "Vedanjay Schedule (MW)",
        "Diff (MW)",
        "Abs Diff (MW)",
        "Diff % of System"
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
            writer.writerow([
                block,
                build_time(block),
                f"{sys_val:.3f}" if sys_val is not None else "",
                f"{vj_val:.3f}" if vj_val is not None else "",
                f"{diff:.3f}" if diff is not None else "",
                f"{abs_diff:.3f}" if abs_diff is not None else "",
                f"{pct:.2f}" if pct is not None else "",
            ])

def write_plot_html(out_path: str, system_map: Dict[int, float], vedanjay_map: Dict[int, float], title: str):
    try:
        import plotly.graph_objects as go
    except Exception:
        raise RuntimeError("Plotly is required. Install: pip install plotly")

    x = list(range(1, TOTAL_BLOCKS + 1))
    y_sys = [system_map.get(b) for b in x]
    y_vj = [vedanjay_map.get(b) for b in x]

    fig = go.Figure()
    fig.add_trace(go.Scatter(x=x, y=y_sys, mode="lines", name="System Schedule (MW)", line=dict(color="#6366f1", width=2.5)))
    fig.add_trace(go.Scatter(x=x, y=y_vj, mode="lines", name="Vedanjay Schedule (MW)", line=dict(color="#22c55e", width=2.5)))

    fig.update_layout(
        title=title,
        xaxis_title="Block No",
        yaxis_title="Power (MW)",
        hovermode="x unified",
        legend=dict(orientation="h", x=0, y=1.1),
        margin=dict(l=70, r=20, t=50, b=60),
    )
    fig.write_html(out_path, include_plotlyjs="cdn")

def main():
    parser = argparse.ArgumentParser(description="Compare system vs Vedanjay schedules and generate HTML + CSV.")
    parser.add_argument("--system", required=True, help="Path to system schedule file or directory")
    parser.add_argument("--vedanjay", required=True, help="Path to Vedanjay schedule file or directory")
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument("--date", default=None, help="Date label for output files (YYYY-MM-DD). Optional.")
    args = parser.parse_args()

    sys_path = pick_latest_file(args.system)
    vj_path = pick_latest_file(args.vedanjay)

    os.makedirs(args.out, exist_ok=True)

    sys_text = read_text_or_excel(sys_path)
    vj_text = read_text_or_excel(vj_path)

    system_map = parse_schedule_series_map(sys_text, mode="system")
    vedanjay_map = parse_schedule_series_map(vj_text, mode="vedanjay")

    if not system_map and not vedanjay_map:
        print("No valid data parsed from either file.")
        sys.exit(1)

    date_label = args.date or datetime.now().strftime("%Y-%m-%d")
    csv_out = os.path.join(args.out, f"schedule-comparison-{date_label}.csv")
    html_out = os.path.join(args.out, f"schedule-comparison-{date_label}.html")

    write_comparison_csv(csv_out, system_map, vedanjay_map)
    write_plot_html(html_out, system_map, vedanjay_map, f"Schedule Comparison - {date_label}")

    print("System file:", sys_path)
    print("Vedanjay file:", vj_path)
    print("CSV:", csv_out)
    print("HTML:", html_out)

if __name__ == "__main__":
    main()
