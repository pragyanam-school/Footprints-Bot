'use strict';

const axios   = require('axios');
const request = require('supertest');

// ─── MOCK HELPERS ─────────────────────────────────────────────────────────────

function extraction(overrides = {}) {
  return JSON.stringify({
    childName:               null,
    childAge:                null,
    city:                    null,
    area:                    null,
    program:                 null,
    intent:                  'general',
    concernMenuAnswer:       null,
    isNegativeResponse:      false,
    extractedAreaFromPhrase: null,
    isMetaQuestion:          false,
    isHumanRequest:          false,
    isAbusive:               false,
    isFrustrated:            false,
    isUrgent:                false,
    isCorporateInquiry:      false,
    hasMultipleChildren:     false,
    nameCorrectionSuggestion: null,
    isProgramQuestion:        false,
    ...overrides,
  });
}

function anthropicReply(text) {
  return Promise.resolve({ data: { content: [{ text }] } });
}

// axios.post is always spied (Claude calls). axios.get is REAL — centres API
// is called live. Each city/area test adds its own jest.spyOn(axios,'get')
// to track call counts without mocking the response.
let postSpy;

beforeAll(() => {
  app = require('../server');
});

let app;
beforeEach(() => {
  postSpy = jest.spyOn(axios, 'post');
});

afterEach(() => {
  jest.restoreAllMocks();   // restores both post spy and any get spy
});

// Differentiate the three Anthropic call types by max_tokens:
//   512 → extractionCall  |  150 → contextualAsk  |  1024 → responseCall
function mockClaude({ ext = extraction(), ask = "Please share your child's details.", reply = 'Priya reply.' } = {}) {
  postSpy.mockImplementation((_url, body) => {
    if (body.max_tokens === 512) return anthropicReply(ext);
    if (body.max_tokens === 150) return anthropicReply(ask);
    return anthropicReply(reply);
  });
}

async function chat(id, message, parentName = 'Test Parent') {
  return request(app).post('/api/chat').send({ conversationId: id, message, parentName });
}

// Drive to: childName='Mika', childAge='3 years', program='Daycare', concern='safety'
async function driveToPostConcern(id) {
  mockClaude({ ext: extraction({ childName: 'Mika' }) });
  await chat(id, 'Mika');

  mockClaude({ ext: extraction({ childAge: '3 years' }), reply: 'Which program?' });
  await chat(id, '3 years');

  mockClaude({ ext: extraction({ program: 'Daycare' }) });
  await chat(id, 'Daycare please');

  mockClaude({ ext: extraction({ concernMenuAnswer: 'Safety & Security', intent: 'concern_menu_answer' }) });
  await chat(id, '2');
}

// ─── NAME COLLECTION ──────────────────────────────────────────────────────────

describe('Name collection', () => {
  it('asks for name on first message when no name extracted', async () => {
    mockClaude({ ext: extraction(), ask: "What's your little one's name?" });
    const res = await chat('name-ask-1', 'Hi, tell me about Footprints');
    expect(res.status).toBe(200);
    expect(res.body.reply).toBeTruthy();
    const askCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(askCalls.length).toBeGreaterThan(0);
  });

  it('does not save name when isNegativeResponse is true', async () => {
    mockClaude({
      ext: extraction({ childName: 'John', isNegativeResponse: true }),
      ask: "I understand — could you share the name so I can find the right centre?",
    });
    const res = await chat('name-neg-1', "I don't want to share the name");
    expect(res.status).toBe(200);
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBe(0);
  });

  it('escalates after 3 consecutive turns without a name', async () => {
    const id = 'name-escalate-1';
    for (let i = 0; i < 2; i++) {
      mockClaude({ ext: extraction(), ask: "What's your child's name?" });
      await chat(id, 'Just browsing');
      jest.resetAllMocks();
      postSpy = jest.spyOn(axios, 'post');
    }
    mockClaude({ ext: extraction() });
    const res = await chat(id, 'Still no name');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toContain('senior admissions counsellors');
  });

  it('accepts name with unusual spelling and moves to age ask', async () => {
    mockClaude({ ext: extraction({ childName: 'Vihaan' }), ask: 'How old is Vihaan?' });
    const res = await chat('name-accepted-1', 'My son Vihaan is interested');
    expect(res.status).toBe(200);
    const askCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(askCalls.length).toBeGreaterThan(0);
  });
});

