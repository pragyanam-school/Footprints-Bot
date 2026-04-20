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
    mockClaude({ ext: extraction({ program: 'Daycare' }) });
    const res = await chat(id, 'I want full day daycare');
    expect(res.body.concernMenuMessage).toBeTruthy();
    expect(res.body.concernMenuOptions).toHaveLength(4);
    expect(res.body.reply).toContain('full-day care');
    expect(res.body.reply).toContain('Leo');
    const responseCalls = postSpy.mock.calls.filter(([, b]) => b.max_tokens === 1024);
    expect(responseCalls.length).toBe(0);   // Call 2 skipped
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
});

// ─── CITY & AREA — LIVE CENTRES API ──────────────────────────────────────────
// axios.get is NOT mocked here — calls go to the real Footprints centres API.
// jest.spyOn wraps the real function so call counts are trackable.

describe('City and area switching (live centres API)', () => {
  it('area is blocked on the same turn city is first detected — no API call fires', async () => {
    const id = 'city-area-same-turn';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    const getSpy = jest.spyOn(axios, 'get');   // wraps real get, tracks calls

    mockClaude({ ext: extraction({ city: 'Bangalore', area: 'HSR Layout' }), reply: 'Which area in Bangalore?' });
    const res = await chat(id, 'I am in HSR Layout Bangalore');
    expect(res.body.city).toBe('Bangalore');
    expect(getSpy).not.toHaveBeenCalled();     // area blocked this turn
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

  it('rapidly switching city 3 times — area always blocked by cityJustDetected, no API calls', async () => {
    const id = 'city-rapid-switch';
    await driveToPostConcern(id);
    jest.resetAllMocks();
    postSpy = jest.spyOn(axios, 'post');
    const getSpy = jest.spyOn(axios, 'get');

    for (const city of ['Delhi', 'Mumbai', 'Hyderabad']) {
      mockClaude({ ext: extraction({ city, area: 'Some Area' }), reply: `In ${city}` });
      const res = await chat(id, `I am in ${city}`);
      expect(res.body.city).toBe(city);
    }
    // City changed every turn → cityJustDetected always true → area always blocked
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
