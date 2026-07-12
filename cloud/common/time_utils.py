from datetime import datetime, timedelta


def block_to_minutes(block: int) -> int:
    return (block - 1) * 15


def block_to_hhmm(block: int) -> str:
    mins = block_to_minutes(block)
    hh = mins // 60
    mm = mins % 60
    return f"{hh:02d}:{mm:02d}"


def timestamp_to_block(ts) -> int:
    mins = ts.hour * 60 + ts.minute
    return (mins // 15) + 1


def block_to_timestamp(day, block):
    minutes = (block - 1) * 15
    return datetime.combine(day, datetime.min.time()) + timedelta(minutes=minutes)
