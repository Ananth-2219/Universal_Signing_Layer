# Phase 2: EVM session keys

A session key is a temporary signing key generated randomly in the browser.
It is independent of the master key, any seed, and any mnemonic.
One session address can be used in grants on every EVM chain.

`sdk/src/keys/sessionKey.ts` creates a checksummed address and signing methods.
The private key stays inside a closure and is never returned or serialized.
JSON, string conversion, Node inspection, and console logging show only the address.
It can sign a raw 32-byte digest or standard EIP-712 typed data through viem.
Signing requires an explicit Unix-second time: expiry equal to now is expired.
Destroying the key prevents subsequent signing and drops its stored reference.
JavaScript cannot guarantee physical memory erasure or cancel signing already started.

`store.ts` holds one key in memory. Its default clock uses current Unix seconds;
tests can inject a clock. Getting an expired or destroyed key clears the store.
Assumption: the store owns its key, so clearing/replacing it destroys the old key.
`sessionKeyAddressForGrants(store)` returns its address or throws if no key is usable.
`index.ts` exports these APIs. No Phase 1 code or dependencies were changed.

Memory disappears when the page reloads; persistence is deferred to Phase 9.
This module does not send transactions or enforce grant spending limits.
Production keys never leave memory. Tests mock the generator only to check leaks;
their private bytes are never logged, hardcoded, or written to files.

From the repository root, run `npm test` and `npx tsc --noEmit`.
Tests cover signature recovery, typed-data verification, expiry, destruction,
safe display, memory-store cleanup, and the shared address across EVM grants.
