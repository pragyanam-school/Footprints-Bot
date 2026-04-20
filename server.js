// =============================================================================
//  FOOTPRINTS PRIYA — WhatsApp AI Sales Bot  v4.0
// =============================================================================
//  Architecture: Two-call pattern per turn.
//    Call 1 — Extraction: Claude returns structured JSON (no regex, no CITY_MAP).
//    Call 2 — Response:   Claude generates the reply using full system prompt.
//  Server owns: state machine, API calls, fee injection, escalation, timeouts.
//  Claude owns: all language — entity extraction, intent, response generation.
// =============================================================================
'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const WATI_API_TOKEN    = process.env.WATI_API_TOKEN    || '';
const WATI_SERVER_ID    = process.env.WATI_SERVER_ID    || '';
const PORT              = parseInt(process.env.PORT)    || 3000;

if (!ANTHROPIC_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY not set');

const MODEL              = 'claude-sonnet-4-6';
const CENTERS_API        = 'https://www.footprintseducation.in//nearest-centers';
const TIMEOUT_MS         = 20_000;
const MAX_HISTORY        = 20;
const NUDGE_DELAY_MS     = 2 * 60 * 1000;
const MESSAGE_BUFFER_MS  = 2_000;   // debounce window for multi-part WhatsApp messages

// ─── KNOWLEDGE: CONCERN MENU ─────────────────────────────────────────────────
const CONCERN_OPTIONS = [
  { label: 'Curriculum & Active Learning', key: 'curriculum' },
  { label: 'Safety & Security',            key: 'safety'     },
  { label: 'Food & Nutrition',             key: 'food'       },
  { label: 'Live CCTV & AI Monitoring',    key: 'cctv'       },
];

const CONCERN_MENU = `What would you most like to know about Footprints first? 😊`;

// Server-generated concern acknowledgments — {childName} and {parentName} substituted at runtime
const CONCERN_ACK = {
  curriculum:
    `Great choice — curriculum is the single most important thing to get right at this age. 💚<MSG_BREAK>` +
    `Here's why: 90% of a child's brain develops before age 6. That's the window. Footprints uses HighScope — a US-based, research-proven program used by leading early childhood centres worldwide. The idea is active learning: {childName} explores, experiments, and figures things out independently — not sitting and listening to a teacher. Choice Time every day where {childName} picks what to work on. No rote learning, no worksheets.<MSG_BREAK>` +
    `Here's a short video showing exactly how it works: https://www.youtube.com/watch?v=HIGHSCOPE_VIDEO_ID<MSG_BREAK>` +
    `Which city are you in, {parentName}?`,

  safety:
    `Safety is something we take very seriously — and it's one of the most common things parents ask us about. 💚<MSG_BREAK>` +
    `Every visitor needs an OTP to enter — no exceptions. All entry and exit points are biometric. Our staff are all women, background-verified, with regular health checks. The centre design itself is child-safe: cushioned walls, soft flooring, covered corners. And for new joiners, parents can be present in the centre for the first full week.<MSG_BREAK>` +
    `Which city are you in, {parentName}?`,

  food:
    `Fresh, healthy food is something we're genuinely proud of. 💚<MSG_BREAK>` +
    `All meals are cooked in-house every single day — nothing catered, nothing out of a packet. Zero junk food, zero chocolates, zero processed snacks — strict policy. Meals are age-appropriate, and parents get a daily update on exactly what their child ate. Allergies and dietary needs are accommodated at admission.<MSG_BREAK>` +
    `Which city are you in, {parentName}?`,

  cctv:
    `Live monitoring is one of the things parents love most about Footprints. 💚<MSG_BREAK>` +
    `You can watch {childName} live from your phone anytime — not clips, a full live feed. Cameras cover every room: playroom, activity area, dining, nap room, outdoor, reception. On top of that, our AI monitoring flags unusual activity in real time and sends alerts — it's not just recording, it's actively watching. Most preschools in India don't offer anything close to this.<MSG_BREAK>` +
    `Which city are you in, {parentName}?`,
};

// Maps numeric answers OR the full option label text → concern key
const CONCERN_KEY_MAP = {
  '1': 'curriculum', '2': 'safety', '3': 'food', '4': 'cctv',
  'curriculum & active learning': 'curriculum',
  'safety & security':            'safety',
  'food & nutrition':             'food',
  'live cctv & ai monitoring':    'cctv',
};


// ─── HELPERS ─────────────────────────────────────────────────────────────────
function toTitleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

const PROGRAM_MIN_MONTHS = { 'Daycare': 9, 'Pre-School': 18, 'After School': 48 };

function parseAgeMonths(ageStr) {
  if (!ageStr) return null;
  const s = ageStr.toLowerCase();
  let total = 0;
  const yr = s.match(/(\d+(?:\.\d+)?)\s*(?:year|yr)/);
  const mo = s.match(/(\d+)\s*(?:month|mo\b)/);
  if (yr) total += Math.round(parseFloat(yr[1]) * 12);
  if (mo) total += parseInt(mo[1]);
  return total > 0 ? total : null;
}

function isProgramEligible(program, childAge) {
  const minMonths = PROGRAM_MIN_MONTHS[program];
  if (!minMonths) return true;
  const ageMonths = parseAgeMonths(childAge);
  if (ageMonths === null) return true;
  return ageMonths >= minMonths;
}

// ─── MESSAGE BUFFER (debounce multi-part WhatsApp messages) ──────────────────
const messageBuffers = {}; // { [waId]: { parts: string[], timer: Timeout } }

function bufferAndProcess(waId, text, onReady) {
  if (!messageBuffers[waId]) messageBuffers[waId] = { parts: [], timer: null };
  const buf = messageBuffers[waId];
  buf.parts.push(text);
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    const combined = buf.parts.join('\n');
    delete messageBuffers[waId];
    onReady(combined);
  }, MESSAGE_BUFFER_MS);
}

