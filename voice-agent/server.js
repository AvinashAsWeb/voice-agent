// Gemini Live voice agent + usage/cost dashboard backend
import 'dotenv/config';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-native-audio-preview-09-2025';
const DASH_USER = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS = process.env.DASHBOARD_PASS || 'admin123';

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is missing. Create a .env file (see .env.example).');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---------- Pricing (USD per 1M tokens) ----------
const PRICING = {
  inputText: Number(process.env.PRICE_INPUT_TEXT ?? 0.5),
  inputAudio: Number(process.env.PRICE_INPUT_AUDIO ?? 3.0),
  outputText: Number(process.env.PRICE_OUTPUT_TEXT ?? 2.0),
  outputAudio: Number(process.env.PRICE_OUTPUT_AUDIO ?? 12.0),
};

// ---------- Personas (configurable system prompts) ----------
const PERSONAS = {
  receptionist: {
    name: 'Clinic receptionist',
    prompt:
      'You are a friendly receptionist at a dental clinic. Help callers book, reschedule or cancel appointments, ' +
      'answer questions about timings and services, and keep answers short and spoken-friendly. ' +
      'If you do not know something, say you will have the staff call back.',
  },
  support: {
    name: 'Customer support',
    prompt:
      'You are a calm, helpful customer support agent for an online store. Ask clarifying questions, ' +
      'solve order, delivery and refund issues step by step, and keep each reply under three sentences.',
  },
  tutor: {
    name: 'English tutor',
    prompt:
      'You are a patient spoken-English tutor. Have a natural conversation, gently correct mistakes, ' +
      'and suggest one better phrasing at a time. Speak slowly and simply.',
  },
};

// ---------- Storage (JSON file; swap for Postgres in production) ----------
const DB_FILE = path.join(__dirname, 'data.json');
let db = { sessions: [] };
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {
  /* first run */
}
// Sessions left "active" by a crash/restart are closed at their last activity
for (const s of db.sessions) {
  if (s.status === 'active') {
    s.status = 'completed';
    s.endedAt = s.lastActivity || s.startedAt;
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), (err) => err && console.error('Save failed:', err));
  }, 300);
}

function calcCost(u) {
  return (
    (u.inputText * PRICING.inputText +
      u.inputAudio * PRICING.inputAudio +
      u.outputText * PRICING.outputText +
      u.outputAudio * PRICING.outputAudio) /
    1e6
  );
}

// Adds one turn's usageMetadata from Gemini to the session totals
function applyUsage(s, u) {
  const pd = u.promptTokensDetails || [];
  const rd = u.responseTokensDetails || [];
  if (pd.length) {
    for (const d of pd) {
      if (d.modality === 'AUDIO') s.usage.inputAudio += d.tokenCount || 0;
      else s.usage.inputText += d.tokenCount || 0;
    }
  } else {
    s.usage.inputText += u.promptTokenCount || 0;
  }
  if (rd.length) {
    for (const d of rd) {
      if (d.modality === 'AUDIO') s.usage.outputAudio += d.tokenCount || 0;
      else s.usage.outputText += d.tokenCount || 0;
    }
  } else {
    s.usage.outputAudio += u.responseTokenCount || 0;
  }
  s.usage.total = s.usage.inputText + s.usage.inputAudio + s.usage.outputText + s.usage.outputAudio;
  s.cost = calcCost(s.usage);
}

// ---------- HTTP ----------
const app = express();

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const [user, pass] = Buffer.from(header.split(' ')[1] || '', 'base64').toString().split(':');
  if (user === DASH_USER && pass === DASH_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Usage dashboard"');
  res.status(401).send('Login required');
}

app.use(express.static(path.join(__dirname, 'public'))); // voice widget (public)
app.use('/dashboard', auth, express.static(path.join(__dirname, 'dashboard'))); // dashboard (protected)

app.get('/api/personas', (req, res) => {
  res.json(Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name })));
});

function durationSec(s, now) {
  const end = s.endedAt ? Date.parse(s.endedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(s.startedAt)) / 1000));
}

function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

