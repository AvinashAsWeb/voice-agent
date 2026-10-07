# Gemini Voice Agent + Usage/Cost Dashboard

A real-time voice agent built on the Gemini Live API, with a protected dashboard that tracks sessions, duration, token/audio usage and estimated cost.

## Setup

1. Node.js 18 or newer.
2. `npm install`
3. Copy `.env.example` to `.env` and add your `GEMINI_API_KEY` (from aistudio.google.com).
4. `npm start`
5. Voice agent: `http://localhost:3000`  ·  Dashboard: `http://localhost:3000/dashboard` (login from `.env`, default admin / admin123).

Use headphones while testing so the agent does not hear its own voice.

## Architecture

```
Browser widget (mic + speaker)
   | WebSocket /agent  (16 kHz PCM up, 24 kHz PCM down, JSON events)
Node.js server (Express + ws)  -- keeps the API key on the server
   | Gemini Live API (@google/genai, live.connect)
   | usageMetadata + transcripts per turn
data.json (sessions, turns, usage, cost)
   | /api/stats, /api/sessions/:id  (basic auth)
Dashboard (HTML + Chart.js, refreshes every 5 s)
```

- **Speech-to-speech:** native-audio Live model, audio streamed both ways.
- **Interruptions / turn-taking:** Gemini's built-in voice activity detection sends `interrupted`; the client stops playback and clears its queue instantly.
- **Personas:** `PERSONAS` in `server.js`, sent as `systemInstruction`. Add a new key to add a persona.
- **Logging:** each turn stores user/agent transcripts, timestamps and token usage split by modality (audio/text, input/output).
- **Cost:** `tokens x price per 1M` using the `PRICE_*` values in `.env`. Update them when Google changes pricing.

## Assumptions

- Usage is taken from the `usageMetadata` Gemini sends with each turn and summed per session.
- Prices in `.env.example` are placeholders; verify on the official Gemini pricing page.
- JSON-file storage is used for the MVP.

## Production path

- Database: PostgreSQL (Supabase) instead of `data.json`.
- Dashboard: Next.js/React with proper user accounts (NextAuth / Supabase Auth).
- Hosting: backend on Google Cloud Run / Render / Railway (WebSocket support), dashboard on Vercel, secrets in environment variables.
- Phone line: Twilio Media Streams -> convert 8 kHz mu-law to 16 kHz PCM -> same backend.
- Embedding: load the widget page in an iframe or package it as a `<script>` widget for any website.