// ─── STATE ───────────────────────────────────────────────────────────────────
const conversations = {};

function getState(id) {
  if (!conversations[id]) {
    conversations[id] = {
      history:              [],      // Claude message history (capped at MAX_HISTORY pairs)
      parentName:           null,
      childName:            null,
      nameAttempts:         0,       // turns where name wasn't extracted (max 3 → escalate)
      childAge:             null,
      ageAttempts:          0,       // turns where age wasn't extracted (max 3 → escalate)
      program:              null,    // 'Daycare' | 'Pre-School' | 'After School'
      city:                 null,
      area:                 null,
      centersData:          null,    // full API JSON — persists until city changes
      centersShown:         false,
      visitBooked:          false,
      concernAsked:         false,
      concern:              null,    // 'curriculum' | 'safety' | 'food' | 'cctv'
      failedAreaFetches:    0,       // consecutive 0-result API responses
      stuckCount:           0,       // turns with city but no area extracted
      humanTakeover:        false,
      turnCount:            0,
      nudgeCount:           0,
      nudgeTimer:           null,
      _pendingNudge:        null,
      _concernMenuJustSent:      false,   // true for one turn after concern menu fires
      _concernJustDetected:      false,   // true for one turn after concern is answered
      _nameConfirmationPending:  null,    // { raw, suggestion } when awaiting spelling confirmation
      _ineligibleProgram:        null,    // program requested but child is under minimum age
      frustratedCount:      0,       // consecutive frustrated signals (2 → escalate)
      lastIntent:           null,    // previous turn's intent for repeat detection
      sameIntentCount:      0,       // consecutive turns with same intent, no progress
    };
  }
  return conversations[id];
}

// ─── IST DATE CONTEXT ────────────────────────────────────────────────────────
function getISTDateContext() {
  const ist  = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const lines = [];
  for (let i = 0; i < 8; i++) {
    const d   = new Date(ist); d.setDate(ist.getDate() + i);
    const lbl = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : i === 2 ? 'Day after' : DAYS[d.getDay()];
    const hrs = d.getDay() === 0 ? 'NO VISITS (Sunday)' : d.getDay() === 6 ? 'Visits: 11AM–3PM' : 'Visits: 10AM–6PM';
    lines.push(`${lbl.padEnd(12)}= ${DAYS[d.getDay()]} ${d.getDate()} ${MONS[d.getMonth()]} — ${hrs}`);
  }
  return (
    `Now: ${DAYS[ist.getDay()]} ${ist.getDate()} ${MONS[ist.getMonth()]} ${ist.getFullYear()} — ${ist.toISOString().slice(11,16)} IST\n\n` +
    lines.join('\n') +
    `\n\nNEVER calculate dates yourself — use only these pre-computed values.`
  );
}

// ─── FEE FORMATTER ───────────────────────────────────────────────────────────
const PROGRAM_DISPLAY = {
  'Half Day':           'Pre-School (Half Day)',
  'Extended Preschool': 'Extended Pre-School',
  'Full Day':           'Full Day Care (Daycare)',
  'Evening Program':    'Evening Program (After School)',
  'After School':       'After School Care',
};

function formatFeeData(centersData) {
  if (!centersData || !centersData.length) return '';
  const lines = ['FEE DATA — always use verbatim, never invent ₹ amounts:'];
  for (const c of centersData) {
    lines.push(`\nCentre: ${c.Webpage_Title}`);
    lines.push(`Address: ${c.Center_Address}`);
    lines.push(`Map: ${c.Center_Map_Address}`);
    lines.push(`Distance: ${c.Calculeted_Radius_Text}`);
    const fees = c.Center_Feecard_List;
    if (fees) {
      const v1 = fees.V1 || {};
      const v2 = fees.V2 || {};
      const programs = new Set([...Object.keys(v1), ...Object.keys(v2)]);
      for (const prog of programs) {
        const dp = PROGRAM_DISPLAY[prog] || prog;
        if (v1[prog]) {
          const p = v1[prog];
          lines.push(`  ${dp} — V1 Long Term: ₹${p.Monthly_Fee}/month + ₹${p.Annual_Fee} annual | Admission ₹${p.Admission_Fee}`);
        }
        if (v2[prog]) {
          const p = v2[prog];
          lines.push(`  ${dp} — V2 Short Term: ₹${p.Monthly_Fee}/month (₹0 annual) | Admission ₹${p.Admission_Fee}`);
        }
      }
    }
  }
  return lines.join('\n');
}