// ─── AGE COLLECTION ───────────────────────────────────────────────────────────

describe('Age collection', () => {
  async function giveNameOnly(id) {
    mockClaude({ ext: extraction({ childName: 'Aria' }), ask: 'How old is Aria?' });
    await chat(id, 'Aria');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
  }

  it('asks for age after name is collected', async () => {
    const id = 'age-ask-1';
    await giveNameOnly(id);
    mockClaude({ ext: extraction(), ask: 'How old is Aria?' });
    await chat(id, 'Not sure about age yet');
    const askCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(askCalls.length).toBeGreaterThan(0);
  });

  it('does not save age when isNegativeResponse is true', async () => {
    const id = 'age-neg-1';
    await giveNameOnly(id);
    mockClaude({ ext: extraction({ childAge: '5 years', isNegativeResponse: true }), ask: "Please share Aria's age" });
    await chat(id, 'Skip age');
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBe(0);
  });

  it('escalates after 3 consecutive turns without an age', async () => {
    const id = 'age-escalate-1';
    await giveNameOnly(id);
    mockClaude({ ext: extraction(), ask: 'How old is Aria?' });
    await chat(id, "I'll think about it");
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction() });
    const res = await chat(id, 'Still not giving age');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toContain('senior admissions counsellors');
  });

  it('accepts age in months and proceeds to response call', async () => {
    const id = 'age-months-1';
    await giveNameOnly(id);
    mockClaude({ ext: extraction({ childAge: '18 months' }), reply: 'Which program are you looking for?' });
    const res = await chat(id, 'Aria is 18 months old');
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBeGreaterThan(0);
    expect(res.body.reply).toBeTruthy();
  });
});

// ─── PROGRAM & CONCERN MENU ───────────────────────────────────────────────────

