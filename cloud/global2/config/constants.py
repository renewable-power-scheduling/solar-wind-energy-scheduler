# config/constants.py

# ---------- Block Settings ----------
BLOCKS_PER_DAY = 96
BLOCK_MINUTES = 15

# Gen end time fixed at 20:00 => last block ending at 20:00 is 80
GEN_END_BLOCK = 80

# ---------- Units ----------
# Everything internally in MW
POWER_UNIT = "MW"

# ---------- CSV parsing ----------
ENERCAST_META_LINES = 4  # TYPE/DATE/REVISION/REASON lines count
