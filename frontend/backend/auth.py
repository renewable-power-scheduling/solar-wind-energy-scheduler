from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

from fastapi import HTTPException, Request
from jose import jwt, JWTError
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from typing import Any

# Pylance can report "unknown import symbol" for SQLAlchemy models depending on
# how the `models` package is structured at type-check time. Runtime import is valid.
from models import User as UserModel  # type: ignore[attr-defined]


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

ALGORITHM = "HS256"
DEFAULT_ACCESS_TOKEN_EXPIRE_HOURS = 24


def _secret_key() -> str:
    key = str(os.getenv("AUTH_SECRET_KEY") or "").strip()
    if key:
        return key
    # Dev-only fallback. In production, AUTH_SECRET_KEY must be set.
    return "dev-insecure-secret-change-me"


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    try:
        return pwd_context.verify(plain_password, password_hash)
    except Exception:
        return False


def create_access_token(*, subject: str, role: str, expires_hours: Optional[int] = None) -> str:
    expire_hours = int(expires_hours or int(os.getenv("ACCESS_TOKEN_EXPIRE_HOURS") or DEFAULT_ACCESS_TOKEN_EXPIRE_HOURS))
    expire = datetime.utcnow() + timedelta(hours=max(1, expire_hours))
    payload = {
        "sub": subject,
        "role": role,
        "exp": expire,
        "iat": datetime.utcnow(),
    }
    return jwt.encode(payload, _secret_key(), algorithm=ALGORITHM)


def decode_token(token: str) -> Dict[str, Any]:
    try:
        return jwt.decode(token, _secret_key(), algorithms=[ALGORITHM])
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc


def get_user_by_username(db: Session, username: str) -> Optional[UserModel]:
    if not username:
        return None
    return db.query(UserModel).filter(UserModel.username == username).first()


def authenticate_user(db: Session, username: str, password: str) -> Optional[UserModel]:
    user = get_user_by_username(db, username)
    if not user or not user.is_active:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def require_auth(request: Request) -> Dict[str, Any]:
    """
    Read the user payload attached by auth middleware.
    Returns dict: {"username": ..., "role": ...}
    """
    payload = getattr(request.state, "user", None)
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return payload


def require_admin(request: Request) -> Dict[str, Any]:
    payload = require_auth(request)
    if str(payload.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return payload
