# Domain migration

FinancialOS starts on a private tailnet origin, for example `https://<node>.<tailnet>.ts.net:8443`. This guide
moves it to a custom domain such as `https://finance.example.com`. The app stays **private**: a custom domain
changes the name, not who can reach it.

Settings → System → Domain and Access shows the current canonical origin, route health, callback URLs and
extension origins. `POST /api/system/domain-migration/plan` validates a proposed origin and returns the same
checklist as below. FinancialOS never changes DNS, certificates or Tailscale configuration by itself.

## 1. Before you start

* Choose a host name dedicated to FinancialOS.
  * Browsers share cookies across every port of a host.
  * WebAuthn binds passkeys to the host name.

  A dedicated name keeps both from being shared with other apps
  (see [OPERATIONS.md](OPERATIONS.md#same-host-trust-boundary)).
* Keep access private. Suitable options:
  * the DNS name resolves only inside the tailnet (split DNS), or to the node's tailnet address;
  * a reverse proxy that accepts only tailnet or VPN clients;
  * Tailscale Serve for a Tailscale service name.

  Do **not** publish the app on the public internet or use Tailscale Funnel.
* The domain needs a valid TLS certificate for that exact name, issued by whatever terminates HTTPS in front of
  `127.0.0.1:3180`. Never use self-signed certificates that users are trained to click through.
* Sign in once and confirm that **password + TOTP** works and that your **recovery codes** are at hand.
* Take a backup: `deploy/scripts/backup.sh`.

## 2. DNS and the HTTPS front end (outside FinancialOS)

Make these changes with your own DNS and proxy tooling:

1. Point the name at the private address, or set up the tailnet DNS record.
2. Configure the HTTPS front end to proxy to `http://127.0.0.1:3180`. The app port stays loopback-only.
3. Confirm that `https://finance.example.com/healthz` returns 200 from a device on the private network, with a
   valid certificate.

## 3. Origin configuration

Add the new origin and keep the old one allowed during the transition:

```bash
deploy/scripts/write-config.sh --force \
  --origin https://finance.example.com \
  --extra-origin https://<node>.<tailnet>.ts.net:8443 \
  --extra-origin http://localhost:3180
deploy/scripts/start.sh --restart app
```

* The canonical origin is used for the passkey relying-party ID, for OAuth callback URLs (unless
  `--oauth-base` says otherwise), and for links and redirects.
* Every mutation must carry an `Origin` that exactly matches one of `allowedOrigins`. Plain `http` is accepted
  only for loopback (the SSH tunnel).
* Cookies are host-only (`__Host-` prefix). Sessions on the old origin do not carry over, so sign in again on the
  new origin.

When the new origin works, remove the old one by re-running `write-config.sh --force --clear-extra-origins` with
only the origins you still need, then restart the app.

## 4. OAuth provider callbacks

For every connection that uses OAuth, add the new callback URL in the provider's developer console before
switching, then remove the old one afterwards. The URL is shown on the connection's page:

```
https://finance.example.com/api/oauth/callback
```

If a callback no longer matches, the provider rejects the authorisation. Re-authorise the affected connection
from its page after the change. Stored tokens keep working until they expire, because refresh tokens are not tied
to the redirect URL at most providers. Check each connection's status after the switch.

## 5. Browser extension

The extension talks to one origin and holds a device credential issued for it.

1. In **Settings → Devices**, revoke the old pairing (or let it expire).
2. In the extension options, change the server origin to the new one. Chrome asks for host permission for that
   origin.
3. Pair again. The app shows a user code, and you approve it in an authenticated session.

The extension's own ID does not change, so `allowedExtensionIds` stays the same.

## 6. Passkeys: consequence of the relying-party ID

WebAuthn credentials are bound to the host name they were created on. **Passkeys enrolled on the old host name do
not work on the new one.** This is a browser rule and cannot be configured away.

* **Password + TOTP keeps working** on the new origin, and so do the recovery codes. This is why they are
  mandatory.
* After signing in on the new origin, open **Settings → Security** and enrol a new passkey. Then remove the old
  passkeys: they are useless on the new origin, and removing them keeps the list honest. At least one factor must
  remain.
* If you move back to the old origin, the old passkeys work there again, as long as you did not remove them.

## 7. Checklist

| Step | Done by |
|---|---|
| Backup taken, password + TOTP and recovery codes confirmed | owner |
| DNS or tailnet record and HTTPS front end for the new name; private reachability tested | owner |
| `write-config.sh --origin <new> --extra-origin <old>` and app restart | operator |
| OAuth callback URLs added at each provider | owner |
| Sign in on the new origin; enrol a new passkey | owner |
| Extension re-pointed and re-paired | owner |
| Old origin removed from config; old passkeys and pairings removed; old callback URLs removed | owner and operator |
| Old Tailscale Serve entry removed if no longer used (`sudo tailscale serve --https=8443 off`) | owner |

FinancialOS does not change DNS records, certificates, provider consoles or Tailscale settings. Each of those
steps is performed by the owner with their own tools.
