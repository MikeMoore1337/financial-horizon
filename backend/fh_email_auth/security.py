"""Password and token primitives based on verified YFC password-auth patterns."""
from __future__ import annotations
from hashlib import sha256
import hmac
import re
import secrets

from pwdlib import PasswordHash

HASHER=PasswordHash.recommended()
DUMMY_HASH=HASHER.hash("dummy-password-for-auth-timing")
EMAIL_RE=re.compile(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\Z")
COMMON={"123456789012","password1234","qwerty123456","financialhorizon","yourfitnesscoach"}


class InvalidCredentials(ValueError):
    pass


def normalize_email(email: str) -> str:
    if not isinstance(email,str): raise ValueError("Некорректный email")
    value=email.strip().lower()
    if len(value)>254 or len(value)<5 or not value.isascii() or not EMAIL_RE.fullmatch(value):
        raise ValueError("Некорректный email")
    return value


def valid_password(password: str) -> str:
    if not isinstance(password,str) or not 12<=len(password)<=128:
        raise ValueError("Пароль должен содержать 12-128 символов")
    if password.casefold() in COMMON:
        raise ValueError("Слишком распространённый пароль")
    return password


def make_password_hash(password: str) -> str:
    return HASHER.hash(valid_password(password))


def verify_password(password: str, value: str | None) -> bool:
    if not isinstance(password,str) or len(password)>128 or not password:
        return False
    try:
        return HASHER.verify(password,value if value else DUMMY_HASH) and bool(value)
    except (ValueError, TypeError):
        return False


def random_token() -> str:
    return secrets.token_urlsafe(48)


def token_hash(token: str) -> str:
    return sha256(token.encode("ascii")).hexdigest()


def limit_key(pepper: str, action: str, principal: str) -> str:
    return hmac.new(pepper.encode("utf-8"),(action+":"+principal).encode("utf-8"),"sha256").hexdigest()