// ─── SYSTEM PROMPT (CALL 2) ──────────────────────────────────────────────────
function buildSystemPrompt(state, nextStepOverride = null) {
  const { childName, childAge, program, city, area, centersData, concern, parentName } = state;

  const nextStep = nextStepOverride || (
    !childName              ? "Ask for the child's name warmly."
    : !childAge             ? "Ask for the child's age warmly."
    : !program              ? "Ask about the program (full-day daycare / pre-school / after school)."
    : !city                 ? "Ask which city they're in."
    : !area                 ? "Ask which area or neighbourhood they're in."
    : centersData && !state.centersShown ? `Present ALL ${centersData.length} nearby centres — every single one, no skipping. One centre per message segment, use MSG_BREAK between each. Show name, address, and distance only. Do NOT share fees yet — wait for the parent to ask.`
    : "Answer the parent's question. If they haven't asked about fees yet, gently guide toward booking a visit."
  );

  const feeSection = centersData
    ? `\n\n━━━ CENTRES & FEES ━━━\n${formatFeeData(centersData)}`
    : `\n\n⚠ NO FEE DATA LOADED — do not quote any ₹ amounts. If fees come up, ask which area they're in first.`;

  const concernNote = concern
    ? `\n\nACTIVE PARENT CONCERN: "${concern.toUpperCase()}" — weave in relevant details from the knowledge base naturally.`
    : '';

  const ineligibleNote = state._ineligibleProgram ? (() => {
    const min = PROGRAM_MIN_MONTHS[state._ineligibleProgram];
    const minStr = min >= 12 ? `${min / 12} years` : `${min} months`;
    return `\n\n⚠️ AGE GATE: Parent asked about ${state._ineligibleProgram} but ${childName || 'the child'} is ${childAge || 'under age'} — minimum age is ${minStr}. Warmly explain that ${childName || 'your child'} is a little young for that program, mention when ${childName || 'your child'} will be eligible, and suggest Full Day Daycare (available from 9 months) as the best fit right now.`;
  })() : '';

  return `You are Priya, a warm and knowledgeable admissions advisor for Footprints Preschool & Daycare in India. You speak naturally, never robotically.

CONVERSATION STATE:
Parent: ${parentName || 'not known'} | Child: ${childName || 'not yet asked'} | Age: ${childAge || 'not yet known'} | Program: ${program || 'not yet known'} | City: ${city || 'not yet known'} | Area: ${area || 'not yet known'}

🎯 YOUR NEXT STEP: ${nextStep}

━━━ COMMUNICATION RULES ━━━
• Warm and natural — never say "I am an AI / bot / automated"
• Never say "Let me fetch / check / look that up" — all data is already in front of you
• Never create numbered lists for programs (conflicts with concern menu)
• Never quote ₹ amounts without fee data loaded in this prompt
• Always use Webpage_Title verbatim — never rename centres
• Max ~60 words per message segment. Use <MSG_BREAK> to split long replies.
• Plain text. WhatsApp *bold* sparingly. One question per message.
• ALWAYS end every reply with the 🎯 NEXT STEP question — no exceptions. Never leave a turn without advancing the conversation.
• FEES: Never volunteer fee amounts. Only share when the parent explicitly asks about fees or pricing. When sharing fees, you may first share one surprising/delightful fact about Footprints before showing the numbers (e.g. "Before I share the fees — did you know Footprints is one of the only chains in India where parents can watch their child LIVE from their phone?").
• PRONOUNS: Never use he/she/his/her/him/they/their for the child. Always use the child's name (e.g. "Priyu's program" not "her program").
• PROACTIVE FACTS: At natural moments (after showing centres, when program is confirmed, after fees), share one interesting Footprints fact or a short video. Keep it brief — one sentence + the link.

━━━ FOOTPRINTS YOUTUBE VIDEOS ━━━
• Centre tour & daily routine: https://www.youtube.com/watch?v=TOUR_VIDEO_ID
• HighScope active learning explained: https://www.youtube.com/watch?v=HIGHSCOPE_VIDEO_ID
• Parent testimonials: https://www.youtube.com/watch?v=TESTIMONIAL_VIDEO_ID
• Welcome Kit unboxing: https://www.youtube.com/watch?v=WELCOMEKIT_VIDEO_ID
(Replace placeholder IDs with real video IDs before go-live)

━━━ FEES FORMAT (when parent asks) ━━━
Open: "We have two fee plans — Long Term (V1) and Short Term (V2):"
Close: Registration ₹[X] | Welcome Kit ₹7,500 | ✅ All Meals | ✅ Live CCTV + AI Monitoring

━━━ FOOTPRINTS KNOWLEDGE BASE ━━━

COMPANY: Founded 2013 by Raj, Purvesh & Ashish. One of India's largest daycare chains — 200+ centres, 25+ cities. Corporate clients: Airtel, Wipro, GE, BlackRock, Siemens, Nokia.

PROGRAMS:
• Pre-School (Half Day): 9AM–12:30PM | Ages 1.5–6 yrs
• Extended Pre-School: 9AM–3:30PM | Ages 1.5–6 yrs
• Full Day Care (Daycare): 9AM–6:30PM | Ages 9 months–8 yrs
• After School / Evening: 3:30PM–6:30PM | Ages 4–8 yrs
Minimum ages: Full Day Care from 9 months | Pre-School from 1.5 yrs | After School from 4 yrs

CURRICULUM — HighScope / Active Learning:
90% of a child's brain develops before age 6 — this is the single most important learning window. Most parents focus on college prep, but research shows early childhood curriculum matters most. Footprints uses HighScope — a US-based, globally research-proven early childhood program with decades of published results. Children learn by exploring, experimenting, and discovering on their own — not passive instruction. Choice Time daily (children pick what to work on → independence from age 1). Plan-do-review cycle builds thinking and reflection. No rote learning, no worksheets, no passive teaching. Say "HighScope" at most once per response; use "active learning" prominently.

SAFETY & SECURITY:
Live CCTV + AI monitoring — parents watch LIVE from their phone anytime, all rooms (not just recordings — a full live feed). OTP visitor entry — no exceptions. Biometric access on all entry and exit points. All-women staff, background-verified, regular health checks. Child-safe design: cushioned walls, soft flooring, covered corners, door guards. Real-time mobile updates on meals, sleep, activities throughout the day.

MEALS & FOOD:
Cooked fresh in-house daily — not catered, not packed. Zero junk food, zero chocolates, zero processed snacks — strict policy. Age-appropriate meals (soft foods for toddlers, balanced for older children). Breakfast, lunch, evening snack (depends on program). Parents get daily update on exactly what their child ate. Allergies accommodated at admission.

STAFF RATIOS: Under 2 yrs → 1:5 | Ages 2–3 → 1:8 | Above 3 → 1:10 (helpers additional)

POLICIES:
• 15-day no-questions refund
• Pause option available
• 1-business-day support response
• Settling-in policy: parents present for ENTIRE FIRST WEEK — mention proactively for under-3s and first-timers.

WELCOME KIT (₹7,500 one-time at admission):
• Books & Workbooks — age-appropriate, curated for developmental stage
• Speaking Pen: child touches pen to book → book talks back — reads stories, plays games, asks questions. Pitch: "makes learning feel like play for pre-readers."
• Learning Aids: wooden toys for home use reinforcing centre learning
• Picnic Vest — worn on outdoor activities and outings
• School Bag — branded Footprints

ACTIVITIES BY AGE:
• 1–2 yrs: sensory play, stacking, rhymes, pouring, movement games → motor skills, early language
• 2–3 yrs: pretend play, storytelling, colours/shapes, finger painting → communication, confidence, social
• 3–4 yrs: story-based learning, counting, tracing, role play → language, thinking, school readiness
• 4–6 yrs: phonics, reading/writing, puzzles, group discussions, project work → academic foundations, confidence

VISIT BOOKING:
Mon–Fri: 10AM–6PM | Sat: 11AM–3PM | NO Sundays
Confirm with: "✅ Done! Visit confirmed at [Centre], [Day] at [Time]. You'll receive WhatsApp + email. Looking forward to welcoming [Child]! 💚"

━━━ VISIT AVAILABILITY ━━━
${getISTDateContext()}
${feeSection}${concernNote}${ineligibleNote}`;
}

