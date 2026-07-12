# ---------- Block Settings ----------
BLOCKS_PER_DAY = 96
BLOCK_MINUTES = 15

# Gen end time fixed at 20:00 => last block ending at 20:00 is 80
GEN_END_BLOCK = 80

# ---------- Units ----------
POWER_UNIT = "MW"

# ---------- Metered column name (exact) ----------
METERED_POWER_COL = "Active Power-avg MFM-OUT(Meter Power) (kW)"
METERED_TS_COL = "Timestamp"

# ---------- CSV parsing ----------
ENERCAST_META_LINES = 4

# ---------- Night noise cleaning ----------
CLAMP_NEGATIVE_METERED_TO_ZERO = True