describe('Program detection and concern menu', () => {
  async function giveNameAndAge(id) {
    mockClaude({ ext: extraction({ childName: 'Leo' }) });
    await chat(id, 'Leo');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    mockClaude({ ext: extraction({ childAge: '2 years' }), reply: 'Which program?' });
    await chat(id, '2 years');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
  }

  it('fires concern menu the turn program is first detected', async () => {
    const id = 'concern-fires-1';
    await giveNameAndAge(id);
    mockClaude({ ext: extraction({ program: 'Daycare' }), reply: 'Great — full-day care for Leo it is! 👍' });
    const res = await chat(id, 'I want full day daycare');
    expect(res.body.concernMenuMessage).toBeTruthy();
    expect(res.body.concernMenuOptions).toHaveLength(4);
    expect(res.body.reply).toBeTruthy();
    // Claude now generates this reply
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBeGreaterThan(0);
  });

  it('does NOT fire concern menu a second time', async () => {
    const id = 'concern-no-repeat-1';
    await giveNameAndAge(id);
    mockClaude({ ext: extraction({ program: 'Pre-School' }) });
    await chat(id, 'Pre-school');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction(), reply: 'Which city are you in?' });
    const res = await chat(id, 'What are your timings?');
    expect(res.body.concernMenuMessage).toBeFalsy();
  });

  it('concern answer 1 → HighScope curriculum ack with city ask', async () => {
    const id = 'concern-1-curriculum';
    await giveNameAndAge(id);
    mockClaude({ ext: extraction({ program: 'Daycare' }) });
    await chat(id, 'Daycare');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ concernMenuAnswer: 'Curriculum & Active Learning', intent: 'concern_menu_answer' }) });
    const res = await chat(id, '1');
    expect(res.body.reply).toContain('HighScope');
    expect(res.body.reply).toContain('city');
  });

  it('concern answer 2 → safety ack with OTP mention', async () => {
    const id = 'concern-2-safety';
    await giveNameAndAge(id);
    mockClaude({ ext: extraction({ program: 'Daycare' }) });
    await chat(id, 'Daycare');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ concernMenuAnswer: 'Safety & Security', intent: 'concern_menu_answer' }) });
    const res = await chat(id, '2');
    expect(res.body.reply).toContain('OTP');
  });

  it('concern answer 3 → food ack mentioning cooked in-house', async () => {
    const id = 'concern-3-food';
    await giveNameAndAge(id);
    mockClaude({ ext: extraction({ program: 'Daycare' }) });
    await chat(id, 'Daycare');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ concernMenuAnswer: 'Food & Nutrition', intent: 'concern_menu_answer' }) });
    const res = await chat(id, '3');
    expect(res.body.reply).toContain('cooked in-house');
  });

  it('concern answer 4 → CCTV ack with live feed and child name substituted', async () => {
    const id = 'concern-4-cctv';
    await giveNameAndAge(id);
    mockClaude({ ext: extraction({ program: 'Daycare' }) });
    await chat(id, 'Daycare');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ concernMenuAnswer: 'Live CCTV & AI Monitoring', intent: 'concern_menu_answer' }) });
    const res = await chat(id, '4');
    expect(res.body.reply).toContain('live feed');
    expect(res.body.reply).toContain('Leo');    // {childName} substituted
  });

  it('invalid answer (e.g. "5") → no ack, falls through to Claude response call', async () => {
    const id = 'concern-invalid-answer';
    await giveNameAndAge(id);
    mockClaude({ ext: extraction({ program: 'Daycare' }) });
    await chat(id, 'Daycare');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ intent: 'general' }), reply: 'Which city are you in?' });
    await chat(id, '5');
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBeGreaterThan(0);
  });

  it('does NOT store program or fire concern menu when parent is asking about it (isProgramQuestion)', async () => {
    // Bug: "do you offer half day as well?" was treated as a program selection.
    // Fix: extraction returns isProgramQuestion:true → server ignores program field.
    const id = 'program-question-not-stored';
    await giveNameAndAge(id);

    mockClaude({
      ext: extraction({ program: 'Pre-School', isProgramQuestion: true }),
      reply: 'Yes, we offer half-day pre-school! Would you prefer half day or full day?',
    });
    const res = await chat(id, 'do you offer half day as well');
    // Concern menu must NOT fire — program was not confirmed
    expect(res.body.concernMenuMessage).toBeFalsy();
    // Claude response call should fire (not a server bypass)
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBeGreaterThan(0);
  });

  it('stores program and fires concern menu when parent explicitly selects after asking', async () => {
    // After being shown both options, parent makes a clear choice → concern menu fires
    const id = 'program-selected-after-question';
    await giveNameAndAge(id);

    // First: parent asks about half day (isProgramQuestion) — no storage
    mockClaude({
      ext: extraction({ program: 'Pre-School', isProgramQuestion: true }),
      reply: 'Yes! Would you prefer half day or full day?',
    });
    await chat(id, 'do you offer half day as well');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Second: parent makes explicit choice — isProgramQuestion:false → stored, concern menu fires
    mockClaude({ ext: extraction({ program: 'Pre-School', isProgramQuestion: false }) });
    const res = await chat(id, 'half day please');
    expect(res.body.concernMenuMessage).toBeTruthy();
    expect(res.body.concernMenuOptions).toHaveLength(4);
  });
});

// ─── CITY & AREA — LIVE CENTRES API ──────────────────────────────────────────
// axios.get is NOT mocked here — calls go to the real Footprints centres API.
// jest.spyOn wraps the real function so call counts are trackable.