// ─── EXTRACTION CALL (CALL 1) ─────────────────────────────────────────────────
const EXTRACTION_SYSTEM = `You are an entity extractor for a preschool admissions WhatsApp bot in India.
Extract structured data from the parent's message. Respond ONLY with valid JSON, no markdown, no code blocks.

Rules:
- childName: a proper name only, extracted verbatim exactly as the parent typed it — do NOT correct spelling. Null if message is about anything else (program, city, questions).
- nameCorrectionSuggestion: ONLY if there are wrong/extra/missing letters (e.g. "jhon"→"John", "anushkaa"→"Anushka"). Return null for valid Indian names (mihir, aarav, vihaan) AND for names that are simply written in lowercase ("john"→null, "priya"→null, "arjun"→null). Lowercase-only is NOT a spelling error — do not suggest a correction just because the first letter is lowercase.
- childAge: as string e.g. "3 years", "18 months". Accept bare number only if context clearly suggests age.
- city: any Indian city, normalised to title case. Handle variants: bengaluru/blr→Bangalore, noid→Noida, ggn/gurugram→Gurgaon, bombay→Mumbai, madras→Chennai.
- area: locality, sector, landmark, or neighbourhood. Accept abbreviations (hsr→HSR Layout, btm→BTM Layout, ecr→ECR). Strip qualifiers: "hsr only"→"HSR Layout".
- program: "Daycare" (full day/daycare/creche), "Pre-School" (half day/preschool/nursery/lkg/morning), "After School" (evening/after school). Null if unclear.
- intent: "fee"|"booking"|"concern_menu_answer"|"meta"|"area_query"|"general"
- concernMenuAnswer: if intent is concern_menu_answer, return the matching label text exactly as one of: "Curriculum & Active Learning", "Safety & Security", "Food & Nutrition", "Live CCTV & AI Monitoring". Else null.
- isNegativeResponse: true if refusing/skipping ("i dont want to tell", "skip", "not now", "no idea").
- extractedAreaFromPhrase: if message contains "how about X"/"what about X"/"near X"/"try X", extract X. Null otherwise.
- isMetaQuestion: true if asking who/what the bot is ("who are you", "are you a bot", "where are you", "is this automated").
- isHumanRequest: true if parent wants to speak to a person ("talk to someone", "call me", "speak to agent", "human please", "connect me to staff").
- isAbusive: true if message contains abusive, offensive, or threatening language directed at the bot or brand.
- isFrustrated: true if clear negative sentiment without abuse ("useless", "not helpful", "wasting my time", "this is bad", "not working", "terrible").
- isUrgent: true if parent signals strong time urgency ("joining this week", "starting Monday", "very urgent", "asap", "need immediately").
- isCorporateInquiry: true if asking about multi-enrollment for a company ("corporate creche", "for our employees", "bulk enrollment", "company daycare").
- hasMultipleChildren: true if parent mentions enrolling more than one child simultaneously.
- isProgramQuestion: true if the parent is ASKING whether a program exists or what it involves ("do you have half day?", "what is daycare?", "do you offer after school?"). False if the parent is SELECTING or CONFIRMING a program ("I want daycare", "full day please", "we'll go with pre-school").`;

async function contextualAsk(message, need, state) {
  const parentRef = state.parentName ? ` ${state.parentName}` : '';
  const instruction = need === 'childName'
    ? `Your ONLY goal this turn: get the child's name. Acknowledge what the parent said briefly, then ask for their child's name.
If the parent refuses or says they don't want to share — empathise, but explain that you need it to find the right program and nearby centre, and ask again warmly.
Never say "no worries, take your time" without also re-asking. The question must always be the last sentence.`
    : `Your ONLY goal this turn: get the child's age. Acknowledge what the parent said briefly, then ask how old ${state.childName} is (e.g. "2 years" or "18 months").
If the parent refuses or says they don't want to share — empathise, but explain you need the age to suggest the right program, and ask again warmly.
Never say "no worries, take your time" without also re-asking. The question must always be the last sentence.`;
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      MODEL,
      max_tokens: 150,
      system:     `You are Priya, a warm WhatsApp admissions assistant for Footprints Preschool & Daycare.
Keep replies concise — this is WhatsApp, 1–2 sentences max. No bullet points. One emoji used naturally.
${instruction}`,
      messages:   [{ role: 'user', content: `Parent${parentRef} said: "${message}"` }],
    },
    {
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      timeout: 10_000,
    }
  );
  return res.data.content[0].text.trim();
}

