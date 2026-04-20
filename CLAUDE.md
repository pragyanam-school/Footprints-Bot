# Footprints Priya — WhatsApp AI Sales Bot

## Project Overview

Priya is a WhatsApp admissions bot for Footprints Preschool & Daycare. It collects key parent/child info, shows nearby centres using a live API, answers questions about programs/fees/curriculum, and escalates to a human agent when stuck.

**Stack:** Node.js + Express + Claude Sonnet 4.6 + Wati (WhatsApp Business API)

**Design philosophy:** Claude handles all language understanding. The server handles state, API calls, timeouts, and escalation. Nothing about language is hardcoded.

---

## File Structure

```
footprints-bot/
├── server.js          # Entire backend — bot logic, routes, state management
├── public/
│   └── index.html     # WhatsApp dark-theme test UI (for local testing)
├── .env               # API keys (never commit)
├── package.json
└── CLAUDE.md          # This file
```

---

## Environment Variables

```env
ANTHROPIC_API_KEY=       # Required — Claude Sonnet 4.6
WATI_API_TOKEN=          # Required for production — Wati Bearer token
WATI_SERVER_ID=          # Required for production — Wati server number
PORT=3000                # Optional, defaults to 3000
```

---

## Running Locally

```bash
npm install
npm start
# Test UI: http://localhost:3000
# Health:  http://localhost:3000/health
```

---

## Architecture

### The Two-Call Pattern Per Turn

**Call 1 — Extraction** (fast, JSON output, runs every turn)

A dedicated Claude call that reads the parent's raw message and returns structured JSON. The server uses this JSON to update state — no regex, no hardcoded city lists, no keyword matching anywhere in the codebase. Claude handles all language understanding naturally.

```json
{
  "childName": "Priyu",
  "childAge": "3 years",
  "city": "Noida",
  "area": "Sector 50",
  "program": "Daycare",
  "intent": "general",
  "concernMenuAnswer": null,
  "isNegativeResponse": false,
  "extractedAreaFromPhrase": null,
  "isMetaQuestion": false
}
```

**Call 2 — Response Generation**

The main Claude call with full system prompt + conversation history + injected fee data. Skipped when server generates a deterministic reply.

### What the Server Owns (deterministic only)

- **State machine** — tracks what has been collected, what hasn't
- **Conversation sequence** — enforces Name → Age → Program → Concern → City → Area → API
- **API calls** — centres fetch when city + area are known
- **Fee injection** — always injects fee data when centres are loaded
- **Concern menu** — fires as a separate message the turn program is first known
- **Escalation** — timeout, stuck detection, max turns, human handoff
- **Response timeout** — hard 20-second clock on every turn

### What Claude Owns (all language)

- **Entity extraction** — name, age, city, area, program from any phrasing
- **Intent classification** — fee, booking, general info, meta-question, concern answer
- **Response generation** — warm, contextual replies using injected knowledge

---

## State Object

```js
{
  parentName, childName, childAge, program, city, area,
  centersData,          // full API response — persists until city changes
  centersShown,
  concernAsked,         // true once concern menu has been sent
  concern,              // 'curriculum' | 'safety' | 'food' | 'cctv'
  nameAttempts,         // turns where name not extracted (max 3)
  ageAttempts,          // turns where age not extracted (max 3)
  failedAreaFetches,    // consecutive 0-result API responses
  stuckCount,           // turns with city but no area extracted
  humanTakeover,
  _concernMenuJustSent, // true for one turn after menu fires
  _concernJustDetected, // true for one turn after concern answered
}
```

> In production, replace in-memory `conversations` object with Redis.

---

## Mandatory Conversation Sequence

```
1. Child Name   → extraction detects. 3 turns max, then escalate.
2. Child Age    → extraction detects. 3 turns max, then escalate.
3. Program      → extraction detects. Claude asks naturally if unknown.
4. Concern Menu → server fires as separate message when program first known. Call 2 skipped.
5. Concern Ack  → server sends CONCERN_ACK template. Call 2 skipped.
6. City         → extraction detects from any phrasing or spelling.
7. Area         → extraction detects. Handles abbreviations, landmarks, phrases.
8. API Call     → fires when city + area both known.
9. Show centres → Call 2 formats verbatim from injected data.
10. Fees        → Call 2 uses injected fee data. Never invents numbers.
11. Visit booking
```

---

## Server Bypasses (Call 2 skipped)

