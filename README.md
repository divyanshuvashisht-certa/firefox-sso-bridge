# Firefox SSO Container Bridge — prototype

This add-on uses Firefox's native Container Tabs instead of faking cookie isolation. For a supported Google OAuth authorization-code login, it opens Google in Firefox's default cookie store (where the ordinary Workspace login exists) and returns the final callback URL to the original container.

## Temporary add-on

1. Open Firefox and login to your `getcerta` gmail account.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on** and select `firefox-sso-bridge/manifest.json`.
4. Create a container, open the relevant Certa client URL inside it, and initiate Google SSO.

## Technical Details - In case you want to contribute or suggest changes and work on the project with me 

- Only `accounts.google.com` and `accounts.google.co.in` authorization endpoints are handed off.
- Only HTTPS callback URLs under `*.certa.in` or `*.certaqa.com` are accepted.
- Requires a top-level, query-string OAuth/OIDC authorization-code callback containing `state`. `form_post`, fragment/implicit callbacks, popup-only flows, or state-less flows are refused unchanged.
- Google cookies are never read, copied, modified, or sent through a proxy.

Do not use this for production until it has been validated against every supported client login flow and reviewed by your security team. It is an OAuth navigation bridge, not a general-purpose SSO bypass.