describe('City and area switching (live centres API)', () => {
  it('city + area in same message — area stored immediately and API fires', async () => {
    const id = 'city-area-same-turn';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    const getSpy = jest.spyOn(axios, 'get');   // wraps real get, tracks calls

    mockClaude({ ext: extraction({ city: 'Bangalore', area: 'HSR Layout' }), reply: 'Here are the centres near you.' });
    const res = await chat(id, 'I am in HSR Layout Bangalore');
    expect(res.body.city).toBe('Bangalore');
    expect(getSpy).toHaveBeenCalledTimes(1);   // area accepted same turn → API fires
    expect(getSpy.mock.calls[0][0]).toContain('HSR');
  });

  it('city typed alone — area blocked that turn, no API call fires', async () => {
    const id = 'city-only-same-turn';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    const getSpy = jest.spyOn(axios, 'get');

    mockClaude({ ext: extraction({ city: 'Bangalore' }), reply: 'Which area in Bangalore?' });
    const res = await chat(id, 'I am in Bangalore');
    expect(res.body.city).toBe('Bangalore');
    expect(getSpy).not.toHaveBeenCalled();     // no area in message → still blocked
  });

  it('area is accepted the turn AFTER city → live API called, centres returned', async () => {
    const id = 'city-then-area';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Turn: city only
    mockClaude({ ext: extraction({ city: 'Bangalore' }), reply: 'Which area?' });
    await chat(id, 'Bangalore');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    const getSpy = jest.spyOn(axios, 'get');

    // Turn: area given — real API call to footprintseducation.in
    mockClaude({ ext: extraction({ area: 'HSR Layout' }), reply: 'Here are the nearest centres...' });
    const res = await chat(id, 'HSR Layout');
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toContain('HSR');
    expect(res.body.reply).toBeTruthy();
  });

  it('switching to a different city resets area and centres — no extra API call', async () => {
    const id = 'city-switch-reset';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // First city (Bangalore)
    mockClaude({ ext: extraction({ city: 'Bangalore' }), reply: 'Which area?' });
    await chat(id, 'Bangalore');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Give area → real API call fires
    mockClaude({ ext: extraction({ area: 'HSR Layout' }), reply: 'Centres near you...' });
    await chat(id, 'HSR Layout');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    const getSpy = jest.spyOn(axios, 'get');

    // Switch city → area + centres should clear; API must NOT fire (area is null)
    mockClaude({ ext: extraction({ city: 'Noida' }), reply: 'Which area in Noida?' });
    const res = await chat(id, 'Actually I moved to Noida');
    expect(res.body.city).toBe('Noida');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('rapidly switching city 3 times with no area — no API calls fired', async () => {
    const id = 'city-rapid-switch';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    const getSpy = jest.spyOn(axios, 'get');

    for (const city of ['Delhi', 'Mumbai', 'Hyderabad']) {
      mockClaude({ ext: extraction({ city }), reply: `Which area in ${city}?` });
      const res = await chat(id, `I am in ${city}`);
      expect(res.body.city).toBe(city);
    }
    // City-only each turn → no area → API never fires
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('escalates after 2 turns with city known but no area extracted', async () => {
    const id = 'area-stuck-1';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    const getSpy = jest.spyOn(axios, 'get');

    mockClaude({ ext: extraction({ city: 'Chennai' }), reply: 'Which area in Chennai?' });
    await chat(id, 'Chennai');          // city detected, area blocked this turn
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ city: 'Chennai' }), reply: 'Which area?' });
    await chat(id, 'Somewhere in Chennai');   // stuckCount → 1
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ city: 'Chennai' }) });
    const res = await chat(id, 'Not sure of my area');   // stuckCount → 2 → escalate
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toContain('senior admissions counsellors');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('escalates after 2 consecutive 0-result API responses', async () => {
    const id = 'zero-results-1';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Give city (area blocked this turn)
    mockClaude({ ext: extraction({ city: 'Noida' }), reply: 'Which area in Noida?' });
    await chat(id, 'Noida');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Mock centres API to return 0 — this tests failedAreaFetches server logic,
    // not the API shape (which is covered by the live-API tests above).
    const getSpy = jest.spyOn(axios, 'get').mockResolvedValue({ data: [] });

    mockClaude({ ext: extraction({ area: 'Unknown Colony' }), reply: 'Nothing found nearby' });
    await chat(id, 'Unknown Colony');       // failedAreaFetches → 1
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    jest.spyOn(axios, 'get').mockResolvedValue({ data: [] });

    mockClaude({ ext: extraction({ area: 'Another Unknown Area' }) });
    const res = await chat(id, 'Another Unknown Area');   // failedAreaFetches → 2 → escalate
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toContain('senior admissions counsellors');
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('all centres from API are injected into Claude system prompt — none silently dropped', async () => {
    // This catches server-side truncation of centersData before it reaches Claude.
    // It does NOT test what Claude chooses to say — that's Claude's job.
    const id = 'centres-all-injected';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ city: 'Bangalore' }), reply: 'Which area?' });
    await chat(id, 'Bangalore');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Area turn — real API fires, centersData is stored
    mockClaude({ ext: extraction({ area: 'HSR Layout' }), reply: 'Here are centres near you.' });
    await chat(id, 'HSR Layout');

    // Find the system prompt sent to Claude in the response call
    const responseCall = postSpy.mock.calls.find(([, b]) => b.max_tokens === 1024);
    expect(responseCall).toBeTruthy();
    const systemPrompt = responseCall[1].system;

    // Independently fetch what the API returned for this exact query
    const { data: apiCentres } = await axios.get(
      'https://www.footprintseducation.in//nearest-centers?q=HSR%20Layout%20Bangalore'
    );
    expect(apiCentres.length).toBeGreaterThan(0);

    // Every centre's Webpage_Title must appear in the system prompt Claude received
    for (const centre of apiCentres) {
      expect(systemPrompt).toContain(centre.Webpage_Title);
    }
  }, 15_000);
});

