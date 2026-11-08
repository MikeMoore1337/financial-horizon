"""Offline token/signature and provider HTTP exchange tests using generated credentials."""
from __future__ import annotations
from datetime import datetime, timezone
import base64
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import pytest
import httpx
from joserfc import jwt, jwk
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fh_auth.providers import OAuthProvider
from fh_auth.exchange import verify_oidc, normalize_subject, exchange_provider, ProviderError
from fh_auth.store import Claim


def _b64(n):
    return base64.urlsafe_b64encode(n.to_bytes((n.bit_length()+7)//8,'big')).rstrip(b'=').decode()


@pytest.fixture(scope="module")
def rsa_key():
    private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    numbers=private.public_key().public_numbers()
    return private, {"keys":[{"kty":"RSA","kid":"test-one","use":"sig",
              "n":_b64(numbers.n),"e":_b64(numbers.e),"alg":"RS256"}]}


def signed(private, *, iss, aud, sub, nonce, now=1700000000, extra=None):
    private_bytes=private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()
    )
    signer=jwk.import_key(private_bytes, "RSA", {"kid":"test-one"})
    claims={"iss":iss,"aud":aud,"sub":sub,"nonce":nonce,"iat":now,"exp":now+3600}
    if extra:
        claims.update(extra)
    return jwt.encode({"alg":"RS256","kid":"test-one"},claims,signer)


def test_crypto_token_check_signature_issuer_audience_nonce_time(rsa_key):
    private,jwks=rsa_key
    provider=OAuthProvider("telegram","123456789","synthetic-test-secret")
    token=signed(private,iss="https://oauth.telegram.org",aud="123456789",
                 sub="123456789",nonce="n"*40)
    assert verify_oidc(token,jwks,provider,"n"*40,now=1700000000)=="123456789"
    for bad in [
        signed(private,iss="https://evil.invalid",aud="123456789",sub="123456789",nonce="n"*40),
        signed(private,iss="https://oauth.telegram.org",aud="other-app",sub="123456789",nonce="n"*40),
        signed(private,iss="https://oauth.telegram.org",aud="123456789",sub="123456789",nonce="wrong"),
    ]:
        with pytest.raises(ProviderError):
            verify_oidc(bad,jwks,provider,"n"*40,now=1700000000)
    with pytest.raises(ProviderError):
        verify_oidc(token,jwks,provider,"n"*40,now=1700020000)
    with pytest.raises(ProviderError):
        verify_oidc(token[:-4]+"xxxx",jwks,provider,"n"*40,now=1700000000)
    with pytest.raises(ProviderError):
        normalize_subject("telegram",{"sub":"not-integer"})


@pytest.mark.anyio
async def test_yandex_exchange_returns_stable_id_only():
    calls=[]
    def transport(request):
        calls.append((request.method,str(request.url)))
        if request.url.host=="oauth.yandex.ru":
            body=parse_qs(request.content.decode())
            assert body["client_secret"]==["secret-test"]
            assert body["code_verifier"]==["v"*48]
            return httpx.Response(200,json={"access_token":"TEST_TOKEN"})
        assert request.url.host=="login.yandex.ru"
        assert request.headers["authorization"]=="OAuth TEST_TOKEN"
        return httpx.Response(200,json={"id":"yandex-account-223","client_id":"test-id","default_email":"person@example.test"})
    tx=Claim("yandex","v"*48,"n"*40,"https://fin-horizon.mikemoore.top/api/auth/oauth/yandex/callback")
    subject=await exchange_provider(OAuthProvider("yandex","test-id","secret-test"),tx,"some-code",transport=httpx.MockTransport(transport))
    assert subject=="yandex-account-223"
    assert len(calls)==2


@pytest.mark.anyio
async def test_vk_code_device_id_and_state_validation():
    calls=[]
    def transport(request):
        calls.append(str(request.url))
        if request.url.path=="/oauth2/auth":
            q=dict(request.url.params)
            assert q["code_verifier"]=="v"*48
            assert q["state"]=="test-state"
            assert q["device_id"]=="vk-device"
            return httpx.Response(200,json={"access_token":"TEST_TOKEN","state":"test-state"})
        assert request.url.path=="/oauth2/user_info"
        assert parse_qs(request.content.decode())["access_token"]==["TEST_TOKEN"]
        return httpx.Response(200,json={"user":{"user_id":8543,"email":"example@test.invalid"}})
    tx=Claim("vk","v"*48,"n"*40,"https://fin-horizon.mikemoore.top/api/auth/oauth/vk/callback")
    client=OAuthProvider("vk","vk-app-id","")
    assert await exchange_provider(client,tx,"code",device_id="vk-device",state="test-state",transport=httpx.MockTransport(transport))=="8543"
    assert len(calls)==2
    with pytest.raises(ProviderError):
        await exchange_provider(client,tx,"code",state="test-state",transport=httpx.MockTransport(transport))


@pytest.mark.anyio
async def test_telegram_oidc_exchange_mocked_jwks(rsa_key):
    private,jwks=rsa_key
    token=signed(private,iss="https://oauth.telegram.org",aud="123456789",sub="654321",nonce="n"*40,now=int(datetime.now(timezone.utc).timestamp()))
    def transport(request):
        if request.url.path=="/token":
            assert request.headers.get("authorization","").startswith("Basic ")
            return httpx.Response(200,json={"access_token":"ABC","id_token":token})
        if request.url.path=="/.well-known/jwks.json":
            return httpx.Response(200,json=jwks)
        raise AssertionError("Unexpected HTTP endpoint")
    tx=Claim("telegram","v"*48,"n"*40,"https://fin-horizon.mikemoore.top/api/auth/oauth/telegram/callback")
    assert await exchange_provider(OAuthProvider("telegram","123456789","test-secret"),tx,"valid-code",transport=httpx.MockTransport(transport))=="654321"


def test_oidc_authorized_party_is_checked_for_multiple_audiences(rsa_key):
 private,jwks=rsa_key
 client=OAuthProvider("telegram","123456789","synthetic-secret")
 def make(audience,extra=None):
  return signed(private,iss="https://oauth.telegram.org",aud=audience,
                sub="654321",nonce="n"*40,extra=extra)
 valid=make(["123456789","secondary-app"],{"azp":"123456789"})
 assert verify_oidc(valid,jwks,client,"n"*40,now=1700000000)=="654321"
 for invalid in [
  make(["123456789","secondary-app"]),
  make(["123456789","secondary-app"],{"azp":"secondary-app"}),
  make("123456789",{"azp":"other-client"}),
 ]:
  with pytest.raises(ProviderError,match="authorized party"):
   verify_oidc(invalid,jwks,client,"n"*40,now=1700000000)


@pytest.mark.anyio
@pytest.mark.parametrize("profile_client_id", ["different-yfc-app", None, "", 22])
async def test_yandex_user_info_rejects_foreign_client_identifier(profile_client_id):
    """Even a valid access token must resolve to this Financial Horizon app."""
    def transport(request):
        if request.url.host == "oauth.yandex.ru":
            return httpx.Response(200, json={"access_token": "synthetic-token"})
        assert request.url.host == "login.yandex.ru"
        assert request.headers["authorization"] == "OAuth synthetic-token"
        return httpx.Response(
            200, json={"id": "user-123", "client_id": profile_client_id}
        )

    claim = Claim(
        "yandex", "v" * 48, "n" * 40,
        "https://fin-horizon.mikemoore.top/api/auth/oauth/yandex/callback"
    )
    with pytest.raises(ProviderError, match="Wrong Yandex client identifier"):
        await exchange_provider(
            OAuthProvider("yandex", "financial-horizon-client", "synthetic-secret"),
            claim, "test-code", transport=httpx.MockTransport(transport)
        )

@pytest.mark.anyio
@pytest.mark.parametrize("error_payload", [
    {"error": "invalid_grant", "error_description": "synthetic sensitive error details"},
    {"error": {"code": "invalid_client", "message": "synthetic private detail"}},
])
async def test_telegram_http_200_error_envelope_rejected_without_token_fetch(error_payload):
    """Reject OAuth errors even when an IdP incorrectly uses HTTP 200.

    No arbitrary provider-supplied error strings may be surfaced to the caller.
    """
    requested = []

    def transport(request):
        requested.append(request.url.path)
        assert request.url.host == "oauth.telegram.org"
        assert request.url.path == "/token"
        return httpx.Response(200, json=error_payload)

    transaction = Claim(
        "telegram", "v" * 48, "n" * 40,
        "https://fin-horizon.mikemoore.top/api/auth/oauth/telegram/callback",
    )
    with pytest.raises(ProviderError, match="^Provider rejected authorization$") as exc:
        await exchange_provider(
            OAuthProvider("telegram", "123456789", "synthetic-secret"),
            transaction, "synthetic-one-time-code",
            transport=httpx.MockTransport(transport),
        )
    assert requested == ["/token"]  # No JWKS or profile fetch after OAuth error.
    assert "synthetic sensitive" not in str(exc.value)
    assert "synthetic private" not in str(exc.value)
