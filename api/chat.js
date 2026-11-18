// api/chat.js — พร็อกซีเรียก Gemini (เก็บ API Key ไว้ฝั่งเซิร์ฟเวอร์ ผ่าน Environment Variables)
// รับ:  POST { "message": "ข้อความ", "history": [{ "role": "user"|"assistant", "content": "..." }] }
// ตอบ:  { "reply": "ข้อความตอบกลับ" }

export const config = { maxDuration: 30 };

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const TEMPERATURE = Number(process.env.GEMINI_TEMPERATURE ?? 0.6);
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'low';
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 20000);
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'คุณคือผู้ช่วยตอบคำถามเกี่ยวกับสำนักงานขนส่ง (กรมการขนส่งทางบก) ตอบเป็นภาษาไทยสั้น กระชับ สุภาพ';

function out(res, code, data) {
  res.status(code).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(data));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return out(res, 405, { error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return out(res, 500, { error: 'Server missing GEMINI_API_KEY' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const message = String(body.message || '').trim();
  if (!message) return out(res, 400, { error: 'Empty message' });

  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
  const contents = [
    ...history
      .filter((m) => m && m.content)
      .map((m) => ({
        role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(m.content) }],
      })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const generationConfig = { temperature: TEMPERATURE };
  if (THINKING_LEVEL !== 'off') generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
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
    const data = await r.json();
    if (!r.ok) {
      return out(res, 502, { error: data?.error?.message || 'Gemini error' });
    }
    const reply = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    return out(res, 200, { reply: reply || 'ขออภัย ไม่สามารถตอบได้ในขณะนี้' });
  } catch (e) {
    const timeout = e?.name === 'AbortError';
    return out(res, timeout ? 504 : 500, { error: timeout ? 'Timeout' : 'Server error' });
  } finally {
    clearTimeout(timer);
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}