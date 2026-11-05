"""Mandatory server-side Turnstile verification. Fail closed on any response error."""
from __future__ import annotations
from urllib.parse import urlsplit
import httpx

SITEVERIFY="https://challenges.cloudflare.com/turnstile/v0/siteverify"


def validate_token(secret: str, token: str, origin: str, action: str) -> bool:
    if not secret or not isinstance(token,str) or not 1<=len(token)<=2048:
        return False
    try:
        with httpx.Client(timeout=6,trust_env=False,follow_redirects=False) as client:
            response=client.post(SITEVERIFY,data={"secret":secret,"response":token})
            if response.status_code!=200 or len(response.content)>10000:
                return False
            payload=response.json()
            return (
                isinstance(payload,dict)
                and payload.get("success") is True
                and payload.get("hostname")==urlsplit(origin).hostname
                and payload.get("action")==action
            )
    except (httpx.HTTPError,ValueError,TypeError):
        return False