async function extractionCall(message, contextStr) {
  const contextLine = contextStr ? `\nConversation context: ${contextStr}` : '';
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      MODEL,
      max_tokens: 512,
      system:     EXTRACTION_SYSTEM,
      messages:   [{
        role:    'user',
        content: `Parent message: "${message}"${contextLine}\n\nReturn JSON only.`,
      }],
    },
    {
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      timeout: 10_000,
    }
  );

  const raw = res.data.content[0].text.trim();
  try {
    const clean = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(clean);
  } catch {
    console.warn('⚠️  Extraction JSON parse failed:', raw);
    return {};
  }
}

// ─── RESPONSE CALL (CALL 2) ───────────────────────────────────────────────────
async function responseCall(state, nextStepOverride = null) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      MODEL,
      max_tokens: 1024,
      system:     buildSystemPrompt(state, nextStepOverride),
      messages:   state.history.slice(-MAX_HISTORY),
    },
    {
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      timeout: TIMEOUT_MS,
    }
  );
  return res.data.content[0].text.trim();
}

// ─── CENTRES API ─────────────────────────────────────────────────────────────
async function fetchCenters(area, city) {
  const q   = encodeURIComponent(`${area} ${city}`);
  const url = `${CENTERS_API}?q=${q}`;
  console.log(`🚀 API CALL: ${url}`);
  const res = await axios.get(url, { timeout: 8_000 });
  return Array.isArray(res.data) ? res.data : [];
}

// ─── ESCALATION ──────────────────────────────────────────────────────────────
function notifyStuck(_state, reason) {
  console.log(`🔴 NOTIFY STUCK — ${reason}`);
  // TODO: POST to Slack webhook / ops dashboard
}

async function triggerHumanTakeover(waId) {
  console.log(`🔴 HUMAN TAKEOVER — waId: ${waId}`);
  if (!WATI_SERVER_ID || !WATI_API_TOKEN) return;
  await axios.post(
    `https://live-server-${WATI_SERVER_ID}.wati.io/api/v1/conversations/${waId}/unassign`,
    {}, { headers: { Authorization: `Bearer ${WATI_API_TOKEN}` } }
  ).catch(err => console.error('Wati unassign error:', err.message));
}

// ─── WATI MESSAGE SENDING ─────────────────────────────────────────────────────
const WATI_MSG_DELAY_MS = 1500;

async function sendWatiMessage(waId, text) {
  if (!WATI_SERVER_ID || !WATI_API_TOKEN) return;
  await axios.post(
    `https://live-server-${WATI_SERVER_ID}.wati.io/api/v1/sendSessionMessage/${waId}`,
    { messageText: text },
    { headers: { Authorization: `Bearer ${WATI_API_TOKEN}` } }
  ).catch(err => console.error('Wati send error:', err.message));
}

async function sendWatiMessages(waId, result) {
  if (!result.reply) return;
  const parts = result.reply.split('<MSG_BREAK>').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, WATI_MSG_DELAY_MS));
    await sendWatiMessage(waId, parts[i]);
  }
  if (result.concernMenuMessage) {
    await new Promise(r => setTimeout(r, WATI_MSG_DELAY_MS));
    await sendWatiMessage(waId, result.concernMenuMessage);
    if (result.concernMenuOptions?.length) {
      const optionText = result.concernMenuOptions.map(o => o.label).join('\n');
      await new Promise(r => setTimeout(r, 600));
      await sendWatiMessage(waId, optionText);
    }
  }
}

function crmUpdateLead(_state) {
  // TODO: push to CRM
}

const TAKEOVER_MSG = (childName) =>
  `I want to make sure I find the absolute best option for you and ${childName || 'your child'}. Let me loop in one of our senior admissions counsellors who knows our centres inside out — they'll be able to help you right away. 😊 Someone from our team will be with you shortly!`;

async function escalate(state, waId, reason) {
  state.humanTakeover = true;
  notifyStuck(state, reason);
  await triggerHumanTakeover(waId);
  crmUpdateLead(state);
  return TAKEOVER_MSG(state.childName);
}

// ─── NUDGE ───────────────────────────────────────────────────────────────────
function buildNudge(state) {
  if (state.nudgeCount >= 2 || state.visitBooked || state.humanTakeover) return null;
  state.nudgeCount++;
  const nudges = [
    `Hi ${state.parentName || 'there'} 👋 Just checking in — happy to answer any questions about Footprints or help find the nearest centre for ${state.childName || 'your little one'}.`,
    `Still here whenever you're ready 😊 Would you like me to show you Footprints centres in your area?`,
  ];
  return nudges[Math.min(state.nudgeCount - 1, nudges.length - 1)];
}

function scheduleNudge(state) {
  clearNudgeTimer(state);
  state.nudgeTimer = setTimeout(() => {
    const nudge = buildNudge(state);
    if (nudge) state._pendingNudge = nudge;
  }, NUDGE_DELAY_MS);
}

function clearNudgeTimer(state) {
  if (state.nudgeTimer) { clearTimeout(state.nudgeTimer); state.nudgeTimer = null; }
}

