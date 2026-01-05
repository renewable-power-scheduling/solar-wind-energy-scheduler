from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.encoders import jsonable_encoder
import shutil
import os
import pandas as pd
import math

router = APIRouter()

UPLOAD_DIR = "data/enercast"


@router.post("/upload_enercast_csv")
def upload_enercast_csv(file: UploadFile = File(...)):
  
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is missing")


    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are allowed")

    try:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        file_path = os.path.join(UPLOAD_DIR, file.filename)

        
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        return {
            "message": "Enercast CSV uploaded successfully",
            "filename": file.filename
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to upload CSV: {str(e)}"
        )


@router.get("/get_enercast_preview")
def get_enercast_preview(rows: int = 5):
    if rows <= 0:
        raise HTTPException(status_code=400, detail="Rows must be greater than 0")

    if not os.path.exists(UPLOAD_DIR):
        raise HTTPException(status_code=404, detail="Enercast folder not found")

    files = sorted(
        [f for f in os.listdir(UPLOAD_DIR) if f.endswith(".csv")]
    )

    if not files:
        raise HTTPException(status_code=404, detail="No Enercast CSV found")

    latest_file = os.path.join(UPLOAD_DIR, files[-1])

    try:
        df = pd.read_csv(latest_file, encoding="utf-16-le")

        if df.empty:
            raise HTTPException(status_code=400, detail="CSV file is empty")

        records = df.head(rows).to_dict(orient="records")

        safe_records = jsonable_encoder(
            records,
            custom_encoder={
                float: lambda x: None if (math.isnan(x) or math.isinf(x)) else x
            }
        )

        return {
            "file": os.path.basename(latest_file),
            "rows_returned": len(safe_records),
            "preview": safe_records
        }

    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="CSV encoding error. Expected UTF-16 LE."
        )

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to read CSV: {str(e)}"
        )
