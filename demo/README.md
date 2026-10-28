# Total Recall web demo

An English, responsive demo for fictional Sunrise Beverages support. Closed tickets teach issue categories automatically. Rules become usable with **at least 2 tickets and 60% agreement** on both route and recipient. Admins veto or reopen rules; there is no approval queue. All examples are synthetic.

## Local setup

Use Node 22 or newer and install the repository dependencies. From the repository root:

```sh
cp demo/.env.example demo/.env.local
# Fill in demo/.env.local with your demo account credentials.
node --env-file=demo/.env.local demo/dev-server.mjs
```

Open `http://localhost:3010`. The development server serves only the demo page and named API endpoints. It does not serve environment files, datasets with scoring labels, or repository source files. `npm run demo:web` runs the same server.

For port 3011, run `PORT=3011 node --env-file=demo/.env.local demo/dev-server.mjs`.

Starting the server does not seed memory. Visiting APIs that use memory, prediction or proof makes requests to the configured services. Tests use mocks and require no credentials or network.

## Seed once, explicitly

```sh
node --env-file=demo/.env.local demo/seed.mjs
# Equivalent if your environment file is at the repository root:
node --env-file=.env demo/seed.mjs
```

This is an intentional network operation using your demo Walrus Memory account. It feeds the 24 closed-ticket fixtures through `createEscalationLearner`, with a fake `ticket_da_dong` / `ticket_goi_y` gateway and deterministic fixture extraction. It writes six **English** routing-rule bundles to `demo:seed`, waits for the relayer jobs, checks proof through Tatum Sui gRPC and prints the rules plus object/transaction/end-epoch information. It never reads the holdout dataset or a private gateway.

The script checkpoints counted ticket keys in `demo/.seed-state.json`. A repeated run skips already-counted tickets. If an accepted relayer job failed, inspect the printed job first, then deliberately reseed with `--reset`. This checkpoint is only for the local seed script; web handlers never read or write local state. A successful seed is visible to every demo session through recall. Jobs that are still awaiting certification remain pending in the UI.

## Server environment

| Variable | Purpose |
| --- | --- |
| `LLM_BASE_URL` | OpenAI-compatible API base URL ending in `/v1` where required by your provider |
| `LLM_API_KEY` | Server-side prediction API credential |
| `LLM_MODEL` | Model used for both memory OFF and ON |
| `MEMWAL_PRIVATE_KEY` | Demo Walrus Memory account private key in the SDK-supported format |
| `MEMWAL_ACCOUNT_ID` | Demo MemWal account object ID |
| `TATUM_API_KEY` | Read access to Tatum Sui gRPC |
| `DEMO_COOKIE_SECRET` | Long random signing secret, identical on all deployed instances |
| `MEMWAL_SERVER_URL` | Optional; defaults to the Walrus Memory relayer |
| `TATUM_SUI_GRPC` | Optional; defaults to `https://sui-mainnet-grpc.gateway.tatum.io:443` |
| `WALLET_ADDRESS` | Optional; otherwise the account owner is resolved through gRPC |

Use the same demo MemWal account for seed and the deployed app. Keep credentials in server environment settings; the page receives only public proof IDs and signed, opaque session/job receipts. If `DEMO_COOKIE_SECRET` is omitted, signing uses `MEMWAL_PRIVATE_KEY`; set a separate stable secret for deployment.

## Vercel configuration

1. Import this repository and use **Root Directory = repository root**.
2. Choose the **Other** framework preset and Node 22 or newer. Use the repository's `vercel.json`: its build command copies `demo/public/index.html` into the `public` output directory. No frontend framework or CDN is needed.
3. Add the required server variables above to the intended Vercel environment. Seed locally against the same demo account before testing the deployed page.
4. Deploy when ready. No deployment is performed by the seed or development scripts.

Vercel discovers the root `api/[name].js` entry point, which delegates to the default exports in `demo/api/*.js`. `vercel.json` sets `maxDuration: 60` and includes the JSON fixtures in the function bundle. Scoring labels stay in server-only `demo/data/holdout.json`; there is no public dataset route for it.

## Persistence and request budgets

