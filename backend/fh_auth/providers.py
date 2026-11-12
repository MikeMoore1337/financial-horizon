"""OAuth provider configuration and YFC-compatible Authorization Code + PKCE.

The account identity is always (provider, verified provider subject).
Credentials belong to this app, not to YFC. No payments are sent to providers.
"""
from __future__ import annotations
from dataclasses import dataclass
from urllib.parse import urlencode
from hashlib import sha256
import base64
import re

# Fixed allowlisted endpoints based on original YFC adapters.
_OAUTH = {
    "telegram": ("https://oauth.telegram.org/auth", "https://oauth.telegram.org/token", "openid"),
    # Google OIDC requires openid plus profile and/or email. Do not request email.
    "google": ("https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token", "openid profile"),
    "yandex": ("https://oauth.yandex.ru/authorize", "https://oauth.yandex.ru/token", "login:info"),
    "vk": ("https://id.vk.ru/authorize", "https://id.vk.ru/oauth2/auth", ""),
}
_OIDC = {"telegram", "google"}
_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


def pkce_challenge(verifier: str) -> str:
    if not _VERIFIER_RE.fullmatch(verifier):
        raise ValueError("Invalid PKCE verifier")
    return base64.urlsafe_b64encode(sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")


@dataclass(frozen=True)
class OAuthProvider:
    name: str
    client_id: str
    client_secret: str

    def __post_init__(self) -> None:
        if self.name not in _OAUTH:
            raise ValueError("Unsupported provider")
        if not self.client_id or (not self.client_secret and self.name != "vk"):
            raise ValueError("Incomplete provider configuration")

    def callback_uri(self, base: str) -> str:
        return base + "/api/auth/oauth/" + self.name + "/callback"

    @property
    def token_url(self) -> str:
        return _OAUTH[self.name][1]

    @property
    def is_oidc(self) -> bool:
        return self.name in _OIDC

    def authorize(self, *, base: str, state: str, verifier: str, nonce: str) -> str:
        if len(state) < 32 or len(nonce) < 32:
            raise ValueError("Short OAuth state or nonce")
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.callback_uri(base),
            "scope": _OAUTH[self.name][2],
            "state": state,
            "code_challenge": pkce_challenge(verifier),
            # VK ID's official web SDK sends lowercase "s256"; other IdPs use IETF "S256".
            "code_challenge_method": "s256" if self.name == "vk" else "S256",
        }
        if not params["scope"]:
            params.pop("scope")
        if self.is_oidc:
            params["nonce"] = nonce
        return _OAUTH[self.name][0] + "?" + urlencode(params)

    def redirect_uri(self, base: str) -> str:
        return self.callback_uri(base)
