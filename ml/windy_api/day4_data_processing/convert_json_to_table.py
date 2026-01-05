import json
import pandas as pd

# JSON file path (correct for your folder structure)
JSON_FILE = "../data/windy_raw.json"

# Load JSON
with open(JSON_FILE, "r") as f:
    data = json.load(f)

# Convert to DataFrame
df = pd.DataFrame({
    "timestamp": data["ts"],
    "wind_speed": data["wind"],
    "temp": data["temp"]
})

# Print table
print("Windy Data in Tabular Form:")
print(df)

# Save CSV
CSV_FILE = "../data/windy_tabular.csv"
df.to_csv(CSV_FILE, index=False)
print(f"\nData saved to {CSV_FILE}")
