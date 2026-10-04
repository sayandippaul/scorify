import { getCareerPerformanceByPlayer } from "./careerPerformance.js";

const MAX_DOCUMENTS = 20000;
const FIRESTORE_BASE = "https://firestore.googleapis.com/v1";

const requestedFields = [
  "playerId",
  "playerName",
  "name",
  "matchId",
  "matchID",
  "inningsId",
  "inningsNumber",
  "innings",
  "runs",
  "battingRuns",
  "balls",
  "ballsFaced",
  "wickets",
  "legalBalls",
  "runsConceded",
  "dismissalType",
  "dismissal",
  "status",
  "isOut",
  "dismissed",
  "createdAt",
  "updatedAt",
  "matchDate",
];

const battingStatistics = new Set([
  "runs",
  "strike_rate",
  "batting_average",
  "highest_score",
  "batting_performance",
  "recent_match",
]);
const bowlingStatistics = new Set([
  "wickets",
  "bowling_economy",
  "bowling_performance",
  "recent_match",
]);

const sanitizeErrorMessage = (message) =>
  String(message || "Unknown Firestore error")
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .slice(0, 300);

const decodeValue = (value) => {
  if (!value || typeof value !== "object") return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(decodeValue);
  }
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return null;
};

const decodeFields = (fields = {}) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeValue(value)])
  );

