import os
import json

# Automatically get the JSON file path relative to this script
JSON_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "windy_raw.json")

# Load dummy JSON
with open(JSON_FILE, "r") as f:
    data = json.load(f)

print("Dummy Windy API data loaded successfully!")
print(data)
