# Changelog

## total-recall (Tatum × Walrus Memory build window, from 2026-10-20)

- `src/chain.js` — read-only Sui client over Tatum RPC: Walrus epoch, memory blobs owned by the account, MemWal metadata per blob, find a blob by `blob_id` / `memwal_job_id`, balances. Throttled + retries on 429.
- `src/proof.js` — confirms each taught memory on chain (certified `Blob` object) and logs a proof record to `logs/proof.jsonl`.
- `src/ops.js` — admin health report: blob count/size, uncertified blobs, expiry warnings by epoch, WAL/SUI balance, RPC stats. `node --env-file=.env src/ops.js [--json]`.
- Teaching flow (`assistant.js`, `index.js`, `format.js`): after "✅ Đã học", the bot sends a follow-up "🔒 Đã lưu chắc chắn" only when the memory is confirmed on chain, or asks the user to teach again if it is not.
- Config: `TATUM_API_KEY`, `TATUM_SUI_RPC`, `WALLET_ADDRESS` (optional). Without a Tatum key the bot behaves exactly as before.

## v1 (Walrus Session 8, 2026-10-09)

- Support-team chatbot with shared memory on Walrus Memory (MemWal). See README.
