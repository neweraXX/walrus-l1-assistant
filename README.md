# L1 Assistant — a support-team chatbot that remembers (Walrus Memory)

A Zalo group chatbot for an **L1 application-support team** (sales-force app for a beverage
distributor in Vietnam). It answers "how do I handle error X / who do I escalate to" from the
team's runbooks, and — the reason it exists — it **remembers across shifts, people and devices**
using [Walrus Memory (MemWal)](https://github.com/MystenLabs/MemWal) on Walrus **mainnet**.

> Built for **Walrus Sessions 8: Chatbots That Remember**. LLM: **Google Gemini**
> (`gemini-3.5-flash-lite` main, `gemini-3.6-flash` / `gemini-3.5-flash` fallback) through the
> OpenAI-compatible endpoint — no Claude/GPT in the runtime.

> ⚠️ **All data in this repo is fictional.** "Sunrise Beverages", the "FieldGo" app, "NovaSoft",
> every SR/outlet/phone/email in `mock-sharepoint/` and `mock-data/` is made up. The production
> deployment runs the same code against the team's real (private) runbooks, which are not published.
> The bot talks Vietnamese because the team does; code comments are Vietnamese without diacritics.

## The problem

L1 support takes calls and mails from field sales reps (SR) all day, in shifts. Context falls through
the cracks:

- A rep calls back; whoever picks up has no idea what the previous agent already did.
- Shift handover happens by voice/chat → promised call-backs get forgotten.
- The same "where is the runbook for X, who do I escalate to" questions, every day.
- A teammate finds a new fix; two weeks later nobody remembers who knew it.

## What memory changes (before → after)

| Situation | Without memory | With Walrus Memory |
|---|---|---|
| Rep SR-1042 calls back, a different agent answers | Asks the rep to explain everything again | "SR-1042 has history?" → yesterday's case, already escalated to DMS team, waiting for reply |
| Afternoon shift starts | Verbal handover, things get missed | "What did the morning shift hand over?" → open cases + promised call-backs |
| Teammate discovers a fix not in the docs | Lives in one person's head | They just tell the bot; it normalises the fix, stores it, and answers the next person with **who taught it and when** |
| Bot answers wrong | Same wrong answer forever | Anyone replies with the correction (no command needed); it is linked to the exact question + runbook it corrects |
| Three reps report the same error within an hour, to three different agents | Nobody sees the pattern | Shared case log → "⚠️ possible widespread incident: 3 SRs, same error" |
| A discussion spans 30 messages | Next week it's gone | When the chat goes idle, each topic is summarised into a long-term memory for that group |

`demo-scenarios.md` has the scripted versions; `node src/demo.js` replays them on mainnet.

## Architecture

```
Zalo group / DM ──► index.js (long-poll Zalo Bot API)
                        │
HTTP /ask (localhost) ─►│  httpServer.js  (same brain, used by the team's production bot)
                        ▼
                 assistant.js
   ┌───────────────────────────────────────────────────────────┐
   │ 1. Router (LLM): ask / teach / weather / tool? which topic │
   │ 2. Parallel recall from Walrus namespaces (5 s budget)     │
   │ 3. Answer as strict JSON → code renders the Zalo message   │
   │ 4. Guards: no source → "not documented, teach me";         │
   │    unknown URL → reject; numbers must exist in tool output │
   └───────────────────────────────────────────────────────────┘
        │ remember / recall / analyze                 │ fallback
        ▼                                             ▼
  Walrus Memory relayer (mainnet, SEAL-encrypted)   kb-cache/*.json (BM25, offline)
```

### Memory namespaces

Every memory is stamped `[YYYY-MM-DD HH:mm] [author] [codes] text`, so recall results carry
who/when/which customer without extra metadata.

| Namespace | What it holds | Written by |
|---|---|---|
| `<prefix>:kb` (versioned `kb:vN`) | Runbook chunks (one per heading / per workflow) | `npm run index-kb` |
| `<prefix>:team:knowledge` | Fixes the team taught the bot (normalised + original wording) | `dạy:` or auto-detected teaching |
| `<prefix>:team:handover` | Shift handovers | `bàn giao: …` |
| `<prefix>:team:caselog` | Call/mail log, used by the incident detector | `log: …` |
| `<prefix>:customer:<code>` | History per rep/outlet/distributor code (SR-, OUT-, NPP-) | handover + log, fan-out by code |
| `<prefix>:personal:<userId>` | Private notes per person | `ghi nhớ: …` |
| `<prefix>:chat:<chatId>` | One summary per topic when a conversation goes idle (10 min) | automatic |
| `<prefix>:team:auto` | Facts extracted by MemWal `analyze()` from questions | automatic |

### Two layers of memory

1. **Short-term, per chat** — the last turns of the current conversation (kept verbatim, split
   into topics because two people often ask about two things at once). Persisted to
   `state/` on every message so a restart/deploy doesn't lose the thread.
2. **Long-term, on Walrus** — when a chat is idle for 10 minutes, each topic is summarised by the
   LLM into ≤ 3 sentences *only if worth keeping* (decision, known issue, tracked case,
   workaround, preference), with an expiry for case-type memories. Phone numbers/emails are
   stripped before storing.

### Teaching loop (how the knowledge grows)

1. Someone corrects or adds a fix in plain chat — no command needed; the router decides it is
   teaching and which pending question it answers.
2. A stronger model normalises it into *situation → steps → escalate → note*, and decides whether
   it is a **small patch** of an existing workflow (old → new phrase) or a **new branch**.
3. Stored in `team:knowledge` (and appended to a review file). Teachings from approvers
   (`KB_APPROVERS`) are used directly; others are shown as a yellow "not yet approved" note
   when they conflict with the official runbook.
4. Weekly, a human merges approved items into the runbooks and the KB is re-indexed into a
   **new versioned namespace** (`kb:v5` → `kb:v6`) — Walrus Memory is append-only, so a pointer
   file (`kb-version.json`) switches the bot to the new version with no restart, and a hash list
   (`kb-cache/live-chunks.json`) filters out stale chunks.

### Reliability

The relayer is sometimes slow (we measured recall 0.7–13 s, plus 502/504 `RECALL_TIMEOUT` at the
`seal_decrypt` stage). So every recall has a 5 s budget and one retry; if the docs store fails,
the bot searches an offline BM25 copy of the same chunks (`kb-cache/`) and says so in the answer
("(bản dự phòng)") instead of pretending nothing exists.

## Run it (everything inside Docker — nothing installed on the host)

```bash
cp .env.example .env            # MemWal key + account id, LLM endpoint/key, (optional) Zalo token
docker compose build

# offline tests (fake LLM + fake memory, no network calls)
docker compose run --rm l1-assistant node src/selftest.js
docker compose run --rm l1-assistant node test/smoke-agent.mjs

# connectivity check; --write stores 1 test memory on mainnet
docker compose run --rm l1-assistant node src/check.js --write

# load the (fictional) runbooks into Walrus Memory
docker compose run --rm l1-assistant node src/kbIndex.js

# chat in the terminal, no Zalo needed ("/as Chi" switches user)
docker compose run --rm l1-assistant node src/cli.js An

# replay the before/after scenarios on mainnet (uses a throw-away namespace)
docker compose run --rm l1-assistant node src/demo.js

# run the Zalo bot
docker compose up -d && docker compose logs -f
```

Every answer is logged to `logs/usage.jsonl` with its **provenance** (namespace, blob id,
distance, author, approved or not) — that is how "why did the bot say v5.9.0?" gets debugged.

## Chat commands (Vietnamese)

| Type | Effect |
|---|---|
| any question | search runbooks + memory, answer with source |
| `bàn giao: CS-0924-003 waiting L2, call SR-1077 back at 16:00` | shift handover |
| `log: SR-1042 order OUT-0007 not in DMS, sent to DMS team` | case log + incident check |
| `dạy: …` (or just say it) | teach a fix |
| `ghi nhớ: …` | private note |

## Files

| Path | Role |
|---|---|
| `src/assistant.js` | router, recall, answer, teach, session memory, guards |
| `src/memory.js` | MemWal wrapper, namespaces, stamp/parse header |
| `src/llm.js` | OpenAI-compatible client with fallback + 429 cooldown |
| `src/localKb.js` | offline BM25 fallback, live-chunk filter, per-chunk dates |
| `src/kbIndex.js` / `src/indexDocs.js` | chunk docs and load them into Walrus |
| `src/incident.js` | widespread-incident detector over the shared case log |
| `src/httpServer.js` | localhost API (`/ask`, `/ask-image`, `/taught`, `/eval`) |
| `src/eval.js` | nightly regression run, LLM-judged against must / must-not points |
| `src/index.js`, `src/zalo.js`, `src/format.js` | Zalo transport + message formatting |

Not included: the production runbooks, the eval question set (built from real cases) and the
read-only Jira / call-center tool service (holds internal tokens). Tool questions are disabled
unless `TOOL_URL` is set.

## Model & runtime (Beyond the Big Two)

- **Model:** Google Gemini — `gemini-3.5-flash-lite` (router + answers), `gemini-3.6-flash` /
  `gemini-3.5-flash` (fallback, second opinion, teach normalisation, eval judge).
- **Runtime:** Gemini's OpenAI-compatible endpoint
  (`https://generativelanguage.googleapis.com/v1beta/openai/`) through the Vercel AI SDK
  (`ai` + `@ai-sdk/openai-compatible`), Node.js 22 in Docker / systemd on a Linux VPS.
  Embeddings are done by the Walrus Memory relayer, not by us.
- **Friction in this environment and what we did:**
  - Flash-lite often returns *almost*-JSON (unescaped quotes inside strings, `,,`, extra `}}`);
    once the raw JSON leaked into the group chat. `parseJson()` in `assistant.js` repairs quotes
    and commas, trims trailing braces, and never sends raw JSON to users.
  - Free-tier 429 / 503 under load: `llm.js` puts a model on a 2-minute cooldown and falls
    through to the next model instead of letting the SDK retry for ~16 s.
  - Flash-lite says "not documented" even when the right workflow is in the prompt → if
    retrieval found something, ask the stronger model once (`secondOpinion` in the usage log).
  - The lite model almost never chooses to ask a clarifying question by itself, so "ask one
    question first, or answer all branches?" is a separate small LLM call (`maybeClarify`).
  - Gemini latency + relayer recall latency add up: recalls run in parallel with a 5 s budget so
    the slow store never blocks the answer.

## MemWal friction we hit

Reported/collected while building (SDK `@mysten-incubation/memwal@0.1.8`):
no delete/forget (worked around with versioned namespaces + live-chunk filter), bulk limit of
20 items not validated client-side, recall timeouts in `seal_decrypt`, no default relevance
threshold (we use `maxDistance` 0.45–0.6 per store). See the issues on
[MystenLabs/MemWal](https://github.com/MystenLabs/MemWal/issues).

## License

MIT
