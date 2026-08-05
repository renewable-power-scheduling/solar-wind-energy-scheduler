from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
import io

from services.utility_file_service import (
    UtilityFileServiceError,
    export_range_zip,
    get_latest_file,
    list_dates,
    list_utilities,
)


router = APIRouter(prefix="/api/utility-viewer", tags=["WBES Portal"])


@router.get("/utilities")
def utility_viewer_utilities():
    try:
        return {"ok": True, **list_utilities()}
    except UtilityFileServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to scan utilities: {exc}") from exc


@router.get("/dates")
def utility_viewer_dates(utility: str = Query(..., min_length=1)):
    try:
        return {"ok": True, **list_dates(utility)}
    except UtilityFileServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to scan dates: {exc}") from exc


@router.get("/latest")
def utility_viewer_latest(
    utility: str = Query(..., min_length=1),
    date: str = Query(..., min_length=1),
):
    try:
        return {"ok": True, **get_latest_file(utility, date)}
    except UtilityFileServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to load latest file: {exc}") from exc


@router.get("/export-range")
def utility_viewer_export_range(
    utility: str = Query(..., min_length=1),
    from_date: str = Query(..., min_length=10),
    to_date: str = Query(..., min_length=10),
):
    try:
        file_name, data = export_range_zip(utility, from_date, to_date)
    except UtilityFileServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to export date range: {exc}") from exc
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{file_name}"'},
    )
