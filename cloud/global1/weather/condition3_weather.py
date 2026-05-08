from pathlib import Path
import pandas as pd
import logging
import os

from utils.time_utils import timestamp_to_block
from utils.site_config_loader import load_site_config

EPS_SMALL_WM2 = 50.0
MIN_COMBINED_INTENSITY = 0.12
SITE_ID = os.getenv("SITE_ID", "").strip().upper()
logger = logging.getLogger(__name__)

# =============================================================================
# WEATHER CSV LOADER (MINUTELY_15)
# =============================================================================
def load_weather_csv(path: Path) -> pd.DataFrame:
    """
    Load 15-minute weather CSV and normalize columns.
    Expected columns:
      date
      cloud_cover
      temperature_2m
      wind_speed_10m
      diffuse_radiation
      direct_normal_irradiance
      global_tilted_irradiance
    """
    if not path.exists():
        raise FileNotFoundError(f"Weather file not found: {path}")

    df = pd.read_csv(path)
    if "date" not in df.columns:
        raise ValueError("Weather CSV missing required 'date' column")

    df["date"] = pd.to_datetime(df["date"])
    return df


def fetch_weather_csv_for_date(
    target_date,
    out_path: Path
) -> Path:
    """
    Fetch 15-minute weather data for a date using Open-Meteo and write CSV.
    Requires: openmeteo_requests, retry_requests, requests.
    """
    try:
        import openmeteo_requests
        from retry_requests import retry
        import requests
    except Exception as exc:
        raise RuntimeError(
            "Missing weather dependencies. Install openmeteo_requests and retry_requests."
        ) from exc

    base_session = requests.Session()
    retry_session = retry(base_session, retries=5, backoff_factor=0.2)
    openmeteo = openmeteo_requests.Client(session=retry_session)

    date_str = (
        target_date.strftime("%Y-%m-%d")
        if hasattr(target_date, "strftime")
        else str(target_date)
    )

    # Strict mode: coordinates must come from site config only.
    if not SITE_ID:
        msg = "SITE_ID is not set; cannot resolve site-specific weather coordinates"
        logger.error(msg)
        raise ValueError(msg)
    try:
        cfg = load_site_config(SITE_ID) or {}
        weather_cfg = cfg.get("weather", {}) if isinstance(cfg, dict) else {}
        latitude = weather_cfg.get("latitude")
        longitude = weather_cfg.get("longitude")
    except Exception as exc:
        msg = f"Failed to load site config for SITE_ID={SITE_ID}; cannot resolve weather coordinates"
        logger.error("%s: %s", msg, exc)
        raise ValueError(msg) from exc

    if latitude is None or longitude is None:
        msg = (
            f"Missing weather.latitude/weather.longitude in site config for SITE_ID={SITE_ID}"
        )
        logger.error(msg)
        raise ValueError(msg)

    url = "https://historical-forecast-api.open-meteo.com/v1/forecast"
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": date_str,
        "end_date": date_str,
        "minutely_15": [
            "cloud_cover",
            "temperature_2m",
            "wind_speed_10m",
            "diffuse_radiation",
            "direct_normal_irradiance",
            "global_tilted_irradiance",
        ],
        "timezone": "auto",
    }

    responses = openmeteo.weather_api(url, params=params)
    response = responses[0]

    minutely_15 = response.Minutely15()
    cloud_cover = minutely_15.Variables(0).ValuesAsNumpy()
    temperature_2m = minutely_15.Variables(1).ValuesAsNumpy()
    wind_speed_10m = minutely_15.Variables(2).ValuesAsNumpy()
    diffuse_radiation = minutely_15.Variables(3).ValuesAsNumpy()
    direct_normal_irradiance = minutely_15.Variables(4).ValuesAsNumpy()
    global_tilted_irradiance = minutely_15.Variables(5).ValuesAsNumpy()

    minutely_15_data = {
        "date": pd.date_range(
            start=pd.to_datetime(
                minutely_15.Time() + response.UtcOffsetSeconds(), unit="s", utc=True
            ),
            end=pd.to_datetime(
                minutely_15.TimeEnd() + response.UtcOffsetSeconds(), unit="s", utc=True
            ),
            freq=pd.Timedelta(seconds=minutely_15.Interval()),
            inclusive="left",
        )
    }
    minutely_15_data["cloud_cover"] = cloud_cover
    minutely_15_data["temperature_2m"] = temperature_2m
    minutely_15_data["wind_speed_10m"] = wind_speed_10m
    minutely_15_data["diffuse_radiation"] = diffuse_radiation
    minutely_15_data["direct_normal_irradiance"] = direct_normal_irradiance
    minutely_15_data["global_tilted_irradiance"] = global_tilted_irradiance

    df = pd.DataFrame(data=minutely_15_data)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out_path, index=False)
    return out_path