const queryCollection = async ({
  projectId,
  token,
  collection,
  field,
  value,
  fields = requestedFields,
}) => {
  console.info("[api/chat] Firestore query start");
  console.info("[api/chat] collection:", collection);
  const response = await fetch(
    `${FIRESTORE_BASE}/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: collection }],
          ...(Array.isArray(fields)
            ? { select: { fields: fields.map((fieldPath) => ({ fieldPath })) } }
            : {}),
          ...(field && value !== undefined
            ? {
                where: {
                  fieldFilter: {
                    field: { fieldPath: field },
                    op: "EQUAL",
                    value: { stringValue: value },
                  },
                },
              }
            : {}),
          limit: MAX_DOCUMENTS + 1,
        },
      }),
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!response.ok) {
    let firestoreError;
    try {
      firestoreError = (await response.json())?.error;
    } catch {
      firestoreError = null;
    }
    const error = new Error("Firestore query failed.");
    error.status = response.status;
    if (Number.isInteger(firestoreError?.code)) {
      error.firestoreCode = firestoreError.code;
    }
    if (typeof firestoreError?.status === "string") {
      error.firestoreStatus = sanitizeErrorMessage(firestoreError.status);
    }
    if (typeof firestoreError?.message === "string") {
      error.firestoreMessage = sanitizeErrorMessage(firestoreError.message);
    }
    throw error;
  }

  const rows = await response.json();
  const documents = Array.isArray(rows)
    ? rows.filter((row) => row.document).map((row) => row.document)
    : [];

  if (documents.length > MAX_DOCUMENTS) {
    throw new Error("The requested Scorify data exceeds the supported size.");
  }

  const results = documents.map((document) => ({
    ...decodeFields(document.fields),
    documentId: document.name?.split("/").pop() || "",
  }));
  console.info("[api/chat] query completed");
  console.info("[api/chat] documents returned:", results.length);
  return results;
};

const normalizedName = (value) =>
  String(value || "")
    .trim()
    .toLocaleLowerCase();

const nameTokens = (value) =>
  normalizedName(value).split(/\s+/).filter(Boolean);

const isLikelyNameMatch = (playerName, queryName) => {
  const player = normalizedName(playerName);
  const query = normalizedName(queryName);
  if (!player || !query) return false;
  if (player === query) return true;
  if (player.includes(query)) return true;

  const playerTokens = nameTokens(player);
  const queryTokens = nameTokens(query);
  return queryTokens.every((token) =>
    playerTokens.some(
      (playerToken) => playerToken === token || playerToken.startsWith(token)
    )
  );
};

const loadCareerRecords = async ({ projectId, token }) => {
  const [
    matches,
    inningsRecords,
    battingStats,
    bowlingStats,
    deliveries,
    tournaments,
    series,
  ] = await Promise.all(
    [
      "matches",
      "innings",
      "battingStats",
      "bowlingStats",
      "deliveries",
      "tournaments",
      "series",
    ].map((collection) =>
      queryCollection({
        projectId,
        token,
        collection,
        fields: null,
      })
    )
  );

  return {
    matches,
    inningsRecords,
    battingStats,
    bowlingStats,
    deliveries,
    tournaments,
    series,
  };
};

const getPlayerId = async ({ projectId, token, uid, intent }) => {
  if (intent.subject === "self") return uid;
  if (intent.subject !== "named_player") return null;

  const matches = await queryCollection({
    projectId,
    token,
    collection: "players",
    field: "name",
    value: intent.playerName.trim(),
    fields: ["name"],
  });
  const exactMatches = matches.filter(
    (player) => normalizedName(player.name) === normalizedName(intent.playerName)
  );

  if (exactMatches.length === 1) return exactMatches[0].documentId;

  const allPlayers = await queryCollection({
    projectId,
    token,
    collection: "players",
    fields: ["name"],
  });
  const likelyMatches = allPlayers.filter((player) =>
    isLikelyNameMatch(player.name, intent.playerName)
  );

  return likelyMatches.length === 1 ? likelyMatches[0].documentId : null;
};

const getCareerStatsForPlayer = async ({ projectId, token, uid, playerId }) => {
  const [players, records] = await Promise.all([
    queryCollection({
      projectId,
      token,
      collection: "players",
      fields: null,
    }),
    loadCareerRecords({ projectId, token }),
  ]);
  const player =
    players.find((item) =>
      [
        item.documentId,
        item.id,
        item.uid,
        item.playerId,
        item.name,
      ]
        .map(normalizedName)
        .includes(normalizedName(playerId))
    ) || { id: playerId || uid };
  const normalizedPlayer = {
    ...player,
    id: player.uid || player.id || player.playerId || player.documentId || playerId,
  };
  const careerByPlayer = getCareerPerformanceByPlayer(
    [normalizedPlayer],
    records
  );

  return (
    careerByPlayer.get(normalizedName(normalizedPlayer.id)) ||
    careerByPlayer.get(normalizedName(playerId)) ||
    null
  );
};

const toDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

const recordDate = (record) =>
  toDate(record.matchDate) ||
  toDate(record.createdAt) ||
  toDate(record.updatedAt);

const validTimeZone = (value) => {
  if (typeof value !== "string" || value.length > 80) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
};

const dateKey = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const numberValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const formatNumber = (value, digits = 0) =>
  value === null || value === undefined ? "not available" : Number(value).toFixed(digits);

const addRecord = (target, record, kind) => {
  const matchId = String(record.matchId || record.matchID || "").trim();
  if (!matchId) return;

  const match = target.get(matchId) || {
    matchId,
    timestamp: 0,
    date: null,
    runs: 0,
    ballsFaced: 0,
    wickets: 0,
    ballsBowled: 0,
    runsConceded: 0,
    dismissals: 0,
    battingRecords: 0,
    bowlingRecords: 0,
    inningsRuns: new Map(),
    inningsFigures: new Map(),
  };
  const date = recordDate(record);
  if (date && date.getTime() >= match.timestamp) {
    match.timestamp = date.getTime();
    match.date = date;
  }

  const inningsKey = String(
    record.inningsId ||
      record.inningsNumber ||
      record.innings ||
      record.documentId
  );

  if (kind === "batting") {
    const runs = numberValue(record.runs ?? record.battingRuns);
    const balls = numberValue(record.ballsFaced ?? record.balls);
    const dismissal = String(
      record.dismissalType || record.dismissal || record.status || ""
    )
      .trim()
      .toLowerCase();
    match.runs += runs;
    match.ballsFaced += balls;
    match.battingRecords += 1;
    if (
      record.isOut === true ||
      record.dismissed === true ||
      (dismissal &&
        !["not out", "not_out", "not-out", "retired hurt", "yet"].includes(
          dismissal
        ))
    ) {
      match.dismissals += 1;
    }
    match.inningsRuns.set(inningsKey, (match.inningsRuns.get(inningsKey) || 0) + runs);
  } else {
    const wickets = numberValue(record.wickets);
    const balls = numberValue(record.legalBalls ?? record.balls);
    const conceded = numberValue(record.runsConceded ?? record.runs);
    const figures = match.inningsFigures.get(inningsKey) || {
      wickets: 0,
      runsConceded: 0,
    };
    match.wickets += wickets;
    match.ballsBowled += balls;
    match.runsConceded += conceded;
    match.bowlingRecords += 1;
    figures.wickets += wickets;
    figures.runsConceded += conceded;
    match.inningsFigures.set(inningsKey, figures);
  }

  target.set(matchId, match);
};

const readRecords = async ({ projectId, token, playerId, statistic }) => {
  const needsBatting = battingStatistics.has(statistic);
  const needsBowling = bowlingStatistics.has(statistic);
  const needsParticipation = statistic === "matches_played";
  const [batting, bowling, participation] = await Promise.all([
    needsBatting
      ? queryCollection({
          projectId,
          token,
          collection: "battingStats",
          field: "playerId",
          value: playerId,
        })
      : [],
    needsBowling
      ? queryCollection({
          projectId,
          token,
          collection: "bowlingStats",
          field: "playerId",
          value: playerId,
        })
      : [],
    needsParticipation
      ? queryCollection({
          projectId,
          token,
          collection: "matchPlayers",
          field: "playerId",
          value: playerId,
          fields: ["matchId", "playerId"],
        })
      : [],
  ]);
  const matches = new Map();
  batting.forEach((record) => addRecord(matches, record, "batting"));
  bowling.forEach((record) => addRecord(matches, record, "bowling"));

  const matchIds = new Set(
    participation.map((record) => String(record.matchId || "").trim()).filter(Boolean)
  );
  matches.forEach((match, id) => matchIds.add(id));

  return [...matches.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .map((match) => ({ ...match, matchIds }))
    .concat(
      [...matchIds]
        .filter((id) => !matches.has(id))
        .map((matchId) => ({
          matchId,
          timestamp: 0,
          date: null,
          runs: 0,
          ballsFaced: 0,
          wickets: 0,
          ballsBowled: 0,
          runsConceded: 0,
          dismissals: 0,
          battingRecords: 0,
          bowlingRecords: 0,
          inningsRuns: new Map(),
          inningsFigures: new Map(),
          matchIds,
        }))
        .sort((left, right) => right.timestamp - left.timestamp)
    )
    .sort((left, right) => right.timestamp - left.timestamp);
};

const scopedMatches = (matches, timeframe, timeZone) => {
  if (timeframe === "today" || timeframe === "yesterday") {
    const today = dateKey(new Date(), timeZone);
    const yesterday = dateKey(
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      timeZone
    );
    const selected = timeframe === "today" ? today : yesterday;
    return matches.filter((match) => match.date && dateKey(match.date, timeZone) === selected);
  }

  if (timeframe === "last_match") return matches.slice(0, 1);
  if (timeframe === "last_three") return matches.slice(0, 3);
  return matches;
};

const matchCount = (matches) => matches[0]?.matchIds.size || 0;

export const answerFromScorifyData = async ({
  projectId,
  token,
  uid,
  intent,
  timeZone,
}) => {
  if (intent.scope !== "scorify_data" || intent.statistic === "unsupported") {
    return "I can only answer questions using information available in Scorify.";
  }

  const playerId = await getPlayerId({ projectId, token, uid, intent });
  if (!playerId) return "I couldn't find that information in Scorify.";

  if (intent.timeframe === "career") {
    const careerStats = await getCareerStatsForPlayer({
      projectId,
      token,
      uid,
      playerId,
    });
    const playerLabel = intent.subject === "named_player" ? `${intent.playerName}'s` : "Your";

    if (careerStats) {
      switch (intent.statistic) {
        case "runs":
          return `${playerLabel} career batting total is ${formatNumber(careerStats.battingRuns)} runs.`;
        case "strike_rate":
          return `${playerLabel} career strike rate is ${careerStats.strikeRate} (${formatNumber(careerStats.battingRuns)} runs from ${formatNumber(careerStats.ballsFaced)} balls).`;
        case "batting_average":
          return `${playerLabel} batting average is ${careerStats.battingAverage} (${formatNumber(careerStats.battingRuns)} runs, ${formatNumber(careerStats.timesOut)} dismissals).`;
        case "highest_score":
          return `${playerLabel} highest recorded innings score is ${formatNumber(careerStats.highestScore)} runs.`;
        case "wickets":
          return `${playerLabel} career bowling total is ${formatNumber(careerStats.wickets)} wickets.`;
        case "bowling_economy":
          return `${playerLabel} bowling economy is ${careerStats.economy} runs per over (${formatNumber(careerStats.runsConceded)} runs from ${formatNumber(careerStats.totalBowls)} legal balls).`;
        case "matches_played":
          return careerStats.totalMatches
            ? `Scorify has records of ${formatNumber(careerStats.totalMatches)} matches played.`
            : "I couldn't find that information in Scorify.";
        case "batting_performance":
          return `${playerLabel} batting: ${formatNumber(careerStats.battingRuns)} runs from ${formatNumber(careerStats.ballsFaced)} balls, strike rate ${careerStats.strikeRate}.`;
        case "bowling_performance":
          return `${playerLabel} bowling: ${formatNumber(careerStats.wickets)} wickets, ${formatNumber(careerStats.totalBowls)} legal balls, ${formatNumber(careerStats.runsConceded)} runs conceded, economy ${careerStats.economy}.`;
        default:
          break;
      }
    }
  }

  const matches = await readRecords({
    projectId,
    token,
    playerId,
    statistic: intent.statistic,
  });
  const zone = validTimeZone(timeZone);
  if (intent.statistic === "matches_played") {
    const count = matchCount(matches);
    return count
      ? `Scorify has records of ${count} matches played.`
      : "I couldn't find that information in Scorify.";
  }

  if (!matches.length) return "I couldn't find that information in Scorify.";

  const period = scopedMatches(matches, intent.timeframe, zone);
  if (!period.length) return "I couldn't find that information in Scorify.";
  const battingMatches = period.filter((match) => match.battingRecords);
  const bowlingMatches = period.filter((match) => match.bowlingRecords);
  const runs = battingMatches.reduce((sum, match) => sum + match.runs, 0);
  const balls = battingMatches.reduce((sum, match) => sum + match.ballsFaced, 0);
  const wickets = bowlingMatches.reduce((sum, match) => sum + match.wickets, 0);
  const ballsBowled = bowlingMatches.reduce((sum, match) => sum + match.ballsBowled, 0);
  const runsConceded = bowlingMatches.reduce((sum, match) => sum + match.runsConceded, 0);
  const dismissals = battingMatches.reduce(
    (sum, match) => sum + match.dismissals,
    0
  );
  const strikeRate = balls > 0 ? (runs / balls) * 100 : null;
  const economy = ballsBowled > 0 ? (runsConceded / ballsBowled) * 6 : null;
  const playerLabel = intent.subject === "named_player" ? `${intent.playerName}'s` : "Your";

  switch (intent.statistic) {
    case "runs":
      return battingMatches.length
        ? `${playerLabel} ${intent.timeframe === "career" ? "career" : intent.timeframe} batting total is ${formatNumber(runs)} runs.`
        : "I couldn't find that information in Scorify.";
    case "strike_rate":
      return balls > 0
        ? `${playerLabel} ${intent.timeframe === "career" ? "career" : intent.timeframe} strike rate is ${formatNumber(strikeRate, 2)} (${formatNumber(runs)} runs from ${formatNumber(balls)} balls).`
        : "I couldn't find that information in Scorify.";
    case "batting_average": {
      if (!battingMatches.length) return "I couldn't find that information in Scorify.";
      const average = dismissals > 0 ? runs / dismissals : null;
      return `${playerLabel} batting average is ${formatNumber(average, 2)} (${formatNumber(runs)} runs, ${formatNumber(dismissals)} dismissals).`;
    }
    case "highest_score": {
      const scores = matches.flatMap((match) => [...match.inningsRuns.values()]);
      return scores.length
        ? `${playerLabel} highest recorded innings score is ${formatNumber(Math.max(...scores))} runs.`
        : "I couldn't find that information in Scorify.";
    }
    case "wickets":
      return bowlingMatches.length
        ? `${playerLabel} ${intent.timeframe === "career" ? "career" : intent.timeframe} bowling total is ${formatNumber(wickets)} wickets.`
        : "I couldn't find that information in Scorify.";
    case "bowling_economy":
      return ballsBowled > 0
        ? `${playerLabel} bowling economy is ${formatNumber(economy, 2)} runs per over (${formatNumber(runsConceded)} runs from ${formatNumber(ballsBowled)} legal balls).`
        : "I couldn't find that information in Scorify.";
    case "batting_performance":
    case "bowling_performance":
      if (intent.statistic === "batting_performance" && battingMatches.length) {
        return `${playerLabel} batting: ${formatNumber(runs)} runs from ${formatNumber(balls)} balls, strike rate ${formatNumber(strikeRate, 2)}.`;
      }
      if (intent.statistic === "bowling_performance" && bowlingMatches.length) {
        return `${playerLabel} bowling: ${formatNumber(wickets)} wickets, ${formatNumber(ballsBowled)} legal balls, ${formatNumber(runsConceded)} runs conceded, economy ${formatNumber(economy, 2)}.`;
      }
      return "I couldn't find that information in Scorify.";
    case "recent_match":
      return period
        .filter((match) => match.battingRecords || match.bowlingRecords)
        .slice(0, intent.timeframe === "last_three" ? 3 : 1)
        .map(
          (match) =>
            `${match.date ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: zone }).format(match.date) : "Date unavailable"}: ${formatNumber(match.runs)} runs from ${formatNumber(match.ballsFaced)} balls; ${formatNumber(match.wickets)} wickets for ${formatNumber(match.runsConceded)} runs.`
        )
        .join("\n");
    default:
      return "I can only answer questions using information available in Scorify.";
  }
};