// ─── META QUESTIONS & EDGE CASES ──────────────────────────────────────────────

describe('Meta questions and edge cases', () => {
  it('escalates immediately on "are you a bot?" before any info is collected', async () => {
    mockClaude({ ext: extraction({ isMetaQuestion: true }) });
    const res = await chat('meta-1', 'Are you a bot?');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toContain('senior admissions counsellors');
  });

  it('escalates on meta question mid-conversation', async () => {
    const id = 'meta-mid-1';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ isMetaQuestion: true }) });
    const res = await chat(id, 'Wait, is this a real person or a bot?');
    expect(res.body.humanTakeover).toBe(true);
  });

  it('suppresses all replies after humanTakeover is set', async () => {
    const id = 'post-takeover-1';
    mockClaude({ ext: extraction({ isMetaQuestion: true }) });
    await chat(id, 'Are you a bot?');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({ ext: extraction({ childName: 'Someone' }) });
    const res = await chat(id, 'Okay now help me');
    expect(res.body.reply).toBeNull();
  });

  it('escalates at turn 14 without a visit booked', async () => {
    const id = 'max-turns-1';
    await driveToPostConcern(id);    // 4 turns

    for (let i = 0; i < 9; i++) {
      jest.resetAllMocks();
      postSpy = jest.spyOn(axios, 'post');
      mockClaude({ ext: extraction(), reply: 'Keep chatting...' });
      await chat(id, 'random question');
    }
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    mockClaude({ ext: extraction() });
    const res = await chat(id, 'one more message');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toContain('senior admissions counsellors');
  });
});

// ─── HUMAN TAKEOVER SIGNALS ──────────────────────────────────────────────────