// ─── MAIN PROCESS ─────────────────────────────────────────────────────────────
async function processMessage(conversationId, waId, message) {
  const state = getState(conversationId);
  state.turnCount++;

  const sep = '═'.repeat(70);
  console.log(`\n${sep}`);
  console.log(`TURN ${state.turnCount} | conv: ${conversationId}`);
  console.log(`STATE AT TURN START: name=${state.childName} age=${state.childAge} program=${state.program} city=${state.city} area=${state.area} centers=${state.centersData?.length ?? 0}`);

  // Reset one-turn flags at start of each turn
  state._concernMenuJustSent = false;
  state._concernJustDetected = false;
  state._ineligibleProgram   = null;

  // ── TAKEOVER CHECK ──────────────────────────────────────────────────────────
  console.log('\n── TAKEOVER CHECK');
  if (state.humanTakeover) {
    console.log('📤 Already handed over to human — suppressing reply');
    return { reply: null };
  }
  if (state.turnCount >= 14 && !state.visitBooked) {
    console.log('🔴 Max turns reached');
    const reply = await escalate(state, waId, 'max turns reached');
    return { reply, humanTakeover: true };
  }

  clearNudgeTimer(state);

  // ── EXTRACTION CALL ─────────────────────────────────────────────────────────
  console.log('\n── EXTRACTION CALL');
  const contextStr = [
    state.childName    && `child name: ${state.childName}`,
    state.childAge     && `child age: ${state.childAge}`,
    state.program      && `program: ${state.program}`,
    state.city         && `city: ${state.city}`,
    state.concernAsked && !state.concern && 'concern menu was shown (1=curriculum 2=safety 3=food 4=cctv)',
    state.concern      && `concern topic: ${state.concern}`,
  ].filter(Boolean).join(', ');

  let ext = {};
  try {
    ext = await extractionCall(message, contextStr);
    console.log('🧩 EXTRACTION:', JSON.stringify(ext));
  } catch (err) {
    console.error('⚠️  Extraction call failed:', err.message);
  }

  // ── STATE UPDATE ────────────────────────────────────────────────────────────
  console.log('\n── STATE UPDATE');

  if (ext.isMetaQuestion) {
    console.log('🔴 Meta-question detected');
    const reply = await escalate(state, waId, 'meta question');
    return { reply, humanTakeover: true };
  }

  if (ext.isHumanRequest) {
    console.log('🔴 Parent requested human');
    const reply = await escalate(state, waId, 'parent requested human');
    return { reply, humanTakeover: true };
  }

  if (ext.isAbusive) {
    console.log('🔴 Abusive message detected');
    const reply = await escalate(state, waId, 'abusive message');
    return { reply, humanTakeover: true };
  }

  if (ext.isFrustrated) {
    state.frustratedCount++;
    console.log(`🔁 frustratedCount: ${state.frustratedCount}`);
    if (state.frustratedCount >= 2) {
      console.log('🔴 Repeated frustration — escalating');
      const reply = await escalate(state, waId, 'repeated frustration');
      return { reply, humanTakeover: true };
    }
  }

  if (ext.isUrgent) {
    console.log('🔴 Urgency detected — escalating proactively');
    const childName = state.childName || 'your child';
    const reply = `I want to make sure ${childName} gets the right spot as quickly as possible! 😊<MSG_BREAK>Let me connect you with one of our senior admissions counsellors right away — they can fast-track everything for you. Someone from our team will be with you shortly!`;
    state.humanTakeover = true;
    notifyStuck(state, 'urgency');
    await triggerHumanTakeover(waId);
    return { reply, humanTakeover: true };
  }

  if (ext.isCorporateInquiry || ext.hasMultipleChildren) {
    const reason = ext.isCorporateInquiry ? 'corporate inquiry' : 'multiple children';
    console.log(`🔴 High-value signal: ${reason} — escalating`);
    const reply = `That sounds wonderful! 😊<MSG_BREAK>For ${ext.isCorporateInquiry ? 'corporate and multi-enrollment enquiries' : 'enrolling multiple children'}, let me connect you directly with our senior admissions team — they'll be best placed to help you. Someone will be with you shortly!`;
    state.humanTakeover = true;
    notifyStuck(state, reason);
    await triggerHumanTakeover(waId);
    return { reply, humanTakeover: true };
  }

  // Repeated same intent with no state progress
  if (ext.intent && ext.intent !== 'general' && ext.intent === state.lastIntent) {
    state.sameIntentCount++;
    console.log(`🔁 sameIntentCount (${ext.intent}): ${state.sameIntentCount}`);
    if (state.sameIntentCount >= 3) {
      console.log('🔴 Repeated same question — escalating');
      const reply = await escalate(state, waId, 'repeated same question');
      return { reply, humanTakeover: true };
    }
  } else {
    state.sameIntentCount = 0;
    state.lastIntent = ext.intent || null;
  }

  let nameJustStored = false;
  if (ext.childName && !ext.isNegativeResponse) {
    if (!state.childName) {
      state.childName = toTitleCase(ext.childName);
      nameJustStored = true;
      console.log(`✅ childName: ${state.childName}`);
      // Only ask for confirmation if it's a genuine letter change, not just capitalisation
      if (ext.nameCorrectionSuggestion && toTitleCase(ext.childName) !== ext.nameCorrectionSuggestion) {
        state._nameConfirmationPending = { raw: ext.childName, suggestion: ext.nameCorrectionSuggestion };
        console.log(`🔁 nameCorrectionSuggestion: ${ext.nameCorrectionSuggestion}`);
      }
    } else if (state._nameConfirmationPending && toTitleCase(ext.childName) !== state.childName) {
      // Parent confirmed the corrected spelling
      state.childName = toTitleCase(ext.childName);
      state._nameConfirmationPending = null;
      console.log(`✅ childName corrected to: ${state.childName}`);
    }
  }

  if (!state.childAge && ext.childAge && !ext.isNegativeResponse) {
    state.childAge = ext.childAge;
    console.log(`✅ childAge: ${state.childAge}`);
  }

  if (!state.program && ext.program) {
    if (ext.isProgramQuestion) {
      console.log(`❌ program "${ext.program}" not stored — parent is asking, not selecting`);
    } else if (isProgramEligible(ext.program, state.childAge)) {
      state.program = ext.program;
      console.log(`✅ program: ${state.program}`);
      state.sameIntentCount = 0;
    } else {
      state._ineligibleProgram = ext.program;
      console.log(`❌ program "${ext.program}" blocked — child age ${state.childAge} below minimum`);
    }
  }

  let cityJustDetected = false;
  if (ext.city) {
    if (!state.city) {
      state.city       = ext.city;
      cityJustDetected = true;
      console.log(`✅ city: ${state.city}`);
    } else if (ext.city !== state.city) {
      state.city        = ext.city;
      state.area        = null;
      state.centersData = null;
      state.centersShown = false;
      cityJustDetected  = true;
      state.sameIntentCount = 0;
      console.log(`✅ city changed: ${state.city} (area + centres reset)`);
    }
  }

  // Block area only when city just changed AND no area arrived in the same message.
  // If city + area came together (e.g. "Sector 35 Noida"), store both immediately.
  // Guard against extraction conflating city name with area (e.g. city=Noida, area=Noida).
  const incomingArea = (ext.area && ext.area !== ext.city) ? ext.area : ext.extractedAreaFromPhrase;
  const blockArea = cityJustDetected && !incomingArea;
  if (!state.area && !blockArea && state.city) {
    const newArea = incomingArea;
    if (newArea) {
      state.area = newArea;
      console.log(`✅ area: ${state.area}`);
      state.sameIntentCount = 0; // progress made
    }
  }

  // ── CHILD NAME COLLECTION ───────────────────────────────────────────────────
  console.log('\n── CHILD NAME COLLECTION');
  if (!state.childName) {
    state.nameAttempts++;
    console.log(`🔁 nameAttempts: ${state.nameAttempts}`);
    if (state.nameAttempts >= 3) {
      console.log('🔴 Name never given — escalating');
      const reply = await escalate(state, waId, 'name never given');
      return { reply, humanTakeover: true };
    }
    const reply = state.nameAttempts === 1 && !message.trim()
      ? `Hi${state.parentName ? ' ' + state.parentName : ''}! 😊 I'd love to help find the perfect Footprints centre. What's your little one's name?`
      : await contextualAsk(message, 'childName', state);
    console.log('📤 Server bypass — name ask');
    state.history.push({ role: 'user', content: message });
    state.history.push({ role: 'assistant', content: reply });
    scheduleNudge(state);
    return { reply };
  }

  // ── CHILD AGE COLLECTION ────────────────────────────────────────────────────
  console.log('\n── CHILD AGE COLLECTION');
  if (!state.childAge) {
    state.ageAttempts++;
    console.log(`🔁 ageAttempts: ${state.ageAttempts}`);
    if (state.ageAttempts >= 3) {
      console.log('🔴 Age never given — escalating');
      const reply = await escalate(state, waId, 'age never given');
      return { reply, humanTakeover: true };
    }
    if (nameJustStored && state._nameConfirmationPending) {
      const { raw, suggestion } = state._nameConfirmationPending;
      const reply = `Just to make sure I spell it right — is it ${suggestion}, or is it ${raw}? 😊`;
      console.log('📤 Server bypass — name confirmation');
      state.history.push({ role: 'user', content: message });
      state.history.push({ role: 'assistant', content: reply });
      scheduleNudge(state);
      return { reply };
    }
    state._nameConfirmationPending = null; // parent moved on — accept name as-is
    const reply = await contextualAsk(message, 'childAge', state);
    console.log('📤 Server bypass — age ask');
    state.history.push({ role: 'user', content: message });
    state.history.push({ role: 'assistant', content: reply });
    scheduleNudge(state);
    return { reply };
  }

  // ── CONCERN MENU ────────────────────────────────────────────────────────────
  console.log('\n── CONCERN MENU');
  let concernMenuMessage = null;

  if (state.program && !state.concernAsked) {
    state.concernAsked         = true;
    state._concernMenuJustSent = true;
    concernMenuMessage          = CONCERN_MENU;

    console.log('\n── CONCERN MENU — calling Claude for confirmation');
    state.history.push({ role: 'user', content: message });
    const confirmNextStep = `Confirm ${state.childName}'s program selection in one warm sentence (max 15 words). Do NOT ask about city or anything else — a follow-up message is sent automatically after this.`;
    let reply;
    try {
      reply = await responseCall(state, confirmNextStep);
    } catch (err) {
      console.error('⚠️  Concern menu confirmation call failed:', err.message);
      const labels = { Daycare: 'full-day care', 'Pre-School': 'pre-school', 'After School': 'after school' };
      reply = `Great — ${labels[state.program] || state.program} for ${state.childName} it is! 👍`;
    }
    state.history.push({ role: 'assistant', content: reply });
    scheduleNudge(state);
    return { reply, concernMenuMessage, concernMenuOptions: CONCERN_OPTIONS };
  }

  // ── CONCERN ACK ─────────────────────────────────────────────────────────────
  console.log('\n── SERVER BYPASS CHECK');
  if (state.concernAsked && !state.concern && ext.concernMenuAnswer && !state._concernMenuJustSent) {
    const key = CONCERN_KEY_MAP[String(ext.concernMenuAnswer).toLowerCase()];
    if (key) {
      state.concern              = key;
      state._concernJustDetected = true;
      console.log(`✅ concern: ${state.concern}`);

      const reply = CONCERN_ACK[key]
        .replace(/\{childName\}/g,  state.childName  || 'your child')
        .replace(/\{parentName\}/g, state.parentName || 'there');

      console.log('📤 Server bypass — concern ack (Call 2 skipped)');
      state.history.push({ role: 'user', content: message });
      state.history.push({ role: 'assistant', content: reply });
      scheduleNudge(state);
      return { reply, city: state.city };
    }
  }

  // ── API CALL ─────────────────────────────────────────────────────────────────
  console.log('\n── AREA FETCH DECISION');
  if (state.city && state.area && !state.centersData) {
    try {
      const centers = await fetchCenters(state.area, state.city);
      console.log(`✅ API returned ${centers.length} centre(s)`);
      if (centers.length > 0) {
        console.log('🔍 RAW FEE SAMPLE:', JSON.stringify(centers[0].Center_Feecard_List ?? 'MISSING', null, 2));
        state.centersData       = centers;
        state.failedAreaFetches = 0;
      } else {
        state.failedAreaFetches++;
        state.area = null; // reset so parent can try another area
        console.log(`❌ 0 results — failedAreaFetches: ${state.failedAreaFetches}`);
        if (state.failedAreaFetches >= 2) {
          const reply = await escalate(state, waId, '0 API results after 2 attempts');
          return { reply, humanTakeover: true };
        }
      }
    } catch (err) {
      console.error('⚠️  Centres API error:', err.message);
    }
  } else if (state.city && !state.area && !cityJustDetected) {
    if (!ext.area && !ext.extractedAreaFromPhrase) {
      state.stuckCount++;
      console.log(`🔁 stuckCount: ${state.stuckCount}`);
      if (state.stuckCount >= 2) {
        const reply = await escalate(state, waId, 'area unresolvable after 2 turns');
        return { reply, humanTakeover: true };
      }
    }
  }

  // ── RESPONSE CALL ────────────────────────────────────────────────────────────
  console.log('\n── SYSTEM PROMPT INJECTION');
  console.log(`🎯 nextStep ready | centers: ${state.centersData?.length ?? 0} | concern: ${state.concern ?? 'none'}`);

  state.history.push({ role: 'user', content: message });

  console.log('\n── RESPONSE CALL');
  let reply;
  try {
    reply = await responseCall(state);
  } catch (err) {
    console.error('⚠️  Response call error:', err.message);
    reply = `Just a moment${state.parentName ? ' ' + state.parentName : ''} — let me check that for you 😊`;
  }

  state.history.push({ role: 'assistant', content: reply });
  if (state.history.length > MAX_HISTORY * 2) {
    state.history = state.history.slice(-MAX_HISTORY * 2);
  }

  if (state.centersData && !state.centersShown) state.centersShown = true;

  console.log(`\n── PRIYA REPLY\n${reply}`);
  console.log(`\nSTATE AFTER TURN: name=${state.childName} age=${state.childAge} program=${state.program} city=${state.city} area=${state.area} centers=${state.centersData?.length ?? 0}`);

  scheduleNudge(state);

  return {
    reply,
    city:          state.city,
    humanTakeover: state.humanTakeover,
  };
}

