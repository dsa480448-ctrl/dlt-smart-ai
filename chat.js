// api/chat.js — พร็อกซีเรียก Gemini บน Vercel (เก็บ API Key ไว้ใน Environment Variables)
// รับ:  POST { "messages": [{ "role": "user"|"assistant", "content": "..." }, ...] }
// ตอบ:  { "reply": "..." }  หรือ { "error": "..." }

const fs = require('node:fs');
const path = require('node:path');

const MODELS = [
  process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  ...(process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.1-flash-lite,gemini-3.5-flash')
    .split(',').map((s) => s.trim()).filter(Boolean),
];
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'low'; // low | medium | high | off
const MAX_OUTPUT = Number(process.env.GEMINI_MAX_OUTPUT || 2048);
const PER_MODEL_TIMEOUT_MS = 12000;
const TOTAL_BUDGET_MS = 27000;

let SYSTEM_PROMPT = 'คุณคือผู้ช่วยตอบคำถามเกี่ยวกับกรมการขนส่งทางบก ตอบเป็นภาษาไทย สั้น กระชับ สุภาพ';
try {
  SYSTEM_PROMPT = fs.readFileSync(path.join(process.cwd(), 'api', 'system_prompt.txt'), 'utf8');
} catch (_) {
  /* ใช้พรอมต์สำรองด้านบน */
}

function out(res, code, data) {
  res.status(code).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(data));
}

async function handler(req, res) {
  if (req.method !== 'POST') return out(res, 405, { error: 'Method not allowed' });

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return out(res, 500, { error: 'Server missing GEMINI_API_KEY' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const contents = msgs
    .filter((m) => m && String(m.content || '').trim())
    .slice(-11)
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.content).slice(0, 4000) }],
    }));
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return out(res, 400, { error: 'Empty message' });
  }

  const started = Date.now();
  let lastErr = 'Gemini error';

  for (const model of MODELS) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (left < 3000) break;

    const generationConfig = { maxOutputTokens: MAX_OUTPUT };
    if (THINKING_LEVEL !== 'off') generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(PER_MODEL_TIMEOUT_MS, left));
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig,
          }),
          signal: ctrl.signal,
        }
      );
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const reply = (data?.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || '').join('').trim();
        if (reply) return out(res, 200, { reply });
        lastErr = `${model}: empty reply`;
      } else {
        lastErr = `${model}: ${data?.error?.message || 'HTTP ' + r.status}`;
        if (r.status === 400 || r.status === 401 || r.status === 403) break; // คีย์/พารามิเตอร์ผิด ลองรุ่นอื่นก็ไม่ช่วย
      }
    } catch (e) {
      lastErr = `${model}: ${e?.name === 'AbortError' ? 'timeout' : 'network error'}`;
    } finally {
      clearTimeout(timer);
    }
  }

  return out(res, 502, { error: lastErr });
}

module.exports = handler;
module.exports.config = { maxDuration: 30 };