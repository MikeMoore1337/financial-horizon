"""Provider-specific server-side exchange and cryptographic OIDC verification.

Based on the owner's YFC provider patterns, with independent client credentials.
Only fixed provider endpoints are contacted; no user-provided URL is fetched.
"""
from __future__ import annotations
from dataclasses import dataclass
from hmac import compare_digest
import re
import time

import httpx
from joserfc import jwt, jwk

from .providers import OAuthProvider
from .store import Claim

OIDC_JWKS = {
    "telegram": "https://oauth.telegram.org/.well-known/jwks.json",
    "google": "https://www.googleapis.com/oauth2/v3/certs",
}
OIDC_ISSUER = {
    "telegram": "https://oauth.telegram.org",
    "google": "https://accounts.google.com",
}
VK_PROFILE = "https://id.vk.ru/oauth2/user_info"
YANDEX_PROFILE = "https://login.yandex.ru/info?format=json"
_MAX_CODE = 2048
_DEVICE = re.compile(r"^[A-Za-z0-9._~-]{6,256}$")


class ProviderError(RuntimeError):
    """Sanitized provider failure; raw tokens never enter exception text."""


def normalize_subject(provider: str, claims: dict) -> str:
    """Keep only stable provider identity; never link accounts by email."""
    if not isinstance(claims, dict):
        raise ProviderError("Invalid identity profile")
    value = (
        claims.get("user_id") if provider == "vk" else
        claims.get("id") if provider == "yandex" else
        claims.get("sub")
    )
    if provider == "telegram":
        # Reuse YFC's restriction on Telegram ID (it represents a positive 64-bit integer).
        if isinstance(value, bool) or not str(value).isascii() or not str(value).isdecimal():
            raise ProviderError("Missing Telegram subject")
        if not (0 < int(value) <= 2**63 - 1):
            raise ProviderError("Invalid Telegram subject")
        return str(int(value))
    if isinstance(value, bool):
        raise ProviderError("Invalid provider subject")
    if isinstance(value, int):
        if value <= 0:
            raise ProviderError("Invalid provider subject")
        value = str(value)
    if not isinstance(value, str) or not 0 < len(value) < 256 or not value.isprintable() or not value.strip():
        raise ProviderError("Missing stable provider subject")
    return value


def verify_oidc(id_token: str, jwks: dict, provider: OAuthProvider, nonce: str, now: int | None = None) -> str:
    if not isinstance(id_token, str) or len(id_token) > 16000:
        raise ProviderError("Invalid OIDC token")
    if not isinstance(jwks, dict) or not isinstance(jwks.get("keys"), list):
        raise ProviderError("Invalid issuer JWKS")
    try:
        timestamp = int(now if now is not None else time.time())
        verified = jwt.decode(
            id_token, jwk.KeySet.import_key_set(jwks),
            algorithms=("RS256", "ES256")
        )
        claims = verified.claims
        jwt.JWTClaimsRegistry(
            now=timestamp, leeway=45,
            exp={"essential": True}, iat={"essential": True}
        ).validate(claims)
        valid_issuers = ({OIDC_ISSUER[provider.name], "accounts.google.com"}
                         if provider.name == "google" else {OIDC_ISSUER[provider.name]})
        if claims.get("iss") not in valid_issuers:
            raise ProviderError("Wrong OIDC issuer")
        audience = claims.get("aud")
        audiences = audience if isinstance(audience, list) else [audience]
        if provider.client_id not in audiences:
            raise ProviderError("Wrong OIDC audience")
        # OIDC Core requires azp for multiple audiences. An azp claim must
        # always identify this particular OAuth client, not another app.
        if (len(audiences) > 1 or "azp" in claims) and claims.get("azp") != provider.client_id:
            raise ProviderError("Wrong OIDC authorized party")
        if not isinstance(claims.get("exp"), int) or claims["exp"] < timestamp - 45:
            raise ProviderError("Expired OIDC token")
        if not isinstance(claims.get("iat"), int) or claims["iat"] > timestamp + 45:
            raise ProviderError("Invalid OIDC issue time")
        token_nonce = claims.get("nonce")
        if not isinstance(token_nonce, str) or not compare_digest(token_nonce, nonce):
            raise ProviderError("Wrong OIDC nonce")
        return normalize_subject(provider.name, dict(claims))
    except ProviderError:
        raise
    except Exception as error:
        # Do not send provider token contents or raw exceptions to client/logs.
        raise ProviderError("Could not validate signed OIDC claims") from None


