# OAuth provider brand asset provenance

These sign-in icons are **vendor-authored or byte-identical existing brand
assets**, not AI-generated, hand-drawn, traced, or icon-library substitutes.
All are shipped locally; the login screen makes no third-party image requests.

| Local file | Source | Source pinned revision / Git blob |
| --- | --- | --- |
| `google.svg` | [Google's FirebaseUI, `packages/core/brands/google/logo.svg`](https://github.com/firebase/firebaseui-web/blob/07a95334cff6a9c7ca7d160fde1085bcb679b519/packages/core/brands/google/logo.svg) | `07a95334cff6a9c7ca7d160fde1085bcb679b519`, blob `c0669b38ff8d0b21fd6a0edbc1d2fddbe576d60f`, exact file |
| `yandex.webp` | Existing original Yandex ID sign-in image used in [Your Fitness Coach](https://github.com/MikeMoore1337/your-fitness-coach/blob/52d20761ed365d5d20d53b61562c303760f7d9cd/frontend/public/assets/providers/yandex.webp) | Git commit `52d20761ed365d5d20d53b61562c303760f7d9cd`, blob `476663bcacd848b86ecb4e7ae5141bec097d2af7`, exact binary |
| `vk.svg` | [VK ID iOS SDK official `logo.svg`](https://github.com/VKCOM/vkid-ios-sdk/blob/e986a5d75984928e2dc80fafea8c6ea4a8c24d53/logo.svg) | `e986a5d75984928e2dc80fafea8c6ea4a8c24d53`, original blob `b1e7c0072ea72e92ca515f27f1e893a60eaec537`; **official 100×100 emblem paths only, unchanged**, cropped from logo + wordmark |
| `telegram.svg` | [Telegram's official Web Z `telegram-logo`](https://github.com/TelegramOrg/Telegram-web-z/blob/6002824b6532f3d913997ce496d9ab5f9b86bc22/dist/assets/telegram-logo-DY3LTI8H.svg) | `6002824b6532f3d913997ce496d9ab5f9b86bc22`, blob `ae107ff4bc7e4e889a94b1fb2cf57c5ac6bf6c6d`, exact file |

The previous manually drawn `yandex.svg` is retained **only** as an
unused backward-compatibility asset for older installed Service Workers.
Current `auth-ui.js` uses `yandex.webp`; new Service Worker pre-caches the
four authentic images. Back-end-only release checks pin both the current
Yandex WebP and legacy SVG path so existing PWA sessions remain compatible.

Public vendor branding guidance:

- [Google Sign In branding](https://developers.google.com/identity/branding-guidelines):
  keep the brand-colour G unchanged on a white backing.
- [Yandex ID login button design](https://yandex.ru/dev/id/doc/ru/codes/buttons-design):
  use the actual Yandex ID «Я» mark and preserve its colour and proportions.
- [VK ID SDK](https://github.com/VKCOM/vkid-web-sdk):
  original VK icon paths from VKCOM's SDK.
- [Telegram press logos](https://telegram.org/tour/screenshots):
  official Telegram marks should identify the service and not imply endorsement.

Trademarks belong to the respective owners; the icons identify the
authentication providers only. No new JS libraries, remote CDNs, fonts or
third-party tracking requests are introduced. This does **not** prove
that all four OAuth login/callback exchanges succeed.
