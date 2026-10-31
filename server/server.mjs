// NASA Adapting Farms: tiny local server for the single-file website.
//
//   npm start          (or double-click "Start Dashboard.bat")
//
// Serves index.html and three small API routes:
//   POST /api/assistant  streams a Gemini answer grounded in the dashboard numbers
//   GET  /api/lan-qr     the laptop's Wi-Fi address as a QR code, so a phone can open the page
//   GET  /sw.js          removes the old design's offline service worker from browsers that had it
// The Gemini key is read from .env.local on this machine and never reaches the browser.

import http from 'node:http'
import os from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GoogleGenAI } from '@google/genai'
import QRCode from 'qrcode'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT) || 5173

// ---- settings from .env / .env.local (KEY=value lines) ----------------
const env = {}
for (const file of ['.env', '.env.local']) {
  const path = join(root, file)
  if (!existsSync(path)) continue
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const apiKey = env.GEMINI_API_KEY?.trim()
const models = [env.GEMINI_MODEL?.trim() || 'gemini-flash-latest', 'gemini-flash-lite-latest']
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address
    }
  }
  return null
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const SYSTEM = {
  vi: `Bạn là trợ lý nông nghiệp của dự án NASA Adapting Farms, nói chuyện với nông dân Việt Nam.
Trả lời bằng tiếng Việt, ngắn gọn (tối đa khoảng 120 từ), dễ hiểu, không dùng thuật ngữ khó mà không giải thích.
Chỉ dựa vào số liệu ruộng bên dưới; không bịa thêm số liệu. Nếu số liệu là mô phỏng, có thể nhắc nhẹ.
Không đưa liều lượng hóa chất hay thuốc bảo vệ thực vật cụ thể; khi cần, khuyên hỏi cán bộ khuyến nông địa phương.
Không dùng markdown phức tạp; có thể dùng gạch đầu dòng đơn giản.`,
  en: `You are the farm assistant for the NASA Adapting Farms project, talking with smallholder farmers.
Answer in English, briefly (about 120 words at most), in plain words; explain any technical term you use.
Rely only on the farm data below; never invent numbers. If the data is simulated, you may mention it.
Do not give specific chemical or pesticide doses; when needed, suggest asking a local extension officer.
Avoid heavy markdown; simple bullet points are fine.`,
}

// A service worker that deletes its caches, unregisters itself and reloads the page.
// Browsers that ran the old design's offline mode fetch this and are cleaned up.
const SELF_DESTROYING_SW = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key)
    await self.registration.unregister()
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url)
  })())
})`

async function assistant(req, res) {
  if (!ai) {
    res.statusCode = 503
    return res.end('assistant not configured')
  }
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    res.statusCode = 400
    return res.end('bad request')
  }
  const lang = body.lang === 'en' ? 'en' : 'vi'
  const messages = Array.isArray(body.messages) ? body.messages.slice(-10) : []
  const contents = messages
    .filter((m) => typeof m?.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text.slice(0, 1500) }] }))
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    res.statusCode = 400
    return res.end('bad request')
  }
  const systemInstruction = `${SYSTEM[lang]}\n\nFarm data (JSON):\n${JSON.stringify(body.context ?? {}).slice(0, 8000)}`

  // When the main model is busy (Google returns 503 "high demand"), try the lighter one before giving up;
  // the page falls back to its rule-based answers if both fail.
  for (const model of models) {
    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: { systemInstruction, temperature: 0.4, maxOutputTokens: 800 },
      })
      for await (const chunk of stream) {
        if (!chunk.text) continue
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
        }
        res.write(chunk.text)
      }
      return res.end()
    } catch (err) {
      console.error(`[assistant] ${model}:`, err?.message ?? err)
      if (res.headersSent) return res.end()
    }
  }
  res.statusCode = 502
  res.end()
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0]
  try {
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      return res.end(readFileSync(join(root, 'index.html')))
    }
    if (req.method === 'GET' && url === '/sw.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      return res.end(SELF_DESTROYING_SW)
    }
    if (req.method === 'GET' && url === '/api/lan-qr') {
      const ip = lanAddress()
      res.setHeader('Content-Type', 'application/json')
      if (!ip) {
        res.statusCode = 404
        return res.end('{}')
      }
      const target = `http://${ip}:${PORT}/`
      const svg = await QRCode.toString(target, { type: 'svg', margin: 1, color: { dark: '#0b2e1b', light: '#ffffff' } })
      return res.end(JSON.stringify({ url: target, svg }))
    }
    if (req.method === 'POST' && url === '/api/assistant') return assistant(req, res)
    res.statusCode = 404
    res.end('not found')
  } catch (err) {
    console.error(err)
    if (!res.headersSent) res.statusCode = 500
    res.end()
  }
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Close the other dashboard window and try again.\n`)
  else console.error(err)
  process.exit(1)
})

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress()
  console.log('\n  NASA Adapting Farms is running')
  console.log(`  On this laptop:  http://localhost:${PORT}/`)
  if (ip) console.log(`  On a phone:      http://${ip}:${PORT}/  (same Wi-Fi)`)
  console.log(`  AI assistant:    ${ai ? 'connected (Gemini key found)' : 'sample answers (no key in .env.local)'}`)
  console.log('\n  Keep this window open. Close it to stop.\n')
})
