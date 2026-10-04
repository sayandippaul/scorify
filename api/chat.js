import {
  answerCricketQuestion,
  classifyScorifyQuestion,
} from "../server/ai/geminiProvider.js";
import { verifyFirebaseIdToken } from "../server/ai/firebaseAuth.js";
import { answerFromScorifyData } from "../server/ai/scorifyData.js";

const MAX_BODY_BYTES = 12_000;
const MAX_MESSAGE_LENGTH = 1000;
const NO_DATA_MESSAGE = "I couldn't find that information in Scorify.";
const OUT_OF_SCOPE_MESSAGE =
  "I'm Scorify AI. I can help with cricket questions and your Scorify cricket data.";
const GREETING_MESSAGE =
  "Hi! Ask me about cricket, or ask for Scorify stats like \"my runs\", \"Sayandip runs\", \"my wickets\", or \"last match batting\".";
const requestCounts = new Map();
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const logServerError = (stage, error) => {
  const status =
    Number.isInteger(error?.status) ? error.status :
    Number.isInteger(error?.code) ? error.code :
    undefined;
  let reason =
    typeof error?.message === "string" ? error.message : "Unknown server error";

  for (const secret of [process.env.GEMINI_API_KEY]) {
    if (secret) reason = reason.replaceAll(secret, "[redacted]");
  }
  reason = reason
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .slice(0, 300);

  console.error("[api/chat] request failed", {
    stage,
    errorName: typeof error?.name === "string" ? error.name : "Error",
    ...(status ? { status } : {}),
    ...(Number.isInteger(error?.firestoreCode)
      ? { firestoreCode: error.firestoreCode }
      : {}),
    ...(typeof error?.firestoreStatus === "string"
      ? { firestoreStatus: error.firestoreStatus }
      : {}),
    ...(typeof error?.firestoreMessage === "string"
      ? { firestoreMessage: error.firestoreMessage }
      : {}),
    reason,
  });
};

export const config = {
  maxDuration: 30,
};

const sendJson = (res, status, body) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
};

const allowedRequest = (uid) => {
  const now = Date.now();
  if (requestCounts.size > 1000) {
    requestCounts.forEach((entry, key) => {
      if (entry.resetAt <= now) requestCounts.delete(key);
    });
  }
  const current = requestCounts.get(uid);
  if (!current || current.resetAt <= now) {
    requestCounts.set(uid, {
      count: 1,
      resetAt: now + RATE_WINDOW_MS,
    });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_WINDOW) return false;
  current.count += 1;
  return true;
};

const cleanHistory = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-8)
    .filter(
      (item) =>
        item &&
        ["user", "assistant"].includes(item.role) &&
        typeof item.content === "string"
    )
    .map(({ role, content }) => ({
      role,
      content: content.trim().slice(0, 500),
    }))
    .filter(({ content }) => content);
};

const normalizedMessage = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[?!.,]+$/g, "");

const greetingWords = new Set(["hi", "hello", "hey", "hii", "hy"]);
const statisticPatterns = [
  ["strike rate", "strike_rate"],
  ["batting average", "batting_average"],
  ["average", "batting_average"],
  ["highest score", "highest_score"],
  ["high score", "highest_score"],
  ["wickets", "wickets"],
  ["wicket", "wickets"],
  ["economy", "bowling_economy"],
  ["matches played", "matches_played"],
  ["matches", "matches_played"],
  ["runs", "runs"],
  ["run", "runs"],
];

const inferBasicIntent = (message) => {
  const text = normalizedMessage(message);
  if (!text) return null;

  for (const [pattern, statistic] of statisticPatterns) {
    const patternIndex = text.indexOf(pattern);
    if (patternIndex === -1) continue;

    const beforeStatistic = text.slice(0, patternIndex).trim();
    const afterStatistic = text.slice(patternIndex + pattern.length).trim();
    const timeframe =
      text.includes("last three") || text.includes("last 3")
        ? "last_three"
        : text.includes("last match") || text.includes("recent")
          ? "last_match"
          : text.includes("today")
            ? "today"
            : text.includes("yesterday")
              ? "yesterday"
              : "career";
    const selfQuestion =
      /\b(my|me|i|mine)\b/.test(text) ||
      beforeStatistic === "" ||
      beforeStatistic === "total" ||
      beforeStatistic === "career";
    const playerName = selfQuestion
      ? ""
      : beforeStatistic
          .replace(/\b(total|career|last|match|today|yesterday|recent)\b/g, "")
          .trim();

    return {
      scope: "scorify_data",
      subject: playerName ? "named_player" : "self",
      playerName,
      statistic,
      timeframe,
    };
  }

  return null;
};

export default async function handler(req, res) {
  if (req.method === "GET") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  }

  if (
    req.headers["content-type"] &&
    !String(req.headers["content-type"]).toLowerCase().startsWith("application/json")
  ) {
    return sendJson(res, 415, { error: "Content-Type must be application/json." });
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return sendJson(res, 413, { error: "Request is too large." });
  }

  const identity = await verifyFirebaseIdToken(req.headers.authorization);
  if (!identity) {
    return sendJson(res, 401, { error: "Please sign in to use Scorify AI." });
  }

  if (!allowedRequest(identity.uid)) {
    return sendJson(res, 429, {
      error: "Too many requests. Please wait a moment and try again.",
    });
  }

  const body = req.body;
  let bodySize = contentLength;
  if (!bodySize && body !== undefined) {
    try {
      bodySize = Buffer.byteLength(JSON.stringify(body));
    } catch {
      return sendJson(res, 400, { error: "Invalid request body." });
    }
  }
  if (bodySize > MAX_BODY_BYTES) {
    return sendJson(res, 413, { error: "Request is too large." });
  }
  const message =
    body && typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return sendJson(res, 400, {
      error: "Enter a message of 1,000 characters or fewer.",
    });
  }

  let stage = "gemini";
  try {
    const history = cleanHistory(body.history);
    const basicText = normalizedMessage(message);
    if (greetingWords.has(basicText)) {
      return sendJson(res, 200, { answer: GREETING_MESSAGE });
    }

    const localIntent = inferBasicIntent(message);
    let intent;
    try {
      intent = localIntent || (await classifyScorifyQuestion({ message, history }));
    } catch (error) {
      if (!localIntent) throw error;
      console.warn("[api/chat] Gemini classification failed; using local intent fallback.");
      intent = localIntent;
    }
    stage = "firestore";
    let answer;

    if (intent.scope === "scorify_data") {
      answer = await answerFromScorifyData({
        projectId: identity.projectId,
        token: identity.token,
        uid: identity.uid,
        intent,
        timeZone: body.timeZone,
      });
    } else if (intent.scope === "cricket_knowledge") {
      stage = "gemini-answer";
      answer = await answerCricketQuestion({ message, history });
    } else {
      answer = OUT_OF_SCOPE_MESSAGE;
    }

    return sendJson(res, 200, {
      answer: answer || NO_DATA_MESSAGE,
    });
  } catch (error) {
    logServerError(stage, error);
    return sendJson(res, 503, {
      error: "Sorry, I couldn't process that request right now. Please try again.",
    });
  }
}