describe('Human takeover signals', () => {
  it('escalates immediately when parent explicitly asks for a human', async () => {
    mockClaude({ ext: extraction({ isHumanRequest: true }) });
    const res = await chat('htk-human-req-1', 'Can I talk to a real person?');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toBeTruthy();
    // Must NOT have called Claude for a response — server handles directly
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBe(0);
  });

  it('escalates immediately on abusive language', async () => {
    mockClaude({ ext: extraction({ isAbusive: true }) });
    const res = await chat('htk-abuse-1', 'This is absolute garbage, useless bot');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toBeTruthy();
  });

  it('does NOT escalate on first frustration — lets Claude handle it', async () => {
    const id = 'htk-frustration-1';
    await driveToPostConcern(id);   // get past onboarding so Claude handles the reply
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    mockClaude({
      ext:   extraction({ isFrustrated: true }),
      reply: 'I completely understand, let me help you better.',
    });
    const res = await chat(id, 'This is taking too long, not helpful');
    expect(res.body.humanTakeover).toBeFalsy();
    // Claude response call should have fired (not a server bypass)
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBeGreaterThan(0);
  });

  it('escalates on second consecutive frustration signal', async () => {
    const id = 'htk-frustration-2';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // First frustration — no escalation
    mockClaude({ ext: extraction({ isFrustrated: true }), reply: 'I understand…' });
    await chat(id, 'Not helpful at all');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Second frustration — escalate
    mockClaude({ ext: extraction({ isFrustrated: true }) });
    const res = await chat(id, 'Still useless, wasting my time');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toContain('senior admissions counsellors');
  });

  it('escalates immediately on urgency signal with fast-track message', async () => {
    mockClaude({ ext: extraction({ isUrgent: true }) });
    const res = await chat('htk-urgent-1', 'Need admission this week, joining Monday');
    expect(res.body.humanTakeover).toBe(true);
    // Urgency gets a specific fast-track reply, not the generic counsellor message
    expect(res.body.reply).toMatch(/fast-track|quickly|shortly/i);
  });

  it('escalates immediately on corporate / bulk inquiry', async () => {
    mockClaude({ ext: extraction({ isCorporateInquiry: true }) });
    const res = await chat('htk-corporate-1', 'We need a corporate creche for our employees');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toMatch(/corporate|multi-enrollment|senior admissions/i);
  });

  it('escalates immediately when multiple children are mentioned', async () => {
    mockClaude({ ext: extraction({ hasMultipleChildren: true }) });
    const res = await chat('htk-multi-child-1', 'I want to enroll both my kids, ages 2 and 4');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toMatch(/multiple|senior admissions/i);
  });

  it('escalates after same non-general intent repeated 4 turns in a row', async () => {
    // sameIntentCount logic: first 'fee' sets lastIntent, each subsequent same-intent
    // increments the counter. At 3 consecutive same-intent turns → escalate.
    // Using driveToPostConcern first so name/age escalation doesn't fire before
    // sameIntentCount can reach 3.
    const id = 'htk-repeat-intent-1';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    for (let i = 0; i < 3; i++) {
      mockClaude({ ext: extraction({ intent: 'fee' }), reply: 'Fees vary by program.' });
      await chat(id, 'What are the fees?');
      jest.resetAllMocks();
      postSpy = jest.spyOn(axios, 'post');
    }
    // 4th consecutive 'fee' — sameIntentCount hits 3 → escalate
    mockClaude({ ext: extraction({ intent: 'fee' }) });
    const res = await chat(id, 'Tell me the fees again');
    expect(res.body.humanTakeover).toBe(true);
    expect(res.body.reply).toContain('senior admissions counsellors');
  });

  it('resets repeat counter when intent changes — no escalation after reset', async () => {
    const id = 'htk-repeat-reset-1';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Two 'fee' turns (sameIntentCount → 0 then 1)
    for (let i = 0; i < 2; i++) {
      mockClaude({ ext: extraction({ intent: 'fee' }), reply: 'Fees info.' });
      await chat(id, 'fees?');
      jest.resetAllMocks();
      postSpy = jest.spyOn(axios, 'post');
    }
    // Intent changes to 'booking' → counter resets to 0
    mockClaude({ ext: extraction({ intent: 'booking' }), reply: 'Booking info.' });
    await chat(id, 'Can I book a visit?');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Back to 'fee' — counter starts fresh (0), no escalation
    mockClaude({ ext: extraction({ intent: 'fee' }), reply: 'Fees info.' });
    const res = await chat(id, 'fees again');
    expect(res.body.humanTakeover).toBeFalsy();
  });
});

// ─── NAME SPELLING CORRECTION ────────────────────────────────────────────────
// The server stores the name verbatim and sets _nameConfirmationPending when
// nameCorrectionSuggestion is present. On that same turn it returns ONLY the
// confirmation question and skips the age ask (nameJustStored flag). The age
// ask fires on the NEXT turn after the parent responds.