| Turn | Condition | Server Reply |
|------|-----------|--------------|
| Name attempts 1–3 | child name not extracted | Fixed polite ask |
| Age attempts 1–3 | child age not extracted | Fixed polite ask |
| Concern menu fires | program just detected | `"Great — [program] for [child] it is! 👍"` + concern menu as separate bubble |
| Concern just answered | `concernMenuAnswer` 1–4 detected | Pre-written CONCERN_ACK template |
| Timeout (20s) | processMessage hung | Warm escalation message |
| Meta-question | `isMetaQuestion: true` from extraction | Warm deflection + escalate |

---

## Centres API

```
GET https://www.footprintseducation.in//nearest-centers?q={area}+{city}
```

Returns JSON array of centre objects with:
- `Webpage_Title` — display name (**use verbatim, never rename**)
- `Center_Address`, `Center_Map_Address`
- `Calculeted_Radius_Text` — distance string
- `Center_Feecard_List` — nested V1/V2 fee structure per program

**Fee plans:**
- **V1 Long Term** — lower monthly + ₹16,000 annual. Better for 6+ months.
- **V2 Short Term** — zero annual, higher monthly. Better for flexibility.

Fee data injected into every Call 2 when `centersData` exists — not gated on parent asking.

---

## Escalation Logic

| Trigger | Condition |
|---------|-----------|
| Name never extracted | `nameAttempts >= 3` |
| Age never extracted | `ageAttempts >= 3` |
| Area unresolvable | `stuckCount >= 2` with city known |
| 0 API results | `failedAreaFetches >= 2` |
| Meta-question | `isMetaQuestion: true` from extraction |
| Response timeout | 20 seconds exceeded |
| Max turns | Turn 20+ with no visit booked |

**Parent sees:** *"I want to make sure I find the absolute best option for you and [child]. Let me loop in one of our senior admissions counsellors who knows our centres inside out — they'll be able to help you right away. 😊 Someone from our team will be with you shortly!"*

**Wire before go-live:**
```js
// notifyStuck() → POST to Slack webhook / ops dashboard
// triggerHumanTakeover():
await axios.post(
  `https://live-server-${WATI_SERVER_ID}.wati.io/api/v1/conversations/${waId}/unassign`,
  {}, { headers: { Authorization: `Bearer ${WATI_API_TOKEN}` } }
)
```

---

## TODO Before Production

- [ ] Replace `WELCOME_KIT_VIDEO_PLACEHOLDER` in system prompt with real YouTube video ID
- [ ] Wire `notifyStuck()` — Slack webhook or ops dashboard
- [ ] Wire `triggerHumanTakeover()` — Wati unassign API call
- [ ] Wire `crmUpdateLead()` — push to your CRM
- [ ] Replace in-memory `conversations` with Redis
- [ ] Set `WATI_API_TOKEN` and `WATI_SERVER_ID` in production `.env`

---

## Terminal Log Guide

| Symbol | Meaning |
|--------|---------|
| `🧩` | Extraction call result |
| `✅` | Value stored / check passed |
| `❌` | Null extracted / fetch skipped |
| `📤` | Server bypass — Call 2 skipped |
| `🔴` | Escalating to human |
| `🔁` | Awaiting flag / counter incremented |
| `🚀` | Centres API call firing |
| `⏰` | Timeout / auto-nudge |
| `🎯` | Next step injected to Claude |

**Section order per turn:**
`STATE AT TURN START` → `TAKEOVER CHECK` → `EXTRACTION CALL` → `STATE UPDATE` → `CHILD NAME COLLECTION` → `CHILD AGE COLLECTION` → `CONCERN MENU` → `SERVER BYPASS CHECK` → `AREA FETCH DECISION` → `SYSTEM PROMPT INJECTION` → `RESPONSE CALL` → `PRIYA REPLY` → `STATE AFTER TURN`

---

## Model

`claude-sonnet-4-6` — handles ambiguous Indian names, city spellings (bengaluru/blr/bangalore), area abbreviations (hsr/btm/ecr), and natural phrasing reliably. Response timeout: 20 seconds.

---

## Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/webhook/wati` | POST | Real WhatsApp — responds 200 immediately, processes async |
| `/api/chat` | POST | Test UI — `{ parentName, conversationId, message }` |
| `/api/reset` | POST | Reset conversation — `{ conversationId }` |
| `/api/nudge` | POST | Manual nudge — `{ conversationId }` |
| `/api/nudge-check` | GET | Poll for pending nudge — `?conversationId=X` |
| `/health` | GET | `{ status, uptime, conversations }` |
