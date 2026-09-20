# Phase 15: confirmed transfer reporting

The reported Base Sepolia transfer succeeded in block 47058111.
The page then failed to read that block for the local spending tracker.
This made a successful payment appear to have failed.

The page now logs receipt success before updating the local tracker.
It reads the exact receipt block by hash and retries a missing block three times.
If tracking still fails, the page warns that payment succeeded and must not be resent.
It never invents a timestamp or resubmits a payment during these retries.
The local tracker may be incomplete after a warning; contract limits still apply.

Four regression tests cover delayed blocks, exhausted retries, other RPC errors,
and local recording errors. Demo lint and both TypeScript checks pass.
Full SDK suite: 213 passed, one optional signing-vector test skipped.
This shell required Foundry on PATH and Node's global Web Crypto flag for tests.
The RPC now returns both the successful receipt and its block.
The original transient RPC response cannot be reproduced live; tests simulate it.
