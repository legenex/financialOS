# FinancialOS New Tab (Chrome extension)

A calm, view-only glance at your FinancialOS plan on every new tab. It replaces Chrome's new tab page with a
small summary — spending pace, safe-to-spend, a few goals, what is due soon, one coaching nudge, how fresh the
data is — and a single way into the app.

It is built from `apps/extension` and is **not** on the Chrome Web Store. You install it yourself from a ZIP your
own FinancialOS produced.

## What it does

- Replaces the new tab page (`chrome_url_overrides.newtab`) with a page that ships inside the package.
- Asks your FinancialOS for one sanitised summary (`GET /api/ext/v1/glance`) and shows it.
- Caches that summary in memory for a few minutes, and asks again at most once a minute across every open tab.
- Opens FinancialOS through `/launch/<target>`, which always asks you to sign in again before it reveals
  anything.

## What it does not do

- **No amounts by default.** The server sends figures only for the fields you have explicitly allowed for that
  device. Nothing is "hidden with CSS": a masked amount was never sent to the browser.
- **No transactions, documents, account numbers, provider credentials, or entities.** The glance endpoint is the
  only endpoint the extension may call, and it returns a fixed summary shape.
- **No writes, ever.** It cannot move money, approve anything, change settings, or sign you in.
- **No browsing history, tabs, cookies, bookmarks, or downloads.** It holds none of those permissions, so it
  cannot read them even in principle.
- **No content scripts and no access to other websites.** It never runs on a page you visit.
- **No background service worker.** Nothing runs when a new tab is not open.
- **No remote code, no `eval`, no analytics, no telemetry, no sync.** Every script, style, icon and font is in
  the package; the build refuses output that is not.
- **No invented data.** If FinancialOS cannot be reached, the device was revoked, or the summary is past its
  `validUntil`, the page shows a neutral locked or offline state with no figures at all.

## Permissions, and why each one is there

| Permission                                                                                              | Why                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                                                                                               | Keeps the configured address and the device credential in this browser's extension storage, and the last summary in session storage. |
| `optional_host_permissions`: `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`                  | Declares the _shape_ of address the extension may be pointed at. None of it is granted at install time.                              |
| No `host_permissions`                                                                                   | Nothing is granted up front.                                                                                                         |
| No `content_scripts`, `background`, `tabs`, `history`, `cookies`, `webRequest`, `scripting`, `identity` | Not needed for a glance, so not requested.                                                                                           |

The optional pattern is broad because your FinancialOS could be at any private HTTPS address. What Chrome
actually grants is not: when you save an address, the extension asks for **exactly that one origin**
(`https://financialos.example.test/*`), and for nothing else. `chrome://extensions` shows which single site it
can access. Plain `http://` is accepted only for `localhost` and `127.0.0.1`, for running FinancialOS on the same
computer.

Changing the address releases the permission for the old one. "Forget this device locally" releases it entirely.

The content security policy for extension pages is `script-src 'self'` with no `unsafe-eval`, `unsafe-inline`,
nonces or hashes, `base-uri 'none'`, `form-action 'none'` and `frame-ancestors 'none'`. Outbound connections are
limited to `https:` plus loopback. `externally_connectable` is `{ "ids": [] }`, so no other extension or web page
can message it.

## Privacy

- **Masked by default.** A new device is paired with no revealed fields. You turn individual amounts on in
  **Settings → Devices**, per device, and the server acknowledges the risk with you before it does.
- **Local only.** The device credential and the configured address live in `chrome.storage.local` on this
  computer. They are never written to `chrome.storage.sync`, so they never travel to your other Chrome profiles
  or through a Google account.
- **Not a secure vault.** Extension storage is ordinary profile data. Anyone with access to this Chrome profile
  could read the credential. If the computer is lost or shared, revoke the device in FinancialOS — that is what
  makes the credential stop working.
- **Short-lived on screen.** The summary is kept in `chrome.storage.session`, which Chrome clears when the
  browser closes. It is never shown after its `validUntil`, and never for longer than 30 minutes from the moment
  it arrived, whatever the server claims.
- **Server-side record.** FinancialOS stores only a hash of the credential, records the device's last access, and
  writes an audit entry when the glance is read. The credential expires on its own and can be revoked at any
  time, individually or all at once.
- **Session cookies are never shared.** The extension sends `credentials: 'omit'`; the API refuses a request from
  the extension that carries a session cookie at all.

## Install

1. In FinancialOS, open **Settings → Devices** and download the extension ZIP.
2. Unzip it somewhere you will keep — Chrome loads an unpacked extension from that folder every time it starts,
   so do not unzip it into a temporary directory.
3. Open `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Choose **Load unpacked** and select the unzipped folder.
6. Check that the ID Chrome shows matches the one in FinancialOS (**Settings → System → Domain and Access**). It
   is pinned by the packaged public key, so it is the same on every computer.

The ZIP is reproducible: building the same source twice produces the same bytes. The download page publishes the
SHA-256, and `release/financialos-newtab-<version>.zip.sha256` holds the same value next to the archive.

## Pair this browser

1. Open the extension's options page (`chrome://extensions` → **Details** → **Extension options**, or the slider
   icon on the new tab).
2. Enter the address you use to open FinancialOS, for example `https://financialos.example.test`, and save it.
   Chrome asks whether to allow access to that one site; choose **Allow**. Without it the extension cannot reach
   your server.
