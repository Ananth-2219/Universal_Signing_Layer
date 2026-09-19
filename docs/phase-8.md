# Phase 8: minimal relayer

`relayer/` provides a small Node `http` server with `GET /health` and `POST /relay`.
It accepts only registration, session execution, and signed revocation for addresses
recorded in `deployments/`. Requests have bounded JSON bodies, strict argument checks,
a per-IP in-memory limit, and a per-chain gas-price cap.

Before sending, it calls the exact encoded transaction with `eth_call`. A failed
simulation returns only a generic error and is never sent. The relayer does not log
keys, signatures, request payloads, or RPC URLs.

Validation: `npm test` covers a valid relayed execution, rejected simulation, unknown
account, disallowed function, and rate limiting on temporary Anvil nodes.

Limit: the relayer can censor or delay a request, and its memory rate limit resets on
restart. It cannot alter signed operations or bypass the account's on-chain limits.
