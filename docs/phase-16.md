# Phase 16: registration fees and pending status

The Sepolia registration was pending because its fixed gas price fell below the base fee.
Its mandate was still valid, so the same call was simulated and replaced at nonce 5.
The replacement succeeded in block 11742686, using 182994 gas.
Replacement hash: 0x38c092b2fa571759b41cbbce20a1be81f11fc33c0a2b2050e47c101b5710cade

New relayer submissions use EIP-1559 fees: twice the current base fee plus the suggested tip.
The configured fee ceiling still applies. The local relayer was restarted with this change.
This gives fees room to rise but cannot guarantee confirmation during every fee spike.
Automatic replacement is not enabled; the existing transaction was replaced once.

Registration timeouts now show “still pending / check again” and retain the transaction hash.
Retry checks the existing transaction without submitting or revalidating an old signed call.
Actual reverted receipts still show failure. A fresh page loses its in-memory session key.
Use the existing tab's registration retry button to read the confirmed mandate state.

Tests: 218 passed, one optional signing-vector test skipped.
Both TypeScript checks and demo lint passed; integration tests verify EIP-1559 transactions.
