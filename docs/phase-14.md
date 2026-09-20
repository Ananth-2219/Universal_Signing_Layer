# Phase 14: browser relayer submission receiver

The registration POST called native fetch as input.fetchImpl(...). That sets its receiver
to the options object. Chromium rejects it with Illegal invocation before making a request.
The health check used a standalone call, so it could pass while every registration failed.

postRelay now extracts fetchImpl and invokes it as a standalone function. Signed payloads,
relayer routing, contract interfaces and all signature and spending checks are unchanged.
The unregistered-session message now refers to the mode-neutral Register / retry button.

Chromium reproduced the exact old exception. The fixed helper reached the real relayer,
which correctly rejected an intentionally invalid request without sending a transaction.
The regression test now asserts that the fetch receiver is undefined, matching the fix.
SDK suite: 209 passed, one optional vector-key test skipped. Demo lint and typecheck passed.

Retry registration with the current signed mandate if the tab still holds its session key.
After a reload, generate a fresh key and sign again. Wait for registration confirmation
before transferring. Relayer Mode needs no MetaMask transaction popup; Direct Wallet Mode
opens MetaMask because the wallet submits and pays gas for the outer transaction.
