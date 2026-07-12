import base64
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "public" / "templates" / "telangana_sldc_template.xlsx"
TARGET = ROOT / "backend" / "services" / "sldc_attachment_converter.py"

START = '_TELANGANA_TEMPLATE_XLSX_B64 = """'
END = '""".strip()'


def main() -> None:
    data = TEMPLATE.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    # Wrap at 76 chars to match certutil output style.
    wrapped = "\n".join(b64[i : i + 76] for i in range(0, len(b64), 76))

    text = TARGET.read_text(encoding="utf-8")
    if START not in text or END not in text:
        raise SystemExit("Markers not found in target file.")
    before, tail = text.split(START, 1)
    _old, after = tail.split(END, 1)
    updated = before + START + "\n" + wrapped + "\n" + END + after
    TARGET.write_text(updated, encoding="utf-8")


if __name__ == "__main__":
    main()

