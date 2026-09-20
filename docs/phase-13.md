# Phase 13: relayer connectivity regression

Registration had gained a blocking health check that called the relayer from the browser.
Any fetch failure was labelled offline, including browser origin and loopback failures.
A successful terminal curl therefore did not prove that registration could reach the server.
The checker already used HTTP status only; it did not reject the health response body.

The browser now uses /api/relayer/health and /api/relayer/relay on the website origin.
Next.js forwards these two fixed paths to the configured relayer. Failed upstream requests
still fail the health check. Signed payloads and contract checks remain unchanged.
Restart Next.js after editing demo/.env.local. npm run dev now works from the root.

An older root .env.local also shadowed the configured root .env, using a different payer
and missing the public RPCs. The relayer now prefers root .env, with .env.local as fallback.
Startup prints the selected filename, chain IDs and port, with no key or RPC values.

Tests: 209 passed, one optional vector-key test skipped; demo lint and typecheck passed.
Live local health returned HTTP 200 directly and through the website gateway.
Chromium showed online on localhost, 127.0.0.1 and 127.0.0.2 with zero page errors.
On the third origin the old cross-origin check failed; the gateway passed. A simulated
502 correctly showed offline. Browser tooling was temporary, outside project dependencies.
Public registration still requires the owner's current browser mandate signature.
