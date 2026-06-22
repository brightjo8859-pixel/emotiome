// Emotiome image generation API for Vercel
// OPENAI_API_KEY must be stored in Vercel Environment Variables.
// Optional for reliable daily IP limit: KV_REST_API_URL + KV_REST_API_TOKEN.

const DAILY_LIMIT = 3;
const DAY_SECONDS = 60 * 60 * 24;
const memoryHits = globalThis.__emotiomeHits || (globalThis.__emotiomeHits = new Map());

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function kvCommand(command) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const res = await fetch(`${url}/${command.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) throw new Error(`KV error: ${res.status}`);
  return await res.json();
}

async function checkRateLimit(ip) {
  const key = `emotiome:daily:${todayKey()}:${ip}`;

  if ((process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
      (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)) {
    const incr = await kvCommand(['incr', key]);
    const count = Number(incr?.result || 0);
    if (count === 1) await kvCommand(['expire', key, String(DAY_SECONDS)]);
    return { allowed: count <= DAILY_LIMIT, count, remaining: Math.max(0, DAILY_LIMIT - count) };
  }

  // Fallback only. Not reliable across multiple serverless instances.
  const now = Date.now();
  const current = memoryHits.get(key) || { count: 0, expiresAt: now + DAY_SECONDS * 1000 };
  if (now > current.expiresAt) {
    current.count = 0;
    current.expiresAt = now + DAY_SECONDS * 1000;
  }
  current.count += 1;
  memoryHits.set(key, current);
  return { allowed: current.count <= DAILY_LIMIT, count: current.count, remaining: Math.max(0, DAILY_LIMIT - current.count) };
}

function dataUrlToParts(dataUrl) {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data.');
  return {
    mime: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server.' });
    }

    const ip = getClientIp(req);
    const limit = await checkRateLimit(ip);

    if (!limit.allowed) {
      return res.status(429).json({
        error: '오늘의 무료 생성 3회를 모두 사용했습니다. 내일 다시 시도해주세요.',
        remaining: 0
      });
    }

    const { imageDataUrl, prompt } = req.body || {};
    if (!imageDataUrl || !prompt) {
      return res.status(400).json({ error: 'Image and prompt are required.' });
    }

    const { mime, buffer } = dataUrlToParts(imageDataUrl);

    const form = new FormData();
    const blob = new Blob([buffer], { type: mime || 'image/png' });
    form.append('image', blob, 'identity_reference.png');
    form.append('prompt', prompt);
    form.append('model', 'gpt-image-1');
    form.append('size', '1024x1536');
    form.append('quality', 'high');
    form.append('input_fidelity', 'high');

    const openaiRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });

    const data = await openaiRes.json().catch(() => ({}));

    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json({
        error: data?.error?.message || 'OpenAI image generation failed.'
      });
    }

    const resultB64 = data?.data?.[0]?.b64_json;
    if (!resultB64) return res.status(500).json({ error: 'No image was returned.' });

    return res.status(200).json({
      image: `data:image/png;base64,${resultB64}`,
      remaining: limit.remaining
    });

  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Server error.' });
  }
}