describe('Name spelling correction', () => {
  it('regression: confirmation fires alone — age ask does NOT appear in same reply', async () => {
    // Bug shown in screenshot: both "is it John or jhon?" AND "How old is…"
    // were sent together without waiting for the parent's answer.
    mockClaude({ ext: extraction({ childName: 'jhon', nameCorrectionSuggestion: 'John' }) });
    const res = await chat('name-typo-regression', 'jhon is the name');
    expect(res.status).toBe(200);
    // Confirmation question must be present
    expect(res.body.reply).toMatch(/John/);
    expect(res.body.reply).toMatch(/jhon/);
    // Age contextualAsk (max_tokens 150) must NOT have been called this turn
    const ageCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(ageCalls.length).toBe(0);
    // Claude response call (max_tokens 1024) also skipped — server bypass
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBe(0);
  });

  it('age ask fires on the next turn after parent confirms the corrected spelling', async () => {
    const id = 'name-typo-confirm-yes';
    mockClaude({ ext: extraction({ childName: 'jhon', nameCorrectionSuggestion: 'John' }) });
    await chat(id, 'jhon is the name');   // turn 1 — confirmation sent
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Turn 2: parent accepts "John"
    mockClaude({ ext: extraction({ childName: 'John' }), ask: 'How old is John?' });
    const res = await chat(id, 'Yes, John');
    const ageCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(ageCalls.length).toBeGreaterThan(0);   // age ask fired
    expect(res.body.reply).toContain('John');      // correct name used
  });

  it('age ask fires on the next turn even if parent keeps original spelling', async () => {
    const id = 'name-typo-keep-original';
    mockClaude({ ext: extraction({ childName: 'jhon', nameCorrectionSuggestion: 'John' }) });
    await chat(id, 'jhon is the name');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Turn 2: parent insists it's "jhon" — same name returned by extraction
    mockClaude({ ext: extraction({ childName: 'jhon' }), ask: 'How old is jhon?' });
    const res = await chat(id, "No, it's jhon");
    const ageCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(ageCalls.length).toBeGreaterThan(0);   // age ask fired
  });

  it('age ask fires immediately for valid Indian names — no confirmation round-trip', async () => {
    // Aarav, Vihaan, Dhruv etc. have nameCorrectionSuggestion: null
    mockClaude({
      ext: extraction({ childName: 'Aarav', nameCorrectionSuggestion: null }),
      ask: 'How old is Aarav?',
    });
    const res = await chat('name-indian-valid', 'My son Aarav');
    // Age ask must fire in the same turn — no confirmation detour
    const ageCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(ageCalls.length).toBeGreaterThan(0);
    expect(res.body.reply).not.toMatch(/is it.*or is it/i);
  });

  it('lowercase name like "john" — no confirmation, stored as "John"', async () => {
    // Pure lowercase is not a misspelling — nameCorrectionSuggestion should be null
    mockClaude({
      ext: extraction({ childName: 'john', nameCorrectionSuggestion: null }),
      ask: 'How old is John?',
    });
    const res = await chat('name-lowercase-john', 'john');
    expect(res.status).toBe(200);
    // No confirmation round-trip — age ask fires directly
    const ageCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(ageCalls.length).toBeGreaterThan(0);
    expect(res.body.reply).not.toMatch(/is it.*or is it/i);
  });

  it('if parent skips the confirmation (sends something unrelated) — age ask fires anyway', async () => {
    const id = 'name-typo-skip-confirm';
    mockClaude({ ext: extraction({ childName: 'jhon', nameCorrectionSuggestion: 'John' }) });
    await chat(id, 'jhon is the name');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    // Parent ignores the confirmation and asks about fees instead
    mockClaude({ ext: extraction({ intent: 'fee' }), ask: 'How old is jhon?' });
    const res = await chat(id, 'What are the fees?');
    // _nameConfirmationPending cleared, age ask fires (name accepted as-is)
    const ageCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(ageCalls.length).toBeGreaterThan(0);
  });

  it('does NOT ask confirmation when suggestion differs only in capitalisation (john → John)', async () => {
    // Bug: "john" triggered confirmation even though it's just a capitalisation difference.
    // Fix: server skips _nameConfirmationPending when suggestion.toLowerCase() === raw.toLowerCase()
    mockClaude({
      ext: extraction({ childName: 'john', nameCorrectionSuggestion: 'John' }),
      ask: 'How old is John?',
    });
    const res = await chat('name-caps-only-1', 'My son john');
    // Must go straight to age ask — no confirmation round-trip
    const ageCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(ageCalls.length).toBeGreaterThan(0);
    expect(res.body.reply).not.toMatch(/is it.*or is it/i);
  });

  it('still asks confirmation for genuine spelling differences (jhon → John)', async () => {
    // Confirm the capitalisation guard does not accidentally suppress real typo confirmation
    mockClaude({ ext: extraction({ childName: 'jhon', nameCorrectionSuggestion: 'John' }) });
    const res = await chat('name-typo-still-fires', 'My son jhon');
    expect(res.body.reply).toMatch(/is it.*or is it/i);
    const ageCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(ageCalls.length).toBe(0);
  });
});

