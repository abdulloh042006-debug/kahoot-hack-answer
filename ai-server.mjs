import http from "node:http";

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const PORT = Number(process.env.PORT || 8787);

if (!API_KEY) {
  console.error("GROQ_API_KEY topilmadi.");
  process.exit(1);
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 120000) throw new Error("Request too large");
  }
  return JSON.parse(raw || "{}");
}

function extractJson(text) {
  const s = String(text || "").trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("Groq valid JSON qaytarmadi");
}

function sanitize(r, payload) {
  const actions = new Set(["choice", "text", "puzzle", "poll", "none"]);
  const confs = new Set(["high", "medium", "low"]);
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const tiles = Array.isArray(payload.puzzle_tiles) ? payload.puzzle_tiles.map(x => String(x?.text || "")) : [];
  let idx = Array.isArray(r?.answer_indices) ? [...new Set(r.answer_indices.filter(Number.isInteger))] : [];
  idx = idx.filter(i => i >= 0 && i < choices.length);
  let order = Array.isArray(r?.puzzle_order) ? r.puzzle_order.map(String) : [];
  if ((r?.action || "") === "puzzle") {
    const rem = [...tiles], good = [];
    for (const x of order) {
      const i = rem.indexOf(x);
      if (i >= 0) { good.push(rem[i]); rem.splice(i, 1); }
    }
    order = good.length === tiles.length ? good : [];
  } else {
    order = [];
  }
  return {
    action: actions.has(r?.action) ? r.action : "none",
    confidence: confs.has(r?.confidence) ? r.confidence : "low",
    answer_indices: idx,
    answer_texts: choices.map(x => String(x?.text || "")),
    text_answer: String(r?.text_answer || "").slice(0, 500),
    puzzle_order: order,
    explanation: String(r?.explanation || "").slice(0, 500),
    provider: "groq",
    model: MODEL
  };
}

async function solve(payload) {
  const type = String(payload.question_type || "unknown");
  const question = String(payload.question || "").trim().slice(0, 1800);
  const pageText = String(payload.page_text || "").trim().slice(0, 4500);
  const choices = Array.isArray(payload.choices)
    ? payload.choices.slice(0, 12).map((x, i) => ({
        index: Number.isInteger(x?.index) ? x.index : i,
        text: String(x?.text || "").slice(0, 900)
      }))
    : [];
  const puzzle = Array.isArray(payload.puzzle_tiles)
    ? payload.puzzle_tiles.slice(0, 12).map((x, i) => ({
        index: Number.isInteger(x?.index) ? x.index : i,
        text: String(x?.text || "").slice(0, 500)
      }))
    : [];

  if (!question && !pageText) throw new Error("DOM text topilmadi");

  if (type === "poll") {
    return {
      action: "poll",
      confidence: "high",
      answer_indices: [],
      answer_texts: choices.map(x => x.text),
      text_answer: "",
      puzzle_order: [],
      explanation: "Poll savolida obyektiv to'g'ri javob yo'q.",
      provider: "groq",
      model: MODEL
    };
  }

  const system = [
    "Solve quiz questions from TEXT extracted from the live webpage DOM.",
    "No screenshot, hidden answer key, image pixels, or audio is provided.",
    "Return ONLY valid JSON with keys action, confidence, answer_indices, text_answer, puzzle_order, explanation.",
    "action must be choice, text, puzzle, poll, or none.",
    "confidence must be high, medium, or low.",
    "quiz/true-false: choice with zero-based correct index.",
    "multi-select: choice with ALL correct zero-based indices.",
    "open-ended: text with concise text_answer.",
    "puzzle: puzzle_order must contain EVERY supplied tile text exactly once in correct order.",
    "poll: action=poll.",
    "If text is insufficient or depends on unseen image/audio: action=none, confidence=low.",
    "Never return choice indices outside supplied choices."
  ].join("\n");

  const user = {
    question_type: type,
    question,
    choices,
    puzzle_tiles: puzzle,
    visible_page_text: pageText,
    question_number: payload.question_number ?? null
  };

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ],
      temperature: 0,
      max_completion_tokens: 320,
      response_format: { type: "json_object" }
    })
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || ("Groq HTTP " + r.status));

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq javobi bo'sh");

  return sanitize(extractJson(text), user);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    });
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, provider: "groq", model: MODEL });
  }

  if (req.method !== "POST" || req.url !== "/solve") {
    return send(res, 404, { error: "Not found" });
  }

  try {
    send(res, 200, await solve(await readBody(req)));
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e?.message || String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Groq Kahoot helper: http://127.0.0.1:" + PORT + " | model=" + MODEL);
});