// ─── TIMEOUT WRAPPER ─────────────────────────────────────────────────────────
async function processWithTimeout(conversationId, waId, message) {
  const state = getState(conversationId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log('⏰ TIMEOUT — escalating after 20s');
      state.humanTakeover = true;
      notifyStuck(state, 'response timeout');
      triggerHumanTakeover(waId);
      resolve({ reply: TAKEOVER_MSG(state.childName), humanTakeover: true });
    }, TIMEOUT_MS);

    processMessage(conversationId, waId, message)
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err => {
        clearTimeout(timer);
        console.error('processMessage error:', err);
        resolve({ reply: 'Something went wrong on our end. Let me get someone to help you right away. 😊' });
      });
  });
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Wati WhatsApp webhook — respond 200 immediately, buffer multi-part messages, process async
app.post('/webhook/wati', (req, res) => {
  res.sendStatus(200);
  const { waId, senderName, text, type } = req.body;
  if (type !== 'text' || !text) return;
  const state = getState(waId);
  if (!state.parentName && senderName) state.parentName = senderName;
  bufferAndProcess(waId, text, (combined) => {
    processWithTimeout(waId, waId, combined)
      .then(result => sendWatiMessages(waId, result))
      .catch(console.error);
  });
});

// Test UI
app.post('/api/chat', async (req, res) => {
  const { parentName, conversationId, message } = req.body;
  if (!conversationId || !message) return res.status(400).json({ error: 'Missing fields' });
  const state = getState(conversationId);
  if (!state.parentName && parentName) state.parentName = parentName;
  try {
    const result = await processWithTimeout(conversationId, conversationId, message);
    res.json({
      reply:              result.reply,
      city:               result.city || state.city,
      humanTakeover:      result.humanTakeover || state.humanTakeover,
      concernMenuMessage: result.concernMenuMessage || null,
      concernMenuOptions: result.concernMenuOptions || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Reset conversation
app.post('/api/reset', (req, res) => {
  const { conversationId } = req.body;
  if (conversationId && conversations[conversationId]) {
    clearNudgeTimer(conversations[conversationId]);
    delete conversations[conversationId];
  }
  res.json({ ok: true });
});

// Manual nudge
app.post('/api/nudge', (req, res) => {
  const { conversationId } = req.body;
  const state = conversationId ? conversations[conversationId] : null;
  if (!state) return res.json({ nudge: null });
  const nudge = buildNudge(state);
  if (nudge) state.history.push({ role: 'assistant', content: nudge });
  res.json({ nudge });
});

// Poll for auto-timer nudge
app.get('/api/nudge-check', (req, res) => {
  const { conversationId } = req.query;
  const state = conversationId ? conversations[conversationId] : null;
  if (!state || !state._pendingNudge) return res.json({ nudge: null });
  const nudge        = state._pendingNudge;
  state._pendingNudge = null;
  if (nudge) state.history.push({ role: 'assistant', content: nudge });
  res.json({ nudge });
});

// Health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), conversations: Object.keys(conversations).length });
});

if (require.main === module) {
  const { execSync } = require('child_process');
  console.log('\n🧪 Running test suite before starting server...\n');
  try {
    execSync('npm test', { stdio: 'inherit', cwd: __dirname, timeout: 120_000 });
  } catch {
    console.error('\n❌ Tests failed — server will not start. Fix failing tests and try again.\n');
    process.exit(1);
  }
  console.log('\n✅ All tests passed.\n');

  app.listen(PORT, () => {
    console.log(`\n🌱 Footprints Priya running on http://localhost:${PORT}`);
    console.log(`   Model:  ${MODEL}`);
    console.log(`   Test:   http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health\n`);
  });
}

module.exports = app;