def build_weather_by_block(weather_df: pd.DataFrame) -> dict:
    """
    Build a block-indexed weather map from 15-minute weather data.
    """
    weather_by_block = {}
    for _, row in weather_df.iterrows():
        block = timestamp_to_block(row["date"])
        weather_by_block[block] = {
            "temperature_2m": float(row["temperature_2m"]),
            "wind_speed_10m": float(row["wind_speed_10m"]),
            "diffuse_radiation": float(row["diffuse_radiation"]),
            "direct_normal_irradiance": float(row.get("direct_normal_irradiance", 0.0)),
            "global_tilted_irradiance": float(row["global_tilted_irradiance"]),
        }
    return weather_by_block


def classify_block_weather_state(
    block: int,
    weather_by_block: dict,
    current_now: dict | None = None,
    current_prev: dict | None = None,
    max_block: int = 80,
    eps_small: float = EPS_SMALL_WM2,
    max_gti_today: float = 1.0,
    return_details: bool = False,
) -> str:
    """
    Abrupt weather detection with adaptive thresholds.
    Returns "ABRUPT"/"NORMAL" by default, or details when return_details=True.
    """
    details = {
        "state": "NORMAL",
        "abrupt_type": None,
        "cloud_dev": 0.0,
        "shift_ratio": 0.0,
        "cloud_threshold": 0.0,
        "shift_threshold": 0.0,
    }
    w_now = weather_by_block.get(block, {})
    gti_t = w_now.get("global_tilted_irradiance")
    min_gti_valid = 0.15 * max(max_gti_today, 1.0)
    if gti_t is None or gti_t < min_gti_valid:
        return details if return_details else details["state"]

    w_t1 = weather_by_block.get(block + 1, {})
    w_t2 = weather_by_block.get(block + 2, {})
    w_t3 = weather_by_block.get(block + 3, {})

    gti_t1 = w_t1.get("global_tilted_irradiance")
    gti_t2 = w_t2.get("global_tilted_irradiance")
    gti_t3 = w_t3.get("global_tilted_irradiance")
    dhi_t = w_now.get("diffuse_radiation")

    if (
        gti_t1 is None
        or gti_t2 is None
        or gti_t3 is None
        or dhi_t is None
    ):
        return details if return_details else details["state"]

    forecast_cloud_index = dhi_t / max(gti_t, 1.0)
    cloud_now = current_now.get("cloud_cover") if current_now else None
    if cloud_now is None:
        cloud_now_norm = forecast_cloud_index
    else:
        cloud_now_norm = float(cloud_now) / 100.0

    cloud_dev = cloud_now_norm - forecast_cloud_index

    irr_ratio_t = gti_t / max(max_gti_today, 1.0)
    cloud_threshold = 0.07 + 0.15 * irr_ratio_t
    details["cloud_threshold"] = float(cloud_threshold)
    if abs(cloud_dev) <= cloud_threshold:
        return details if return_details else details["state"]

    mean_short = (gti_t + gti_t1) / 2.0
    mean_mid = (gti_t2 + gti_t3) / 2.0
    shift_ratio = (mean_short - mean_mid) / max(mean_mid, 1.0)

    shift_threshold = 0.08 + 0.12 * irr_ratio_t
    details["shift_threshold"] = float(shift_threshold)
    if abs(shift_ratio) <= shift_threshold:
        return details if return_details else details["state"]

    combined_intensity = (0.6 * abs(cloud_dev)) + (0.4 * abs(shift_ratio))
    details["combined_intensity"] = float(combined_intensity)
    if combined_intensity < MIN_COMBINED_INTENSITY:
        return details if return_details else details["state"]

    details["state"] = "ABRUPT"
    if abs(cloud_dev) >= abs(shift_ratio):
        direction = cloud_dev
    else:
        direction = shift_ratio
    details["abrupt_type"] = "DECREASE" if direction < 0 else "INCREASE"
    details["cloud_dev"] = float(cloud_dev)
    details["shift_ratio"] = float(shift_ratio)

    return details if return_details else details["state"]