def _json(response: httpx.Response) -> dict:
    if response.status_code < 200 or response.status_code >= 300:
        raise ProviderError("Provider rejected authorization")
    if len(response.content) > 200000:
        raise ProviderError("Oversized provider response")
    try:
        parsed = response.json()
    except ValueError:
        raise ProviderError("Malformed provider response") from None
    if not isinstance(parsed, dict):
        raise ProviderError("Malformed provider response")
    # Some OAuth token endpoints return an error envelope with HTTP 200.
    # Never treat that response as a successful exchange or surface error details.
    if "error" in parsed and parsed["error"] not in (None, ""):
        raise ProviderError("Provider rejected authorization")
    return parsed


async def exchange_provider(
    provider: OAuthProvider, transaction: Claim, code: str,
    *, device_id: str | None = None,
    state: str | None = None,
    transport: httpx.AsyncBaseTransport | None = None
) -> str:
    """Exchange code for stable subject. Tests inject MockTransport; production uses TLS.

    No access token, id_token, or full profile is retained after this call.
    """
    if not isinstance(code, str) or not 1 <= len(code) <= _MAX_CODE:
        raise ProviderError("Missing authorization code")
    async with httpx.AsyncClient(
        trust_env=False, timeout=12, follow_redirects=False, transport=transport
    ) as client:
        if provider.name == "vk":
            if not isinstance(device_id, str) or not _DEVICE.fullmatch(device_id) or not state:
                raise ProviderError("VK requires device_id and state")
            response = await client.post(
                provider.token_url,
                params={
                    "grant_type": "authorization_code",
                    "redirect_uri": transaction.redirect_uri,
                    "client_id": provider.client_id,
                    "code_verifier": transaction.verifier,
                    "device_id": device_id,
                    "state": state,
                }, data={"code": code},
            )
            result = _json(response)
            returned_state = result.get("state")
            if not isinstance(returned_state, str) or not compare_digest(returned_state, state):
                raise ProviderError("VK state mismatch")
            token = result.get("access_token")
            if not isinstance(token, str) or not token:
                raise ProviderError("Missing VK access token")
            profile = _json(await client.post(
                VK_PROFILE,
                params={"client_id": provider.client_id},
                data={"access_token": token},
            ))
            return normalize_subject("vk", profile.get("user"))
        params = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": transaction.redirect_uri,
            "code_verifier": transaction.verifier,
            "client_id": provider.client_id,
        }
        if provider.name == "telegram":
            response = await client.post(
                provider.token_url, data=params,
                auth=httpx.BasicAuth(provider.client_id, provider.client_secret)
            )
        else:
            response = await client.post(
                provider.token_url, data={**params, "client_secret": provider.client_secret}
            )
        result = _json(response)
        if provider.name == "yandex":
            token = result.get("access_token")
            if not isinstance(token, str) or not token:
                raise ProviderError("Missing Yandex access token")
            profile = _json(await client.get(
                YANDEX_PROFILE, headers={"Authorization": "OAuth " + token}
            ))
            # Yandex supplies client_id in the standard user-info response.
            # Fail closed rather than accepting a subject from another OAuth app.
            if profile.get("client_id") != provider.client_id:
                raise ProviderError("Wrong Yandex client identifier")
            return normalize_subject("yandex", profile)
        id_token = result.get("id_token")
        jwks = _json(await client.get(OIDC_JWKS[provider.name]))
        return verify_oidc(id_token, jwks, provider, transaction.nonce)