- **Source of truth:** Walrus Memory namespaces `demo:seed` and `demo:s:<signed-cookie-session>`. Every rules, memory-enabled answer and measurement request recalls and parses stored `Routing rule [Cn]` text. The parser also accepts the legacy Vietnamese heading. There is no process-memory rule store or job registry.
- **Learning:** a request classifies one closed ticket, recalls prior evidence, deduplicates its key and records the updated evidence and eligible rule in one accepted memory job. Insufficient or conflicting evidence is stored without publishing a rule. A newer insufficient-agreement snapshot suppresses an older trusted snapshot. Learning another ticket never overrides an admin veto.
- **Vetoes:** `Block rule` stores a session-scoped `#sai` equivalent; `Reopen rule` stores a `#mo` equivalent. They take effect when the memory job becomes indexed. Shared seed data is not changed by a visitor.
- **Proof:** the client saves opaque job IDs in local storage and polls `/api/proof?job=…`, at most two rules at once. A warm process shares one initialized chain adapter, its throttle and its complete owned-blob scan (60-second TTL measured from scan completion). Concurrent proof requests share the in-flight scan; no background task must survive a Vercel freeze. This avoids the independent scans that caused Tatum HTTP 429 during concurrent health/proof requests. Proof reads have a 45-second deadline that cancels active gRPC reads and returns `pending`, as do Tatum throttling and transient gRPC errors. Only a certified chain result earns the verified badge; confirmed results include the current Walrus epoch. `/api/proof?blobId=…` also works, after verifying that recall exposes the blob in the seed or visitor's session rules.
- **Recall limits:** queries request the 100 most recent matches in each demo namespace. The seeded set is small; this is an interactive demo, not an unbounded ticket archive. Walrus indexing is eventually consistent: wait for one teaching/veto job to finish before submitting the next dependent ticket.
- **Measure:** two LLM calls, one JSON-array prediction for all 10 tickets in each mode, plus at most one retry shared by failed modes (maximum three calls). Batch prompts specify an array schema with zero-based indexes, separately from the single-answer schema. Numeric-string indexes are normalized; complete arrays with missing indexes use position only when all explicit indexes agree with that order. Duplicates, ambiguous order, invalid predictions and incomplete arrays require the stricter retry. Both modes use the same model and routing instructions. Only summary and description go to the predictor; labels are used solely by server-side scoring. Recall for the 10 memory contexts runs concurrently. Each measurement call has a 14-second timeout and the whole handler has a 52-second deadline, below 55 seconds and within Vercel's 60-second budget. Invalid results after retry return an error, never a fabricated score.
- **Limits:** up to 120 API requests/minute/IP, four reserved LLM calls/minute per warm process and per IP, plus one Measure/minute/IP. Measurement reserves two calls initially and charges an additional call only if retry is needed and budget remains. The shared warm-process queue serializes prediction calls. Signed IP-bound budgets travel in an HttpOnly cookie and `X-Demo-Budget` request/response header; `X-Demo-Measure-After` and `Retry-After` expose cooldowns. Cookies/headers carry the measure limit across cold instances, including the retry charge. These limits are best effort across separate instances or clients that discard receipts; a strict global quota would require an external coordination service.
- **Health:** reads wallet blob count and current Walrus epoch through Tatum. The safe-until date estimates the earliest certified blob expiry using 14 days/epoch and is explicitly approximate.
- **Errors:** all API handlers use `console.error` with handler, stage, elapsed time, HTTP status and known transport codes/operations. Only allowlisted local messages are logged. Upstream messages, stacks, URLs, headers, keys, cookies and payloads are omitted; clients receive generic errors for upstream failures.

## API contracts

All endpoints return JSON and `Cache-Control: no-store`. POST bodies are limited to 12 KB.

| Endpoint | Request / response |
| --- | --- |
| `GET /api/tickets` | Synthetic closed-ticket templates for the teaching form |
| `GET /api/rules` | `{rules:[{id,category,system,route,target,confidence,count,total,examples,blocked,proof,jobId}],policy}`; pending proofs start as `null`, with a signed job ID for polling |
| `POST /api/learn` | `{ticket:{key,system,summary,description,route,target,resolution}}` → HTTP 202 `{jobId,status,learned,total,message}`; use a new fictional key for each closed ticket |
| `POST /api/block` | `{key,action:"block"|"open"}` → HTTP 202 `{jobId,status,action}`; use the rule's returned `key` |
| `POST /api/ask` | `{question,memory:true|false}` → `{route,target,confidence,reason,hint,rulesUsed}`; memory OFF never calls recall |
| `POST /api/measure` | `{}` → `{off:{accuracy,correct,total},on:{accuracy,correct,total},llmCalls,elapsedMs,details}` |
| `GET /api/proof?job=…` or `?blobId=…` | `{status:"pending"|"failed"|"confirmed",proof}`; confirmed responses include `{objectId,txDigest,endEpoch,currentEpoch,certifiedEpoch}` at the top level and in `proof`, plus `transport:"Tatum Sui gRPC"`; pending retries use `Retry-After: 5` when throttled or timed out |
| `GET /api/health` | `{epoch,blobCount,endEpoch,safeUntil,approximate,transport:"Tatum Sui gRPC"}` |

Session cookies isolate visitors' evidence and vetoes. Admin buttons are part of the public demo experience, scoped to each visitor's session.

## A 2–3 minute walkthrough

1. Open the seeded page. Show the automatically learned categories and the two-ticket/60% policy.
2. Ask the DistributorHub second-factor question with memory OFF, then ON. Point out the historical routing hint and receiving supplier.
3. Open Admin proof. Show the Suiscan object/transaction links, end epoch and Tatum verified badge. Block a rule, wait for indexing and show that it is excluded from L1's memory context. Reopen it with the adjacent button.
4. Click Measure to compare two real 10-ticket prediction batches. The two questions plus Measure use the four-call budget; wait for the next minute before teaching or rerunning.
5. Teach from an example with its automatically generated new key. For a new category, show that one ticket remains evidence and the second agreeing ticket activates a rule without admin approval. Keep the same browser session while jobs are pending.

Actual accuracy depends on the configured model. The UI does not prefill scores or claim improvement when the result does not show it.

## Offline checks

```sh
node --test test/*.test.mjs
```

Tests mock memory, prediction and chain transports, cover cold handlers, cookie/header limits, session isolation, automatic learning, admin vetoes, stateless proof, batch scoring and deadlines. Temporary test fixtures stay inside the repository's `.test-tmp/` directory and are cleaned by the tests. The seed script and configured live APIs are not executed by the suite.