app.get('/api/stats', auth, (req, res) => {
  const now = Date.now();
  const sessions = db.sessions;

  const summary = {
    active: 0,
    completed: 0,
    totalTokens: 0,
    audioInTokens: 0,
    audioOutTokens: 0,
    totalCost: 0,
    avgDurationSec: 0,
  };
  let durSum = 0;
  const daily = {};
  const weekly = {};

  // Last 14 days, empty days included so the chart has no gaps
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    daily[d] = { date: d, sessions: 0, tokens: 0, cost: 0 };
  }

  for (const s of sessions) {
    if (s.status === 'active') summary.active++;
    else summary.completed++;
    summary.totalTokens += s.usage.total;
    summary.audioInTokens += s.usage.inputAudio;
    summary.audioOutTokens += s.usage.outputAudio;
    summary.totalCost += s.cost;
    durSum += durationSec(s, now);

    const d = s.startedAt.slice(0, 10);
    if (daily[d]) {
      daily[d].sessions++;
      daily[d].tokens += s.usage.total;
      daily[d].cost += s.cost;
    }
    const w = weekStart(d);
    weekly[w] = weekly[w] || { week: w, sessions: 0, tokens: 0, cost: 0 };
    weekly[w].sessions++;
    weekly[w].tokens += s.usage.total;
    weekly[w].cost += s.cost;
  }
  summary.avgDurationSec = sessions.length ? Math.round(durSum / sessions.length) : 0;

  res.json({
    model: MODEL,
    pricing: PRICING,
    summary,
    daily: Object.values(daily),
    weekly: Object.values(weekly).sort((a, b) => a.week.localeCompare(b.week)).slice(-8),
    sessions: sessions
      .slice(-100)
      .reverse()
      .map((s) => ({
        id: s.id,
        persona: PERSONAS[s.persona]?.name || s.persona,
        status: s.status,
        startedAt: s.startedAt,
        durationSec: durationSec(s, now),
        usage: s.usage,
        cost: s.cost,
        turns: s.turns.length,
      })),
  });
});

app.get('/api/sessions/:id', auth, (req, res) => {
  const s = db.sessions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json(s);
});

// ---------- WebSocket: browser <-> server <-> Gemini Live ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/agent' });

wss.on('connection', (ws) => {
  let gemini = null;
  let session = null;
  let pendingUsage = null;
  let userText = '';
  let agentText = '';

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  const commitTurn = () => {
    if (!session) return;
    if (pendingUsage) {
      applyUsage(session, pendingUsage);
      pendingUsage = null;
    }
    const at = new Date().toISOString();
    if (userText.trim()) session.turns.push({ role: 'user', text: userText.trim(), at });
    if (agentText.trim()) session.turns.push({ role: 'agent', text: agentText.trim(), at });
    userText = '';
    agentText = '';
    session.lastActivity = at;
    save();
  };

  const finish = () => {
    if (!session || session.status === 'completed') return;
    commitTurn();
    session.status = 'completed';
    session.endedAt = new Date().toISOString();
    save();
    try {
      gemini?.close();
    } catch {
      /* already closed */
    }
  };

  ws.on('message', async (data, isBinary) => {
    // Binary frames = 16 kHz 16-bit mono PCM from the mic
    if (isBinary) {
      if (gemini && session?.status === 'active') {
        gemini.sendRealtimeInput({
          audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' },
        });
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'start' && !session) {
      const personaId = PERSONAS[msg.persona] ? msg.persona : 'receptionist';
      const now = new Date().toISOString();
      session = {
        id: crypto.randomUUID(),
        persona: personaId,
        model: MODEL,
        status: 'active',
        startedAt: now,
        lastActivity: now,
        endedAt: null,
        usage: { inputText: 0, inputAudio: 0, outputText: 0, outputAudio: 0, total: 0 },
        cost: 0,
        turns: [],
      };
      db.sessions.push(session);
      save();

      try {
        gemini = await ai.live.connect({
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: { parts: [{ text: PERSONAS[personaId].prompt }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
          callbacks: {
            onopen: () => console.log(`Session ${session.id} connected to Gemini`),
            onmessage: (m) => {
              if (m.usageMetadata) pendingUsage = m.usageMetadata;
              const sc = m.serverContent;
              if (!sc) return;
              if (sc.inputTranscription?.text) {
                userText += sc.inputTranscription.text;
                send({ type: 'transcript', role: 'user', text: sc.inputTranscription.text });
              }
              if (sc.outputTranscription?.text) {
                agentText += sc.outputTranscription.text;
                send({ type: 'transcript', role: 'agent', text: sc.outputTranscription.text });
              }
              for (const part of sc.modelTurn?.parts || []) {
                if (part.inlineData?.data) send({ type: 'audio', data: part.inlineData.data });
              }
              if (sc.interrupted) {
                send({ type: 'interrupted' }); // client stops playback immediately
                commitTurn();
              }
              if (sc.turnComplete) {
                send({ type: 'turn_complete' });
                commitTurn();
              }
            },
            onerror: (e) => {
              console.error('Gemini error:', e?.message || e);
              send({ type: 'error', message: e?.message || 'Gemini connection error' });
            },
            onclose: (e) => {
              console.log(`Session ${session?.id} closed`, e?.reason || '');
              send({ type: 'closed', reason: e?.reason || '' });
              finish();
            },
          },
        });
        send({ type: 'ready', sessionId: session.id });
      } catch (e) {
        console.error('Could not connect to Gemini:', e?.message || e);
        send({ type: 'error', message: 'Could not connect to Gemini: ' + (e?.message || e) });
        finish();
      }
    }

    if (msg.type === 'stop') {
      finish();
      ws.close();
    }
  });

  ws.on('close', finish);
});

server.listen(PORT, () => {
  console.log(`Voice agent:  http://localhost:${PORT}`);
  console.log(`Dashboard:    http://localhost:${PORT}/dashboard  (user: ${DASH_USER})`);
  console.log(`Model:        ${MODEL}`);
});
