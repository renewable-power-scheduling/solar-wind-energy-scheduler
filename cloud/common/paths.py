from __future__ import annotations

from pathlib import Path

CLOUD_ROOT = Path(__file__).resolve().parents[1]
CONFIG_ROOT = CLOUD_ROOT / "configs" / "sites"
LAMBDA_SITES_ROOT = CLOUD_ROOT / "lambda_sites"
WHATSAPP_ROOT = CLOUD_ROOT / "whatsapp"
MANUAL_ROOT = CLOUD_ROOT / "manual"
DA_SCHEDULER_ROOT = CLOUD_ROOT / "da_scheduler"
DATA_ROOT = CLOUD_ROOT / "data"
OUTPUTS_ROOT = CLOUD_ROOT / "outputs"
CUSTOM_ROOT = CLOUD_ROOT / "custom"
