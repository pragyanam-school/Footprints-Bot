# Footprints Payal — WhatsApp AI Bot

## Project Structure
```
footprints-bot/
├── server.js          # Main backend server
├── centers.json       # All center data (update this as centers are added)
├── .env               # Your secrets (never commit this)
├── .env.example       # Template for .env
├── package.json
└── public/
    └── index.html     # Test UI (WhatsApp simulator)
```

---

## Local Setup (first time)

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Then open .env and fill in your API keys

# 3. Start the server
npm start
# or for auto-reload during development:
npm run dev

# 4. Open the test UI
# Go to: http://localhost:3000
```

---

## Environment Variables (.env)

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `WATI_API_TOKEN` | Wati Dashboard → API |
| `WATI_SERVER_ID` | Wati Dashboard → API (the number in your API URL) |

---

## Deploying to Railway (Recommended — Free Tier Available)

Railway is the easiest option. Takes ~5 minutes.

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit — Footprints Payal bot"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/footprints-bot.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to **railway.app** and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `footprints-bot` repo
4. Railway auto-detects Node.js and deploys

### Step 3 — Add Environment Variables on Railway
1. Go to your project → **Variables**
2. Add:
   - `ANTHROPIC_API_KEY` = your key
   - `WATI_API_TOKEN` = your key
   - `WATI_SERVER_ID` = your server ID

### Step 4 — Get Your Public URL
Railway gives you a URL like: `https://footprints-bot-production.up.railway.app`

---

## Connecting Wati Webhook

Once deployed, go to your **Wati Dashboard**:
1. Settings → **Webhook**
2. Set webhook URL to: `https://YOUR_RAILWAY_URL/webhook/wati`
3. Enable **incoming messages**
4. Save

Now when a parent sends a WhatsApp message, Wati sends it to your server → Payal responds → reply goes back on WhatsApp. ✅

---

## How the Wati Webhook Payload Looks

```json
{
  "waId": "919876543210",
  "senderName": "Rahul Sharma",
  "text": "Hi, I want to know about admissions"
}
```

The `waId` is the parent's phone number — used as their unique conversation ID.

---

## Alternative Deployment Options

| Platform | Pros | Cons |
|---|---|---|
| **Railway** | Easiest, free tier, auto-deploy from GitHub | Free tier has limits |
| **Render** | Free tier, similar to Railway | Sleeps after 15min on free tier |
| **DigitalOcean App Platform** | ₹1,500/mo, reliable | Paid |
| **AWS Elastic Beanstalk** | Scalable | Complex setup |
| **Your own VPS** (DigitalOcean Droplet) | Full control, ₹800/mo | Needs manual setup |

For Footprints' scale, **Railway or Render** is perfect to start. Move to DigitalOcean App Platform once you're confident.

---

## Passing Parent Name from Wati

When a parent enquires on your website and fills the form, your CRM or website should:
1. Send a **WhatsApp template message** to the parent via Wati (using their name from the form)
2. The `senderName` in subsequent webhook calls will be from their WhatsApp profile

For the **first message**, you can enrich by passing the form name separately. Contact Wati support about pre-filling `senderName` from your CRM data.

---

## Updating Center Data

Edit `centers.json` to add/remove centers. Each center needs:
```json
{
  "city": "City Name",
  "area": "Center Name",
  "addr": "Full address",
  "lmk": "Landmark",
  "near": "Nearby areas, comma, separated",
  "map": "https://maps.app.goo.gl/...",
  "tier": "A"
}
```

Fee tiers (A=highest, G=lowest):
- **A**: ₹14,499 registration (Bengaluru premium, DLF Gurgaon, Noida Sec 51/62)
- **B**: ₹12,999 (Most Bengaluru, Noida)
- **C**: ₹11,999 (Delhi)
- **D**: ₹11,499 (Pune, Mumbai, Ghaziabad, Chennai)
- **E**: ₹10,999 (Lucknow, Jaipur, Faridabad, Greater Noida)
- **F**: ₹9,999 (Indore, Ahmedabad, Bhubaneswar)
- **G**: ₹8,999 (Patna, Srinagar, Udaipur, Gwalior)

---

## Production Considerations (When You Scale)

- **Conversation storage**: Replace the in-memory `Map` in server.js with **Redis** — conversations currently reset if server restarts
- **Rate limiting**: Add rate limiting per phone number to prevent abuse
- **Logging**: Add proper logging (Winston or Pino) to track conversations
- **Human handoff**: When Payal says "let me check with my senior", trigger a notification to your sales team (Slack/email)
# Footprints-Bot