// ─── AGE-APPROPRIATE PROGRAM FILTERING ───────────────────────────────────────

describe('Age-appropriate program filtering', () => {
  async function giveNameAndAge(id, age) {
    mockClaude({ ext: extraction({ childName: 'John' }) });
    await chat(id, 'John');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    mockClaude({ ext: extraction({ childAge: age }), reply: 'Which program?' });
    await chat(id, age);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
  }

  it('blocks Pre-School for 7-month-old — concern menu does not fire, Claude explains', async () => {
    const id = 'age-gate-preschool-7mo';
    await giveNameAndAge(id, '7 months');
    mockClaude({ ext: extraction({ program: 'Pre-School' }), reply: 'John is a little young for Pre-School...' });
    const res = await chat(id, 'half day please');
    expect(res.body.concernMenuMessage).toBeFalsy();
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBeGreaterThan(0);
  });

  it('blocks After School for 2-year-old — minimum is 4 years', async () => {
    const id = 'age-gate-afterschool-2yr';
    await giveNameAndAge(id, '2 years');
    mockClaude({ ext: extraction({ program: 'After School' }), reply: 'John is too young for After School...' });
    const res = await chat(id, 'after school');
    expect(res.body.concernMenuMessage).toBeFalsy();
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBeGreaterThan(0);
  });

  it('accepts Pre-School for 2-year-old — concern menu fires normally', async () => {
    const id = 'age-gate-preschool-2yr';
    await giveNameAndAge(id, '2 years');
    mockClaude({ ext: extraction({ program: 'Pre-School' }), reply: 'Great — pre-school for John it is! 👍' });
    const res = await chat(id, 'half day');
    expect(res.body.concernMenuMessage).toBeTruthy();
    expect(res.body.reply).toBeTruthy();
  });

  it('accepts Daycare for 9-month-old — exactly at minimum age', async () => {
    const id = 'age-gate-daycare-9mo';
    await giveNameAndAge(id, '9 months');
    mockClaude({ ext: extraction({ program: 'Daycare' }), reply: 'Perfect — full-day care for John it is! 👍' });
    const res = await chat(id, 'full day daycare');
    expect(res.body.concernMenuMessage).toBeTruthy();
    expect(res.body.reply).toBeTruthy();
  });
});

// ─── ROUTES & UTILITIES ───────────────────────────────────────────────────────

describe('Routes and utilities', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('POST /api/chat returns 400 when conversationId missing', async () => {
    const res = await request(app).post('/api/chat').send({ message: 'hello' });
    expect(res.status).toBe(400);
  });

  it('POST /api/chat returns 400 when message missing', async () => {
    const res = await request(app).post('/api/chat').send({ conversationId: 'x' });
    expect(res.status).toBe(400);
  });

  it('POST /api/reset clears conversation state and bot asks for name again', async () => {
    const id = 'reset-test-1';
    mockClaude({ ext: extraction({ childName: 'Eve' }) });
    await chat(id, 'Eve');
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');

    const resetRes = await request(app).post('/api/reset').send({ conversationId: id });
    expect(resetRes.body.ok).toBe(true);

    mockClaude({ ext: extraction(), ask: "What's your child's name?" });
    await chat(id, 'Hi again');
    const askCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 150);
    expect(askCalls.length).toBeGreaterThan(0);
  });
});