3. Give this browser a short name you will recognise in the device list, then **Start pairing**. A code such as
   `K7M2-9QX4` appears.
4. In FinancialOS, sign in and open **Settings → Devices → Pair a device**. Type the code. You type it yourself;
   it is never put in a link.
5. Approve it, choosing how long the device's access should last. The extension notices within a few seconds and
   confirms that the browser is paired.
6. Open a new tab.

The code is valid for ten minutes and only once. The extension proves it is the same installation that started
the pairing (a PKCE-style challenge), so a code seen by someone else cannot be used from another browser. Five
wrong attempts deny the pairing.

Amounts stay hidden until you allow them: **Settings → Devices → this device → amount visibility**.

## Moving FinancialOS to another address

The credential is bound to the address it was issued for, and it is never sent anywhere else.

1. In FinancialOS, revoke the old device (**Settings → Devices**).
2. In the extension options, choose **Change address**. It warns you, deletes the stored credential, asks Chrome
   for the new origin, and releases the old one.
3. Pair again.

The extension's ID does not change, so `allowedExtensionIds` on the server stays the same. See
[DOMAIN_MIGRATION.md](DOMAIN_MIGRATION.md).

## Server configuration

The API answers `/api/ext/*` only for extension origins it knows. Add the ID to the app configuration:

```json
{ "allowedExtensionIds": ["pafnoebiamkedmcabfalnpbkjilpoajo"] }
```

The server turns each ID into `chrome-extension://<id>` and checks the request's `Origin` against it. An
extension whose ID is not listed gets `403` and the options page says so in those words.

## How the extension ID is derived

Chrome derives an unpacked extension's ID from the `key` field in the manifest: it takes SHA-256 of the DER
SPKI public key, keeps the first 128 bits, and maps each hex digit `0–f` onto the letters `a–p`. Because the
public key is in the manifest, the ID is the same on every computer and every reinstall — which is what makes
`allowedExtensionIds` workable at all.

`apps/extension/scripts/init-key.mjs` sets this up once:

- it generates an RSA key pair if there is none;
- the **private key is written only to `/srv/projects/financialos/secrets/extension-key.pem`**, outside this
  repository, with mode `0600`, and an existing file is never overwritten (override the path with
  `FOS_EXTENSION_KEY_PATH`);
- the public key goes into `manifest.template.json`, and the derived ID into `apps/extension/EXTENSION_ID.txt`.

The private key is only needed to sign a `.crx`. The unpacked build and the ZIP do not use it.

## Build and verify

```bash
npm run build -w apps/extension      # -> apps/extension/dist (load unpacked)
npm run package -w apps/extension    # -> apps/extension/release/financialos-newtab-<version>.zip + .sha256

npx tsc -p apps/extension/tsconfig.json --noEmit
npx eslint apps/extension
npx vitest run --project unit apps/extension

# Runtime test: drives the built extension in Chromium against a local mock FinancialOS.
npm run build -w apps/extension
npx playwright test -c tests/extension/playwright.config.ts
```

The build fails, rather than warns, if the output contains `eval(`, `new Function`, a string timer, an
`innerHTML` assignment, `chrome.storage.sync`, an external-messaging listener, a URL literal naming a remote
host, an inline `<script>` or `style=` attribute, a remote stylesheet or font, an icon SVG carrying script or a
reference to another file, an unexpected file type, or a manifest that has drifted from the policy above.

Before release, the artefacts are scanned like any other:

```bash
node scripts/privacy/privacy-check.mjs --dir apps/extension/dist
bash scripts/privacy/secret-scan.sh --dir apps/extension/dist
```

## Limitations

- **Chrome and Chromium desktop only.** Extensions with a new tab override do not exist on mobile Chrome, and
  this one is not published to the Chrome Web Store.
- **Not available in incognito.** The manifest declares `"incognito": "not_allowed"`, so it never runs in a
  private window and Chrome offers no toggle for it — an incognito new tab is Chrome's own. This is deliberate:
  a private window should not show your finances.
- **Unpacked installs show a warning.** Chrome may show "Disable developer mode extensions" on start-up and asks
  again after some updates. That is Chrome's standard behaviour for unpacked extensions, not a fault.
- **Keep the folder.** Deleting or moving the unzipped folder disables the extension.
- **Automation caveat.** Branded Google Chrome ignores `--load-extension` for automated runs. The runtime test
  therefore uses Playwright's Chromium build. It also pre-grants the site permission in the test profile,
  because `chrome.permissions.request()` opens a native confirmation bubble that a headless browser cannot
  answer; the request-and-denial code path is covered by unit tests instead.
- **Not installed anywhere by default.** Nothing installs this for you, on any machine.

## Troubleshooting

| What you see                               | What it means                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| "Connect FinancialOS"                      | No address saved yet. Open the options page.                                                                        |
| "Chrome did not allow access to …"         | The site permission was declined. Try again and choose Allow.                                                       |
| "FinancialOS refused this extension" (403) | The extension ID is not in `allowedExtensionIds` on the server.                                                     |
| "Pairing ended — pair again"               | The device was revoked or its access expired. The stored credential has already been deleted.                       |
| "Pair again for the new address"           | The saved address is not the one this browser was paired with. The credential is never sent to a different address. |
| "FinancialOS is out of reach"              | The server did not answer. No figures are shown; a new tab tries again later.                                       |
| "Your glance has expired"                  | The last summary is past its validity and a fresh one is not due yet.                                               |
