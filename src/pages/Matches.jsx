import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  collection,
  getDocs,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import "./matches.css";
import { calculateWinPrediction, getPredictionForDelivery } from "../services/winPrediction";
import {
  getCareerPerformanceStats,
  getCareerPerformanceByPlayer,
  loadCareerRecords,
} from "../services/careerPerformance";
import { db } from "../firebase/firebase";
import { ADMIN_UID } from "../config/security";
import {
  saveMatch,
  saveTeam,
  subscribeToMatches,
  subscribeToPlayers,
  subscribeToTeams,
  subscribeToTeamPlayers,
  getCurrentUserId,
  deleteMatchCascade,
} from "../services/matchService";

const PLAYER_STORAGE_KEY = "cricket_players";
const MATCH_STORAGE_KEY = "cricket_matches";
const TEAM_STORAGE_KEY = "cricket_teams";

const emptyTeam = {
  name: "",
  captain: null,
  players: [],
};

const TOSS_FLIP_MS = 2000;

function CoinFlip({ result, spinning = false }) {
  const normalizedResult = result === "Heads" ? "Heads" : result === "Tails" ? "Tails" : null;
  const stateClass = normalizedResult
    ? `coin-stage-result coin-stage-${normalizedResult.toLowerCase()}`
    : spinning
      ? "coin-stage-spin"
      : "coin-stage-spin";

  return (
    <div className={`coin-stage ${stateClass}`}>
      <div className="coin-3d">
        <div className="coin-face coin-heads">H</div>
        <div className="coin-face coin-tails">T</div>
      </div>
      {normalizedResult ? (
        <p className="coin-side-label">{normalizedResult}</p>
      ) : (
        <p className="coin-side-label">Flipping...</p>
      )}
    </div>
  );
}

const scorecardPlayerId = (player) =>
  String(
    player?.id ??
      player?._id ??
      player?.playerId ??
      player?.name ??
      ""
  );

const scorecardPlayerName = (player) =>
  player?.name || player?.playerName || "Unknown Player";

const isScorecardSubstitute = (match, teamId, player) => {
  const teamKey = ["A", "B"].includes(String(teamId))
    ? String(teamId)
    : String(match?.teamA?.id || match?.teamAId || "") === String(teamId)
      ? "A"
      : String(match?.teamB?.id || match?.teamBId || "") === String(teamId)
        ? "B"
        : String(teamId);
  const basePlayers = match?.scoringState?.baseRosters?.[teamKey] || [];
  const historyPlayers = match?.scoringState?.rosterHistory?.[teamKey] || [];
  const playerId = scorecardPlayerId(player);
  if (!playerId || !historyPlayers.length) return false;
  const wasAddedDuringMatch = historyPlayers.some(
    (historyPlayer) => scorecardPlayerId(historyPlayer) === playerId
  );
  const wasInStartingSquad = basePlayers.some(
    (basePlayer) => scorecardPlayerId(basePlayer) === playerId
  );
  return wasAddedDuringMatch && !wasInStartingSquad;
};

const scorecardDisplayName = (match, teamId, player) =>
  `${scorecardPlayerName(player)}${
    isScorecardSubstitute(match, teamId, player) ? " (sub)" : ""
  }`;

const scorecardDisplayStatName = (match, teamId, player, name) =>
  `${name || scorecardPlayerName(player)}${
    isScorecardSubstitute(match, teamId, player) ? " (sub)" : ""
  }`;

const scorecardOvers = (balls = 0) =>
  `${Math.floor(Number(balls || 0) / 6)}.${Number(balls || 0) % 6}`;

const testCompletedOvers = (balls = 0) =>
  Math.ceil(Math.max(0, Number(balls || 0)) / 6);

const testDisplayDay = ({ match, innings = [], scoringState = {} }) => {
  const maxDays = Math.max(1, Number(match?.maxDays || match?.testDays || 5));
  const oversPerDay = Math.max(1, Number(match?.oversPerDay || match?.testOvers || 90));
  const totalOvers = innings.reduce(
    (total, item) => total + testCompletedOvers(item?.balls),
    0
  );
  const oversBasedDay = Math.floor(totalOvers / oversPerDay) + 1;
  const savedDay = Math.max(
    Number(scoringState?.currentDay) || 1,
    Number(match?.currentDay) || 1
  );

  return Math.min(
    maxDays,
    Math.max(1, savedDay || 1, oversBasedDay)
  );
};

const isTestMatchRecord = (match) =>
  String(match?.matchType || "").toLowerCase() === "test";

const isFinalMatch = (match) => {
  const status = String(match?.status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const resultText = typeof match?.result === "string"
    ? match.result
    : match?.result?.text ?? match?.resultText;

  return ["finished", "complete", "completed"].includes(status) ||
    Boolean(match?.finishedAt || match?.completedAt) ||
    match?.winner != null ||
    match?.winnerId != null ||
    match?.result?.winner != null ||
    match?.result?.winnerId != null ||
    match?.scoringState?.result?.winner != null ||
    match?.scoringState?.result?.winnerId != null ||
    match?.result?.draw === true ||
    match?.scoringState?.result?.draw === true ||
    ["draw", "tied", "tie"].includes(
      String(match?.drawState || "").trim().toLowerCase()
    ) ||
    Boolean(String(resultText || "").trim());
};

const tournamentMatchLabel = (match) => {
  const type = String(match?.tournamentMatchType || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  const superOverNumber = Number(match?.tournamentSuperOverNumber || 0);
  const semiFinalNumber = String(
    match?.tournamentBaseMatchId ||
    match?.tournamentParentMatchId ||
    match?.id ||
    ""
  ).match(/-semi-(\d+)(?:-|$)/i)?.[1];
  if (type.includes("semi") && type.includes("super over")) {
    return `Semi Final ${semiFinalNumber || 1} Super Over ${superOverNumber || 1}`;
  }
  if (type.includes("final") && type.includes("super over")) {
    return `Final Super Over ${superOverNumber || 1}`;
  }
  if (type === "semi final" || type === "semifinal") {
    return `Semi Final ${semiFinalNumber || 1}`;
  }
  if (type === "league") return "League Match";
  return type.replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Match";
};

const testInningsSuffix = (index) =>
  index === 0 ? "st" : index === 1 ? "nd" : index === 2 ? "rd" : "th";

const testInningsDisplayLabel = (innings, index, match) =>
  `${index + 1}${testInningsSuffix(index)} innings: ${innings.runs || 0}/${innings.wickets || 0}${
    innings.declared ||
    (Array.isArray(match?.declaredInnings) &&
      match.declaredInnings.includes(Number(innings.inningsIndex)))
      ? " (d)"
      : ""
  }${
    match?.followOnEnforced && Number(innings.inningsIndex) === 2
      ? " (f/o)"
      : ""
  }`;

const testTeamInnings = (playedInnings, teamId) =>
  playedInnings.filter((innings) => innings?.teamId === teamId);

const shotRegionNames = [
  "Behind Keeper",
  "Third Man",
  "Square Off",
  "Cover",
  "Long Off",
  "Long On",
  "Midwicket",
  "Square Leg",
  "Fine Leg",
];

const fallbackDeliveryCommentary = (delivery, commentaryBallNumber) => {
  const over = Number(delivery?.over ?? delivery?.overNumber);
  const overLabel = Number.isFinite(over)
    ? Math.max(1, Math.floor(over))
    : 1;
  const ballLabel =
    commentaryBallNumber ?? delivery?.commentaryBallNumber ?? 0;
  const label = `${overLabel}.${ballLabel}`;
  const striker = delivery?.strikerName || delivery?.batterName || "The batter";
  const bowler = delivery?.bowlerName || "the bowler";
  const batterRuns = Number(delivery?.batterRuns ?? delivery?.batsmanRuns ?? 0);
  const totalRuns = Number(delivery?.runs ?? delivery?.totalRuns ?? batterRuns);
  const type = String(delivery?.type || delivery?.extraType || "").toUpperCase();
  const wicket = delivery?.wicket || (delivery?.wicketType ? {
    type: delivery.wicketType,
  } : null);
  const region =
    delivery?.shotRegion ||
    (Number.isInteger(Number(delivery?.shotPosition))
      ? shotRegionNames[Number(delivery.shotPosition) - 1]
      : null) ||
    "the field";

  if (wicket) {
    const dismissal = wicket.type || wicket.kind || "out";
    return `${label} WICKET! ${striker} is out (${dismissal}) off ${bowler}.`;
  }
  if (type === "WD" || type === "WIDE") {
    return `${label} Wide from ${bowler}.`;
  }
  if (type === "NB" || type === "NO_BALL") {
    return batterRuns > 0
      ? `${label} No ball, and ${striker} scores ${batterRuns} towards ${region} off ${bowler}.`
      : `${label} No ball from ${bowler}.`;
  }
  if (type === "B" || type === "BYE") {
    return `${label} Bye, ${totalRuns} run${totalRuns === 1 ? "" : "s"} taken off ${bowler}.`;
  }
  if (type === "LB" || type === "LEG_BYE") {
    return `${label} Leg bye, ${totalRuns} run${totalRuns === 1 ? "" : "s"} taken off ${bowler}.`;
  }
  if (batterRuns === 6) {
    return `${label} SIX! ${striker} launches ${bowler} over ${region}.`;
  }
  if (batterRuns === 4) {
    return `${label} FOUR! ${striker} finds the boundary through ${region} off ${bowler}.`;
  }
  if (batterRuns > 0) {
    return `${label} ${striker} takes ${batterRuns} run${batterRuns === 1 ? "" : "s"} towards ${region} off ${bowler}.`;
  }
  return `${label} Dot ball from ${bowler} to ${striker}.`;
};

const hydrateDeliveryCommentary = (deliveries = []) => {
  /*
   * Commentary must follow the exact recorded delivery sequence. Do not sort
   * by the stored over/ball fields here: scoring can temporarily persist an
   * over value ahead of the final legal ball, especially when several extras
   * occur in the same over.
   *
   * The sequence below is therefore derived from the delivery array itself.
   * Legal balls advance 1..6; extras stay attached to the current legal-ball
   * slot. The next legal delivery after 6 starts the next over.
   */
  const sourceDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const hasPersistedSequence = sourceDeliveries.some((delivery) =>
    Number.isFinite(Number(delivery?.sequence))
  );
  const orderedDeliveries = hasPersistedSequence
    ? sourceDeliveries
        .map((delivery, index) => ({ delivery, index }))
        .sort(
          (left, right) =>
            Number(left.delivery?.sequence) -
              Number(right.delivery?.sequence) ||
            left.index - right.index
        )
        .map(({ delivery }) => delivery)
    : sourceDeliveries;

  let over = 0;
  let legalBall = 0;

  return orderedDeliveries
    .filter(Boolean)
    .map((delivery, index) => {
      const type = String(delivery?.type || delivery?.extraType || "").toUpperCase();
      const valid =
        delivery.validBall === true ||
        (!["NB", "WD", "DEAD", "NO_BALL", "WIDE"].includes(type) &&
          delivery.validBall !== false);

      if (valid) {
        if (legalBall >= 6) {
          over += 1;
          legalBall = 0;
        }
        legalBall += 1;
      }

      const commentaryBallNumber = legalBall;

      // Keep the chronological ball number derived from the actual delivery
      // sequence, but use the delivery's recorded over for the over section
      // whenever it is available. Extras such as 2.0 after 1.6 belong to the
      // next over section even though they do not consume a legal ball.
      const commentaryText = Array.isArray(delivery?.commentaryLines)
        ? delivery.commentaryLines[0]
        : delivery?.commentary;
      const commentaryLabelMatch = String(commentaryText || "").match(/^(?:\s*)(\d+)\.(\d+)/);
      const recordedOver = commentaryLabelMatch
        ? Number(commentaryLabelMatch[1])
        : Number(
            delivery?.commentaryOverNumber ??
            delivery?.over ??
            delivery?.overNumber
          );
      const commentaryOverNumber = Number.isFinite(recordedOver)
        ? Math.max(0, Math.floor(recordedOver))
        : over;

      const sourceDelivery = {
        ...delivery,
        __sourceIndex: index,
        __normalizedOver: commentaryOverNumber,
        __normalizedBall: commentaryBallNumber,
        commentaryBallNumber,
        commentaryOverNumber,
      };

      if (delivery.commentary || delivery.commentaryLines?.length) {
        return sourceDelivery;
      }

      const commentary = fallbackDeliveryCommentary(
        sourceDelivery,
        commentaryBallNumber
      );
      return {
        ...sourceDelivery,
        commentary,
        commentaryLines: [commentary],
        commentaryType: delivery.commentaryType || "delivery",
      };
    });
};

const normalizedDeliveryValue = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const normalizeDeliveries = (deliveries = []) =>
  (Array.isArray(deliveries) ? deliveries : [])
    .map((delivery, index) => {
      const over = normalizedDeliveryValue(
        delivery?.over ?? delivery?.overNumber,
        Math.floor(index / 6)
      );
      const ball = normalizedDeliveryValue(
        delivery?.ball ?? delivery?.ballNumber,
        index
      );
      return {
        ...delivery,
        __normalizedOver: Math.max(0, Math.floor(over)),
        __normalizedBall: ball,
        __sourceIndex: index,
      };
    })
    .sort(
      (left, right) =>
        left.__normalizedOver - right.__normalizedOver ||
        left.__normalizedBall - right.__normalizedBall ||
        left.__sourceIndex - right.__sourceIndex ||
        String(left.id ?? left.deliveryId ?? "").localeCompare(
          String(right.id ?? right.deliveryId ?? "")
        )
    );

const deliveryInningsIndex = (delivery) => {
  const explicitIndex = Number(delivery?.inningsIndex);
  if (Number.isInteger(explicitIndex) && explicitIndex >= 0) return explicitIndex;

  const inningsNumber = Number(delivery?.inningsNumber);
  if (Number.isInteger(inningsNumber) && inningsNumber > 0) return inningsNumber - 1;

  const innings = Number(delivery?.innings);
  if (Number.isInteger(innings) && innings >= 0) {
    return innings > 0 ? innings - 1 : 0;
  }

  return null;
};

const mergePersistedDeliveries = (
  innings,
  persistedDeliveries = [],
  matchId,
  fallbackInningsIndex = null
) => {
  if (!innings) return innings;

  const rawInningsIndex = Number(innings.inningsIndex);
  const resolvedInningsIndex = Number.isInteger(rawInningsIndex) && rawInningsIndex >= 0
    ? rawInningsIndex
    : Number.isInteger(Number(fallbackInningsIndex)) && Number(fallbackInningsIndex) >= 0
      ? Number(fallbackInningsIndex)
      : 0;
  const inningsNumber = resolvedInningsIndex + 1;
  const deliveries = persistedDeliveries.filter((delivery) =>
    [
      delivery.matchId,
      delivery.matchID,
      delivery.match_id,
    ].some((value) => String(value ?? "") === String(matchId)) &&
    (
      String(delivery.inningsId ?? "") === `${matchId}_innings_${inningsNumber}` ||
      Number(delivery.inningsNumber) === inningsNumber ||
      Number(delivery.inningsIndex) === resolvedInningsIndex ||
      Number(delivery.innings) === inningsNumber ||
      Number(delivery.innings) === resolvedInningsIndex
    )
  );

  const deliveryKey = (delivery, index) =>
    String(
      delivery.id ??
      delivery.deliveryId ??
      `${delivery.over ?? delivery.overNumber ?? 0}-${delivery.ball ?? delivery.ballNumber ?? index}`
    );
  const merged = new Map(
    (Array.isArray(innings.deliveries) ? innings.deliveries : []).map((delivery, index) => [
      deliveryKey(delivery, index),
      delivery,
    ])
  );
  deliveries.forEach((delivery, index) => {
    const key = deliveryKey(delivery, index);
    merged.set(key, { ...merged.get(key), ...delivery });
  });

  return withDerivedInningsStats({
    ...innings,
    inningsIndex: resolvedInningsIndex,
    deliveries: normalizeDeliveries([...merged.values()]).map(
      ({ __normalizedOver, __normalizedBall, __sourceIndex, ...delivery }) => delivery
    ),
  });
};

const commentarySortBall = (delivery, fallbackIndex = 0) => {
  const legalBall = Number(delivery?.commentaryBallNumber);
  const rawBall = Number(delivery?.ball ?? delivery?.ballNumber);

  // Scoring stores legal balls as 1..6. Prefer that value for normal
  // deliveries so commentary is always shown in natural ball order.
  if (Number.isInteger(legalBall) && legalBall >= 1 && legalBall <= 6) {
    return legalBall;
  }

  // Extras/dead balls may not consume a legal ball. Their stored ball slot
  // is still useful for keeping them beside the correct 1..6 ball.
  if (Number.isInteger(rawBall) && rawBall >= 1 && rawBall <= 6) {
    return rawBall;
  }

  return Number.isFinite(legalBall) ? legalBall : (Number.isFinite(rawBall) ? rawBall : fallbackIndex);
};

const commentaryDeliverySort = (left, right) => {
  const ballDifference =
    commentarySortBall(left, left?.__sourceIndex ?? 0) -
    commentarySortBall(right, right?.__sourceIndex ?? 0);

  if (ballDifference !== 0) return ballDifference;

  // Keep the original chronological order for multiple deliveries sharing
  // the same legal-ball slot (for example a no-ball followed by the legal ball).
  const sourceDifference =
    Number(left?.__sourceIndex ?? 0) - Number(right?.__sourceIndex ?? 0);
  if (sourceDifference !== 0) return sourceDifference;

  return String(left?.id ?? left?.deliveryId ?? "").localeCompare(
    String(right?.id ?? right?.deliveryId ?? "")
  );
};

const CommentarySections = ({ deliveries = [], loading = false, autoScrollLatest = false }) => {
  const commentaryEndRef = useRef(null);
  const hydratedDeliveries = hydrateDeliveryCommentary(deliveries);
  const latestDelivery = hydratedDeliveries[hydratedDeliveries.length - 1];
  const latestDeliveryKey = latestDelivery
    ? String(
        latestDelivery.id ??
        latestDelivery.deliveryId ??
        latestDelivery.sequence ??
        hydratedDeliveries.length
      )
    : "";
  const firstOver = hydratedDeliveries.reduce((lowest, delivery) => {
    const over = Number(
      delivery.commentaryOverNumber ??
      delivery.__normalizedOver ??
      delivery.over ??
      delivery.overNumber
    );
    return Number.isFinite(over) ? Math.min(lowest, over) : lowest;
  }, Number.POSITIVE_INFINITY);
  const overDisplayOffset = firstOver === 0 ? 1 : 0;

  const groups = hydratedDeliveries.reduce((result, delivery, index) => {
    const over = Number(
      delivery.commentaryOverNumber ??
      delivery.__normalizedOver ??
      delivery.over ??
      delivery.overNumber
    );
    const key = Number.isFinite(over) ? String(over) : `unknown-${index}`;
    if (!result[key]) result[key] = { over, deliveries: [] };
    result[key].deliveries.push(delivery);
    return result;
  }, {});

  const sections = Object.values(groups)
    .sort((left, right) => left.over - right.over)
    .map((section) => ({
      ...section,
      // hydrateDeliveryCommentary already produces the exact chronological
      // order. Keep that order instead of re-sorting by possibly stale ball
      // metadata, which is what caused extras to appear out of sequence.
      displayOver: Number.isFinite(section.over)
        ? section.over + overDisplayOffset
        : null,
    }));

  useEffect(() => {
    if (!autoScrollLatest || loading || !hydratedDeliveries.length) return;
    const frame = window.requestAnimationFrame(() => {
      commentaryEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [latestDeliveryKey, hydratedDeliveries.length, loading, autoScrollLatest]);

  return (
    <section className="match-commentary-section">
      <div className="match-commentary-heading">
        <div>
          <p className="eyebrow">COMMENTARY</p>
          <h4>Ball-by-ball commentary</h4>
        </div>
        <small>{hydratedDeliveries.length} records</small>
      </div>
      {loading ? (
        <div className="match-commentary-loading" role="status" aria-live="polite">
          <span className="match-commentary-spinner" aria-hidden="true" />
          <span>Generating commentary…</span>
        </div>
      ) : sections.length ? sections.map((section) => (
        <div className="match-commentary-over" key={String(section.over)}>
          <h5>Over {Number.isFinite(section.displayOver) ? section.displayOver : "—"}</h5>
          {section.deliveries.map((delivery, index) => (
            <article className="match-commentary-item" key={delivery.id || `${section.over}-${index}`}>
              {(delivery.commentaryLines || [delivery.commentary]).map((line, lineIndex) => (
                <p key={`${delivery.id || index}-${lineIndex}`}>{line}</p>
              ))}
            </article>
          ))}
        </div>
      )) : <p className="match-commentary-empty">No commentary was recorded.</p>}
      <div ref={commentaryEndRef} aria-hidden="true" />
    </section>
  );
};

const getFinishedCommentaryInnings = ({ match, scoringState }) => {
  /*
   * Finished commentary must use the same match-wide delivery history that
   * scoring.jsx shows live. scoringState.commentaryDeliveries is the primary
   * source because it preserves the exact order in which commentary was
   * recorded across innings. Older saved matches may not have that field, so
   * fall back to the persisted innings deliveries.
   */
  const savedState = scoringState || match?.scoringState || {};
  const commentaryHistory = Array.isArray(savedState.commentaryDeliveries)
    ? savedState.commentaryDeliveries
    : [];

  const historicalInnings = scorecardHistoryInnings({
    match,
    scoringState: savedState,
  }).filter(Boolean);

  const rawInningsSources = [
    ...(Array.isArray(match?.testInnings) ? match.testInnings : []),
    ...(Array.isArray(match?.innings) ? match.innings : []),
    ...(match?.firstInningsData ? [match.firstInningsData] : []),
    ...(match?.secondInningsData ? [match.secondInningsData] : []),
  ];

  const inningsMap = new Map();
  const addInnings = (innings, fallbackIndex) => {
    if (!innings) return;

    const rawIndex = Number(innings?.inningsIndex);
    const inningsIndex =
      Number.isInteger(rawIndex) && rawIndex >= 0
        ? rawIndex
        : fallbackIndex;

    const existing = inningsMap.get(inningsIndex);
    inningsMap.set(
      inningsIndex,
      existing
        ? {
            ...existing,
            ...innings,
            deliveries: [
              ...(Array.isArray(existing.deliveries) ? existing.deliveries : []),
              ...(Array.isArray(innings.deliveries) ? innings.deliveries : []),
            ],
          }
        : {
            ...innings,
            inningsIndex,
          }
    );
  };

  historicalInnings.forEach((innings, index) => addInnings(innings, index));
  rawInningsSources.forEach((innings, index) => addInnings(innings, index));

  const persistedByInnings = new Map();
  (Array.isArray(match?.persistedDeliveries)
    ? match.persistedDeliveries
    : []
  ).forEach((delivery) => {
    const matches = [
      delivery?.matchId,
      delivery?.matchID,
      delivery?.match_id,
    ].some(
      (value) => String(value ?? "") === String(match?.id ?? "")
    );
    if (!matches) return;

    const index = deliveryInningsIndex(delivery);
    if (index == null) return;

    if (!persistedByInnings.has(index)) persistedByInnings.set(index, []);
    persistedByInnings.get(index).push(delivery);
  });

  persistedByInnings.forEach((deliveries, inningsIndex) => {
    const existing = inningsMap.get(inningsIndex) || { inningsIndex };
    inningsMap.set(inningsIndex, {
      ...existing,
      inningsIndex,
      deliveries: [
        ...(Array.isArray(existing.deliveries) ? existing.deliveries : []),
        ...deliveries,
      ],
    });
  });

  const getInningsIndex = (delivery) => {
    const explicitIndex = Number(delivery?.inningsIndex);
    if (Number.isInteger(explicitIndex) && explicitIndex >= 0) {
      return explicitIndex;
    }

    const inningsNumber = Number(delivery?.inningsNumber);
    if (Number.isInteger(inningsNumber) && inningsNumber > 0) {
      return inningsNumber - 1;
    }

    const innings = Number(delivery?.innings);
    if (Number.isInteger(innings) && innings >= 0) {
      return innings > 0 ? innings - 1 : 0;
    }

    return null;
  };

  const hydrateInnings = (items) =>
    items
      .filter(Boolean)
      .sort((left, right) => Number(left.inningsIndex) - Number(right.inningsIndex))
      .map((item, index) => ({
        ...item,
        inningsIndex: Number.isInteger(Number(item.inningsIndex))
          ? Number(item.inningsIndex)
          : index,
        deliveries: hydrateFinishedCommentaryInRecordedOrder(
          Array.isArray(item.deliveries) ? item.deliveries : []
        ),
      }));

  /*
   * New matches: use the exact match-wide commentary history from scoring.jsx.
   * This keeps innings order and delivery order identical to the live
   * commentary sequence.
   */
  if (commentaryHistory.length) {
    const grouped = new Map();

    commentaryHistory.forEach((delivery) => {
      if (!delivery) return;
      const inningsIndex = getInningsIndex(delivery);
      if (inningsIndex == null) return;

      if (!grouped.has(inningsIndex)) grouped.set(inningsIndex, []);
      grouped.get(inningsIndex).push(delivery);
    });

    const innings = [...grouped.entries()]
      .sort(([left], [right]) => left - right)
      .map(([inningsIndex, deliveries]) => {
        const savedInnings = inningsMap.get(inningsIndex) || {};
        return {
          ...savedInnings,
          inningsIndex,
          teamId: savedInnings.teamId || null,
          teamName: savedInnings.teamName || null,
          deliveries: hydrateFinishedCommentaryInRecordedOrder(deliveries),
        };
      });

    if (innings.length) return innings;
  }

  /*
   * Legacy/older finished matches: reconstruct the same innings sequence from
   * all saved innings and persisted deliveries.
   */
  return hydrateInnings([...inningsMap.values()]);
};


const getLiveCommentaryInnings = ({ match, scoringState }) => {
  const savedState = scoringState || match?.scoringState || {};

  // Live commentary uses the exact same primary history as finished
  // commentary. This preserves the recorded sequence across extra balls,
  // no-balls and wides instead of rebuilding the order from persisted score
  // records whose over/ball fields can be temporarily ahead.
  const records = Array.isArray(savedState.commentaryDeliveries) && savedState.commentaryDeliveries.length
    ? savedState.commentaryDeliveries
    : Array.isArray(match?.persistedDeliveries) && match.persistedDeliveries.length
      ? match.persistedDeliveries
      : Array.isArray(savedState.deliveries)
        ? savedState.deliveries
        : [];

  if (!records.length) return [];

  const history = scorecardHistoryInnings({ match, scoringState: savedState }).filter(Boolean);
  const inningsMap = new Map(history.map((innings, index) => [
    Number.isInteger(Number(innings?.inningsIndex)) ? Number(innings.inningsIndex) : index,
    innings,
  ]));

  const grouped = new Map();
  records.forEach((delivery) => {
    const index = deliveryInningsIndex(delivery);
    if (index == null) return;
    if (!grouped.has(index)) grouped.set(index, []);
    grouped.get(index).push(delivery);
  });

  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([inningsIndex, deliveries]) => {
      const savedInnings = inningsMap.get(inningsIndex) || {};
      const teamId = savedInnings.teamId || (
        Array.isArray(match?.inningsOrder) && match.inningsOrder[inningsIndex]
          ? match.inningsOrder[inningsIndex]
          : inningsIndex % 2 === 0
            ? (match?.firstInningsTeamId === "B" ? "B" : "A")
            : (match?.firstInningsTeamId === "B" ? "A" : "B")
      );
      const team = teamId === "B" ? match?.teamB : match?.teamA;
      return {
        ...savedInnings,
        inningsIndex,
        teamId,
        teamName: savedInnings.teamName || team?.name || (teamId === "B" ? match?.teamBName : match?.teamAName),
        deliveries: hydrateDeliveryCommentary(deliveries),
      };
    });
};

const hydrateFinishedCommentaryInRecordedOrder = (deliveries = []) => {
  // Finished and live commentary use the exact same chronological numbering.
  // This prevents extra deliveries and the final ball of an over from being
  // moved into the wrong over by stale stored over/ball values.
  return hydrateDeliveryCommentary(deliveries);
};

const CommentaryTabs = ({ innings = [], autoScrollLatest = false }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [generatedInnings, setGeneratedInnings] = useState([]);

  const hydrateInnings = (sourceInnings) =>
    (Array.isArray(sourceInnings) ? sourceInnings : [])
      .filter(Boolean)
      .map((item, index) => ({
        ...item,
        inningsIndex: Number.isInteger(Number(item?.inningsIndex))
          ? Number(item.inningsIndex)
          : index,
        deliveries: hydrateDeliveryCommentary(
          Array.isArray(item?.deliveries) ? item.deliveries : []
        ),
      }));

  useEffect(() => {
    if (!isOpen || isGenerating) return;
    const hydrated = hydrateInnings(innings);
    setGeneratedInnings(hydrated);
    setSelectedIndex((index) =>
      Math.min(index, Math.max(hydrated.length - 1, 0))
    );
  }, [innings, isOpen, isGenerating]);

  const openCommentary = () => {
    if (isOpen) return;
    setIsOpen(true);
    setIsGenerating(true);

    window.setTimeout(() => {
      setGeneratedInnings(hydrateInnings(innings));
      setSelectedIndex(0);
      setIsGenerating(false);
    }, 0);
  };

  return (
    <section className="match-commentary-panel">
      {!isOpen ? (
        <button
          type="button"
          className="match-commentary-view-button"
          onClick={openCommentary}
        >
          View full commentary
        </button>
      ) : (
        <>
          <button
            type="button"
            className="match-commentary-close-button"
            onClick={() => setIsOpen(false)}
          >
            Close commentary
          </button>
          <div className="match-commentary-tabs" role="tablist" aria-label="Commentary innings">
            {generatedInnings.map((item, index) => (
              <button
                key={`commentary-innings-${item?.inningsIndex ?? index}-${index}`}
                type="button"
                className={selectedIndex === index ? "active" : ""}
                onClick={() => setSelectedIndex(index)}
                role="tab"
                aria-selected={selectedIndex === index}
              >
                {item?.teamName || `Innings ${index + 1}`}
              </button>
            ))}
          </div>
          <CommentarySections
            deliveries={generatedInnings[selectedIndex]?.deliveries || []}
            loading={isGenerating}
            autoScrollLatest={autoScrollLatest}
          />
        </>
      )}
    </section>
  );
};

const scorecardTeam = (match, teamId) => {
  const team = teamId === "B" ? match?.teamB : match?.teamA;
  const fallbackPlayers =
    teamId === "B" ? match?.teamBPlayers : match?.teamAPlayers;
  const scoringStatePlayers = match?.scoringState?.rosters?.[teamId] || [];
  const historyPlayers = match?.scoringState?.rosterHistory?.[teamId] || [];
  const players = [
    ...(Array.isArray(team?.players) ? team.players : []),
    ...(Array.isArray(fallbackPlayers) ? fallbackPlayers : []),
    ...(Array.isArray(scoringStatePlayers) ? scoringStatePlayers : []),
    ...(Array.isArray(historyPlayers) ? historyPlayers : []),
  ];
  const uniquePlayers = new Map();

  players.forEach((player) => {
    const id = scorecardPlayerId(player);
    if (id && !uniquePlayers.has(id)) uniquePlayers.set(id, player);
  });

  return {
    ...(team || {
      id: teamId,
      name: teamId === "B" ? match?.teamBName : match?.teamAName,
    }),
    id: team?.id || teamId,
    players: [...uniquePlayers.values()],
  };
};

const scorecardStrikeRate = (runs = 0, balls = 0) =>
  balls ? ((Number(runs) / Number(balls)) * 100).toFixed(2) : "0.00";

const scorecardEconomy = (runs = 0, balls = 0) =>
  balls ? ((Number(runs) / Number(balls)) * 6).toFixed(2) : "0.00";

const scorecardBowlerRuns = (delivery) => {
  const type = String(
    delivery?.type ?? delivery?.deliveryType ?? delivery?.extraType ?? ""
  )
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const directRuns = Number(
    delivery?.bowlerRuns ?? delivery?.runsConceded ?? 0
  ) || 0;

  if (["BYE", "LEG_BYE", "LB"].includes(type)) return directRuns;
  if (["NB", "NO_BALL"].includes(type)) {
    const batterRuns =
      Number(delivery?.batterRuns ?? delivery?.batsmanRuns ?? 0) || 0;
    const byeRuns =
      Number(delivery?.byeRuns ?? delivery?.legByeRuns ?? 0) || 0;
    const totalRuns =
      Number(delivery?.runs ?? delivery?.totalRuns ?? 0) || 0;
    return Math.max(directRuns, 1 + batterRuns, totalRuns - byeRuns);
  }
  if (["WD", "WIDE"].includes(type)) {
    return Math.max(
      directRuns,
      1,
      Number(delivery?.wideRuns ?? delivery?.runs ?? delivery?.totalRuns ?? 0) || 0
    );
  }
  return Math.max(
    0,
    directRuns ||
      Number(delivery?.runs ?? delivery?.totalRuns ?? 0) ||
      0
  );
};

const scorecardMaidens = (innings, bowlerId, savedMaidens = 0) => {
  const deliveries = Array.isArray(innings?.deliveries)
    ? innings.deliveries
    : [];
  const completedOvers = Array.isArray(innings?.completedOvers)
    ? innings.completedOvers
    : [];
  const normalizedBowlerId = String(bowlerId ?? "");

  const legalDelivery = (delivery) => {
    const type = String(
      delivery?.type ?? delivery?.deliveryType ?? delivery?.extraType ?? ""
    )
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    if (["NB", "NO_BALL", "WD", "WIDE", "DEAD"].includes(type)) return false;
    if (delivery?.validBall === true) return true;
    if (delivery?.validBall === false) return false;
    return true;
  };

  const overTotals = new Map();
  deliveries.forEach((delivery) => {
    const deliveryBowlerId = String(
      delivery?.bowlerId ?? delivery?.bowlerPlayerId ?? ""
    );
    if (deliveryBowlerId !== normalizedBowlerId) return;

    const overNumber = Number(delivery?.over ?? delivery?.overNumber);
    if (!Number.isFinite(overNumber)) return;
    const key = String(overNumber);
    const current = overTotals.get(key) || { balls: 0, runs: 0 };
    if (legalDelivery(delivery)) current.balls += 1;
    current.runs += scorecardBowlerRuns(delivery);
    overTotals.set(key, current);
  });

  const deliveryMaidens = [...overTotals.entries()]
    .filter(([, over]) => over.balls === 6 && over.runs === 0)
    .map(([overNumber]) => overNumber);
  const recordedMaidens = completedOvers
    .map((over, index) => {
      if (
        over?.maiden !== true ||
        String(over?.bowlerId ?? "") !== normalizedBowlerId
      ) {
        return null;
      }
      const overNumber = Number(over?.over ?? over?.overNumber ?? index + 1);
      return Number.isFinite(overNumber) ? String(overNumber) : null;
    })
    .filter((overNumber) => {
      if (overNumber === null) return false;
      if (!deliveries.length) return true;
      const details = overTotals.get(overNumber);
      return Boolean(details && details.balls === 6 && details.runs === 0);
    });
  const verifiedMaidens = new Set([...deliveryMaidens, ...recordedMaidens]).size;

  if (deliveries.length || completedOvers.length) return verifiedMaidens;
  return Number(savedMaidens) || 0;
};

const getTossWinnerTeamId = (match) => {
  const winner = match?.secondTossWinner;
  const winnerId = winner?.id ?? winner?.playerId;

  if (!winnerId) return null;

  const teams = [match.teamA, match.teamB].filter(Boolean);
  return teams.find((team) =>
    (team.players || []).some(
      (player) => String(scorecardPlayerId(player)) === String(winnerId)
    )
  )?.id || null;
};

function LiveWinPredictionCard({ prediction, title = "LIVE WIN PREDICTION", testMatch = false }) {
  const displayPrediction = prediction || {
    A: 50,
    B: 50,
    draw: testMatch ? 0 : undefined,
    teamA: "Team A",
    teamB: "Team B",
    phase: "live",
    metrics: { currentRR: 0, recentSixRuns: 0 },
  };

  const isTestPrediction = testMatch || displayPrediction.testMatch;
  const live = isTestPrediction && displayPrediction.phase !== "finished";
  const rawA = Math.max(0, Number(displayPrediction.A || 0));
  const rawB = Math.max(0, Number(displayPrediction.B || 0));
  const rawDraw = Math.max(0, Number(displayPrediction.draw || 0));
  const total = rawA + rawB + rawDraw;
  const fairPrediction = live && total > 0
    ? {
        ...displayPrediction,
        A: 5 + (rawA / total) * 85,
        draw: 5 + (rawDraw / total) * 85,
        B: 100 - (5 + (rawA / total) * 85) - (5 + (rawDraw / total) * 85),
      }
    : prediction;
  const teamA = Math.round(Number(fairPrediction.A || 0));
  const teamB = Math.round(Number(fairPrediction.B || 0));
  const phaseLabel = fairPrediction.phase === "pre-match" ? "PRE-MATCH" : fairPrediction.phase === "finished" ? "FINAL" : "LIVE";

  return (
    <section className="win-prediction-card" aria-label={title}>
      <div className="win-prediction-header">
        <div>
          <p className="win-prediction-eyebrow">{title}</p>
          <small>{phaseLabel}{fairPrediction.h2hIncluded ? " • H2H included" : ""}</small>
        </div>
        <span className="win-prediction-live-dot" />
      </div>

      <div className="win-prediction-team">
        <div className="win-prediction-label">
          <strong>{fairPrediction.teamA}</strong>
          <b>{teamA}%</b>
        </div>
        <div className="win-prediction-track" aria-hidden="true">
          <span className="win-prediction-fill win-prediction-fill-a" style={{ width: `${teamA}%` }} />
        </div>
      </div>

      {isTestPrediction && (
        <div className="win-prediction-team">
          <div className="win-prediction-label">
            <strong>Draw</strong>
            <b>{Math.round(Number(fairPrediction.draw || 0))}%</b>
          </div>
          <div className="win-prediction-track" aria-hidden="true">
            <span className="win-prediction-fill" style={{ width: `${Math.round(Number(fairPrediction.draw || 0))}%`, background: "#94a3b8" }} />
          </div>
        </div>
      )}

      <div className="win-prediction-team">
        <div className="win-prediction-label">
          <strong>{fairPrediction.teamB}</strong>
          <b>{teamB}%</b>
        </div>
        <div className="win-prediction-track" aria-hidden="true">
          <span className="win-prediction-fill win-prediction-fill-b" style={{ width: `${teamB}%` }} />
        </div>
      </div>

      {fairPrediction.metrics && (
        <div className="win-prediction-metrics">
          {fairPrediction.metrics.runsRequired != null && (
            <span><small>Required</small><b>{fairPrediction.metrics.runsRequired}</b></span>
          )}
          <span><small>Current RR</small><b>{Number(fairPrediction.metrics.currentRR || 0).toFixed(2)}</b></span>
          {fairPrediction.metrics.runsRequired != null && (
            <span><small>Required RR</small><b>{Number.isFinite(fairPrediction.metrics.requiredRR) ? Number(fairPrediction.metrics.requiredRR).toFixed(2) : "—"}</b></span>
          )}
          <span><small>Recent 6</small><b>{fairPrediction.metrics.recentSixRuns}</b></span>
        </div>
      )}
    </section>
  );
}

const predictionHistoryMatch = (match) => ({
  ...(match || {}),
  // Historical rows must be calculated as if the match were live. The
  // actual result is intentionally used only for the final "After match"
  // row so a finished match does not turn every past over into 100/0.
  status: "live",
  winner: null,
  result: null,
  resultText: "",
});

const deliveryHistoryTotals = (deliveries = []) =>
  deliveries.reduce(
    (totals, delivery) => ({
      runs: totals.runs + Number(delivery?.runs ?? delivery?.batterRuns ?? 0),
      wickets:
        totals.wickets +
        (delivery?.wicket ? 1 : Number(delivery?.wickets ?? 0)),
      legalBalls:
        totals.legalBalls +
        (delivery?.validBall === false
          ? 0
          : delivery?.validBall === true
            ? 1
            : ["NB", "WD", "DEAD", "NO_BALL", "WIDE"].includes(
                String(delivery?.type || "").toUpperCase()
              )
              ? 0
              : 1),
    }),
    { runs: 0, wickets: 0, legalBalls: 0 }
  );

const deriveInningsPlayerStats = (deliveries = []) => {
  const battingStats = {};
  const bowlingStats = {};
  const isExtra = (delivery) =>
    ["NB", "WD", "DEAD", "NO_BALL", "WIDE"].includes(
      String(delivery?.type || delivery?.extraType || "").toUpperCase()
    );

  (Array.isArray(deliveries) ? deliveries : []).forEach((delivery) => {
    const strikerId = delivery?.strikerId;
    const bowlerId = delivery?.bowlerId;
    const batterRuns = Number(delivery?.batterRuns ?? delivery?.batsmanRuns ?? 0);
    const bowlerRuns = Number(
      delivery?.bowlerRuns ??
      (isExtra(delivery) && ["BYE", "LB", "LEG_BYE"].includes(
        String(delivery?.type || delivery?.extraType || "").toUpperCase()
      )
        ? 0
        : delivery?.runs ?? 0)
    );
    const validBall =
      delivery?.validBall === true ||
      (delivery?.validBall !== false && !isExtra(delivery));

    if (strikerId) {
      const key = String(strikerId);
      const current = battingStats[key] || {
        id: key,
        name: delivery?.strikerName || delivery?.batterName || key,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        status: "yet",
      };
      current.runs += batterRuns;
      if (validBall) current.balls += 1;
      if (batterRuns === 4) current.fours += 1;
      if (batterRuns === 6) current.sixes += 1;
      battingStats[key] = current;
    }

    if (bowlerId) {
      const key = String(bowlerId);
      const current = bowlingStats[key] || {
        id: key,
        name: delivery?.bowlerName || key,
        legalBalls: 0,
        runs: 0,
        wickets: 0,
        maidens: 0,
      };
      if (validBall) current.legalBalls += 1;
      current.runs += bowlerRuns;
      if (
        delivery?.wicket &&
        !["Run out", "Retired hurt", "Obstructing the field"].includes(
          delivery.wicket.type
        )
      ) {
        current.wickets += 1;
      }
      bowlingStats[key] = current;
    }

    const dismissedId = delivery?.wicket?.batterId;
    if (dismissedId) {
      const key = String(dismissedId);
      const current = battingStats[key] || {
        id: key,
        name: delivery?.wicket?.batterName || key,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        status: "yet",
      };
      current.status = "out";
      current.dismissal = delivery.wicket.type || "out";
      current.fielder = delivery.wicket.fielder || "";
      current.bowler = delivery.wicket.bowler || delivery.bowlerName || "";
      battingStats[key] = current;
    }
  });

  return { battingStats, bowlingStats };
};

const withDerivedInningsStats = (innings) => {
  if (!innings) return innings;
  const derived = deriveInningsPlayerStats(innings.deliveries);
  return {
    ...innings,
    battingStats: {
      ...derived.battingStats,
      ...(innings.battingStats || {}),
    },
    bowlingStats: {
      ...derived.bowlingStats,
      ...(innings.bowlingStats || {}),
    },
  };
};


const buildLiveScorecardSnapshot = (match, persistedDeliveries = []) => {
  if (!match || String(match?.status || "").toLowerCase() !== "live") {
    return match;
  }

  const savedState = match.scoringState || {};
  const records = Array.isArray(persistedDeliveries) ? persistedDeliveries.filter(Boolean) : [];
  if (!records.length) {
    const inningsIndex = Number(savedState.inningsIndex);
    const inningsRuns = Number(savedState.inningsRuns);
    const inningsWickets = Number(savedState.inningsWickets);

    if (
      !Number.isInteger(inningsIndex) ||
      inningsIndex < 0 ||
      !Number.isFinite(inningsRuns) ||
      !Number.isFinite(inningsWickets)
    ) {
      return match;
    }

    const liveTeamId =
      Array.isArray(match.inningsOrder) && match.inningsOrder[inningsIndex]
        ? match.inningsOrder[inningsIndex]
        : inningsIndex === 1
          ? (match.battingTeamId === "A" ? "B" : "A")
          : match.battingTeamId || (inningsIndex % 2 === 0 ? "A" : "B");

    return {
      ...match,
      scoringState: {
        ...savedState,
        inningsIndex,
        inningsRuns,
        inningsWickets,
      },
      ...(liveTeamId === "A"
        ? { scoreA: inningsRuns, wicketsA: inningsWickets }
        : { scoreB: inningsRuns, wicketsB: inningsWickets }),
    };
  }

  const inningsIndexes = records
    .map((delivery) => deliveryInningsIndex(delivery))
    .filter((index) => index != null);
  const currentInningsIndex = Number.isInteger(Number(savedState.inningsIndex))
    ? Number(savedState.inningsIndex)
    : inningsIndexes.length
      ? Math.max(...inningsIndexes)
      : 0;
  const currentDeliveries = records.filter(
    (delivery) => deliveryInningsIndex(delivery) === currentInningsIndex
  );

  if (!currentDeliveries.length) return match;

  const persistedTotals = deliveryHistoryTotals(currentDeliveries);
  const totals = {
    runs: Number.isFinite(Number(savedState.inningsRuns))
      ? Number(savedState.inningsRuns)
      : persistedTotals.runs,
    wickets: Number.isFinite(Number(savedState.inningsWickets))
      ? Number(savedState.inningsWickets)
      : persistedTotals.wickets,
    legalBalls: Number.isFinite(Number(savedState.legalBalls))
      ? Number(savedState.legalBalls)
      : persistedTotals.legalBalls,
  };
  const liveTeamId = savedState.inningsIndex === 1
    ? (match.battingTeamId === "A" ? "B" : "A")
    : match.battingTeamId || (
        Array.isArray(match.inningsOrder) && match.inningsOrder[currentInningsIndex]
          ? match.inningsOrder[currentInningsIndex]
          : currentInningsIndex % 2 === 0 ? "A" : "B"
      );

  const nextState = {
    ...savedState,
    inningsIndex: currentInningsIndex,
    inningsRuns: totals.runs,
    inningsWickets: totals.wickets,
    legalBalls: totals.legalBalls,
    deliveries: currentDeliveries,
  };

  return {
    ...match,
    scoringState: nextState,
    ...(liveTeamId === "A"
      ? { scoreA: totals.runs, wicketsA: totals.wickets }
      : { scoreB: totals.runs, wicketsB: totals.wickets }),
  };
};

const scorecardHistoryInnings = ({ match, scoringState }) => {
  const teams = {
    A: scorecardTeam(match, "A"),
    B: scorecardTeam(match, "B"),
  };

  if (isTestMatchRecord(match) && isFinalMatch(match)) {
    const explicitTestInnings = Array.isArray(match?.testInnings)
      ? match.testInnings
      : [];
    const genericInnings = Array.isArray(match?.innings)
      ? match.innings
      : [];
    const legacyInnings = [
      ...(Array.isArray(match?.firstInningsData)
        ? match.firstInningsData
        : match?.firstInningsData ? [match.firstInningsData] : []),
      ...(Array.isArray(match?.secondInningsData)
        ? match.secondInningsData
        : match?.secondInningsData ? [match.secondInningsData] : []),
    ];
    const savedInnings = explicitTestInnings.length
      ? explicitTestInnings
      : genericInnings.length
        ? genericInnings
        : legacyInnings;
    const currentIndex = Number(scoringState?.inningsIndex);
    const liveInnings = Number.isInteger(currentIndex) && currentIndex >= 0
      ? {
          inningsIndex: currentIndex,
          teamId: Array.isArray(match?.inningsOrder)
            ? match.inningsOrder[currentIndex]
            : currentIndex % 2 === 0
              ? (match?.firstInningsTeamId === "B" ? "B" : "A")
              : (match?.firstInningsTeamId === "B" ? "A" : "B"),
          teamName: undefined,
          runs: Number(scoringState.inningsRuns || 0),
          wickets: Number(scoringState.inningsWickets || 0),
          balls: Number(scoringState.legalBalls || 0),
          battingStats: scoringState.battingStats || {},
          bowlingStats: scoringState.bowlingStats || {},
          extras: scoringState.extras,
          deliveries: Array.isArray(scoringState.deliveries) ? scoringState.deliveries : [],
          fallOfWickets: scoringState.fallOfWickets,
          completedOvers: scoringState.completedOvers,
          day: scoringState.currentDay,
        }
      : null;
    const matchFinished = isFinalMatch(match);
    const savedCurrentInnings = savedInnings.find(
      (item) => Number(item.inningsIndex) === currentIndex
    );
    const liveHasMoreCompleteData =
      liveInnings &&
      (!savedCurrentInnings ||
        Number(liveInnings.balls || 0) > Number(savedCurrentInnings.balls || 0) ||
        Number(liveInnings.runs || 0) > Number(savedCurrentInnings.runs || 0) ||
        Number(liveInnings.wickets || 0) > Number(savedCurrentInnings.wickets || 0) ||
        (Array.isArray(liveInnings.deliveries) &&
          liveInnings.deliveries.length >
            (Array.isArray(savedCurrentInnings?.deliveries)
              ? savedCurrentInnings.deliveries.length
              : 0)));
    const shouldMergeLiveInnings = liveInnings &&
      (!matchFinished || liveHasMoreCompleteData || !savedInnings.length);
    const mergedInnings = shouldMergeLiveInnings
      ? [
          ...savedInnings.filter((item) => Number(item.inningsIndex) !== currentIndex),
          liveInnings,
        ]
      : savedInnings;

    const persistedByInnings = new Map();
    (Array.isArray(match?.persistedDeliveries) ? match.persistedDeliveries : []).forEach((delivery) => {
      const matches = [delivery.matchId, delivery.matchID, delivery.match_id]
        .some((value) => String(value ?? "") === String(match?.id ?? ""));
      const index = deliveryInningsIndex(delivery);
      if (!matches || index == null) return;
      if (!persistedByInnings.has(index)) persistedByInnings.set(index, []);
      persistedByInnings.get(index).push(delivery);
    });

    const candidates = new Map();
    mergedInnings.forEach((innings, index) => {
      if (!innings) return;
      const explicitIndex = Number(innings.inningsIndex);
      const inningsIndex = Number.isInteger(explicitIndex) && explicitIndex >= 0
        ? explicitIndex
        : index;
      const existing = candidates.get(inningsIndex);
      candidates.set(inningsIndex, existing
        ? { ...existing, ...innings, deliveries: [
            ...(Array.isArray(existing.deliveries) ? existing.deliveries : []),
            ...(Array.isArray(innings.deliveries) ? innings.deliveries : []),
          ] }
        : { ...innings });
    });
    persistedByInnings.forEach((deliveries, inningsIndex) => {
      const existing = candidates.get(inningsIndex) || {};
      candidates.set(inningsIndex, {
        ...existing,
        inningsIndex,
        deliveries: [
          ...(Array.isArray(existing.deliveries) ? existing.deliveries : []),
          ...deliveries,
        ],
      });
    });

    return [...candidates.entries()]
      .sort(([left], [right]) => left - right)
      .map(([inningsIndex, innings]) => {
        const teamId = innings.teamId === "B"
          ? "B"
          : innings.teamId === "A"
            ? "A"
            : Array.isArray(match?.inningsOrder) && match.inningsOrder[inningsIndex] === "B"
              ? "B"
              : inningsIndex % 2 === 0
                ? (match?.firstInningsTeamId === "B" ? "B" : "A")
                : (match?.firstInningsTeamId === "B" ? "A" : "B");

        return mergePersistedDeliveries({
        ...innings,
        inningsIndex,
        teamId,
        teamName: innings.teamName || teams[teamId]?.name,
        declared: Boolean(
          innings.declared ||
          (Array.isArray(match?.declaredInnings) &&
            match.declaredInnings.includes(inningsIndex))
        ),
        deliveries: Array.isArray(innings.deliveries) ? innings.deliveries : [],
        battingStats: innings.battingStats || {},
        bowlingStats: innings.bowlingStats || {},
        }, match?.persistedDeliveries, match?.id);
      });
  }

  const firstSaved = match?.firstInningsData || null;
  const secondSaved = match?.secondInningsData || null;
  const firstTeamId =
    firstSaved?.teamId === "B" || match?.firstInningsTeamId === "B"
      ? "B"
      : "A";
  const secondTeamId = firstTeamId === "A" ? "B" : "A";

  const fromScoringState = () => {
    if (!scoringState || typeof scoringState !== "object") return null;

    const inningsIndex = Number(scoringState.inningsIndex) === 1 ? 1 : 0;
    const teamId = inningsIndex === 1 ? secondTeamId : firstTeamId;
    const team = teams[teamId];
    const deliveries = Array.isArray(scoringState.deliveries)
      ? scoringState.deliveries
      : [];

    return {
      teamId,
      teamName: team?.name,
      runs: Number(scoringState.inningsRuns || 0),
      wickets: Number(scoringState.inningsWickets || 0),
      balls: Number(scoringState.legalBalls || 0),
      battingStats: scoringState.battingStats || {},
      bowlingStats: scoringState.bowlingStats || {},
      extras: scoringState.extras,
      deliveries,
      fallOfWickets: scoringState.fallOfWickets,
      completedOvers: scoringState.completedOvers,
    };
  };

  const currentScoringInnings = fromScoringState();
  const first =
    Number(scoringState?.inningsIndex) === 0
      ? currentScoringInnings || firstSaved
      : firstSaved;
  const second =
    Number(scoringState?.inningsIndex) === 1
      ? currentScoringInnings || secondSaved
      : secondSaved;

  return [first, second].map((innings, index) => {
    if (!innings) return null;

    const teamId = innings.teamId === "B" || innings.teamId === "A"
      ? innings.teamId
      : index === 0
        ? firstTeamId
        : secondTeamId;
    const fallbackTeam = teams[teamId];
    const deliveries = Array.isArray(innings.deliveries)
      ? innings.deliveries
      : [];

    return mergePersistedDeliveries({
      ...innings,
      inningsIndex: Number.isInteger(Number(innings.inningsIndex))
        ? Number(innings.inningsIndex)
        : index,
      teamId,
      teamName: innings.teamName || fallbackTeam?.name,
      deliveries,
      battingStats: innings.battingStats || {},
      bowlingStats: innings.bowlingStats || {},
    }, match?.persistedDeliveries, match?.id, index);
  });
};

const getLastRecordedPredictionByOver = ({ match, innings, inningsIndex }) => {
  const deliveries = normalizeDeliveries(innings?.deliveries);
  if (!deliveries.length) return [];

  const groups = [];
  deliveries.forEach((delivery, deliveryIndex) => {
    const over = delivery.__normalizedOver;
    const existing = groups.findIndex((item) => item.over === over);
    if (existing >= 0) groups[existing].lastIndex = deliveryIndex;
    else groups.push({ over, lastIndex: deliveryIndex });
  });

  const historyMatch = predictionHistoryMatch(match);

  return groups.map(({ over, lastIndex }) => {
    const deliveriesUptoOver = deliveries.slice(0, lastIndex + 1);
    const totals = deliveryHistoryTotals(deliveriesUptoOver);
    const lastDelivery = deliveriesUptoOver[deliveriesUptoOver.length - 1] || {};
    const historyState = {
      ...(innings || {}),
      inningsIndex,
      inningsRuns: totals.runs,
      inningsWickets: totals.wickets,
      legalBalls: totals.legalBalls,
      deliveries: deliveriesUptoOver,
      battingStats: innings?.battingStats || {},
      bowlingStats: innings?.bowlingStats || {},
      strikerId: lastDelivery?.strikerId || "",
      nonStrikerId: lastDelivery?.nonStrikerId || "",
      currentBowlerId: lastDelivery?.bowlerId || "",
    };

    const prediction = getPredictionForDelivery({
      match: historyMatch,
      scoringState: historyState,
      deliveryIndex: deliveriesUptoOver.length - 1,
    });

    return {
      over,
      index: lastIndex,
      prediction,
      score: `${totals.runs}/${totals.wickets}`,
    };
  }).filter((item) => item.prediction);
};

const buildPredictionHistory = ({ match, scoringState }) => {
  const historyMatch = predictionHistoryMatch(match);
  const innings = scorecardHistoryInnings({ match, scoringState });

  const preMatchPrediction = calculateWinPrediction({
    match: historyMatch,
    scoringState: null,
  });

  const records = preMatchPrediction
    ? [{
        key: "before-match",
        label: "BEFORE MATCH",
        subLabel: "Pre-match probability",
        prediction: preMatchPrediction,
      }]
    : [];

  innings.forEach((inningsData, inningsIndex) => {
    if (!inningsData) return;

    const overRecords = getLastRecordedPredictionByOver({
      match,
      innings: inningsData,
      inningsIndex,
    });

    if (isTestMatchRecord(match)) {
      // Test scorecards show one prediction point per played innings, not
      // every over. An innings is considered played only when it has recorded
      // deliveries or a non-zero recorded score.
      const deliveries = Array.isArray(inningsData.deliveries)
        ? inningsData.deliveries
        : [];
      const played =
        deliveries.length > 0 ||
        Number(inningsData.runs || 0) > 0 ||
        Number(inningsData.balls || 0) > 0 ||
        Number(inningsData.wickets || 0) > 0;
      const finalOver = overRecords[overRecords.length - 1];

      if (!played || !finalOver?.prediction) return;

      records.push({
        key: `test-innings-${inningsIndex}`,
        label: `AFTER ${inningsIndex + 1}${testInningsSuffix(inningsIndex)} INNINGS`,
        subLabel: `${inningsData.teamName || `Team ${inningsData.teamId}`} • ${finalOver.score}`,
        prediction: finalOver.prediction,
      });
      return;
    }

    // Limited Overs history remains over-by-over.
    overRecords.forEach((record) => {
      records.push({
        key: `${inningsIndex + 1}-${record.over}-${record.index}`,
        label: `${inningsIndex + 1}${testInningsSuffix(inningsIndex)} INNINGS • OVER ${record.over}`,
        subLabel: `${inningsData.teamName || `Team ${inningsData.teamId}`} • ${record.score}`,
        prediction: record.prediction,
      });
    });
  });

  const matchFinished =
    String(match?.status || "").toLowerCase() === "finished" ||
    String(match?.status || "").toLowerCase() === "completed" ||
    match?.winner !== undefined && match?.winner !== null ||
    match?.result?.winner !== undefined && match?.result?.winner !== null;

  if (matchFinished) {
    const finalPrediction = calculateWinPrediction({
      match,
      scoringState,
    });

    if (finalPrediction) {
      records.push({
        key: "after-match",
        label: "AFTER MATCH",
        subLabel: "Final recorded result",
        prediction: finalPrediction,
      });
    }
  }

  if (!records.length) {
    records.push({
      key: "current-match",
      label: "CURRENT MATCH",
      subLabel: "Prediction history will update as deliveries are recorded",
      prediction: {
        ...calculateWinPrediction({ match: historyMatch, scoringState: null }),
        A: 50,
        B: 50,
        teamA: match?.teamA?.name || match?.teamAName || "Team A",
        teamB: match?.teamB?.name || match?.teamBName || "Team B",
        phase: "live",
        metrics: { currentRR: 0, recentSixRuns: 0 },
      },
    });
  }

  return records;
};

function PredictionOverHistory({ match, scoringState }) {
  const records = buildPredictionHistory({ match, scoringState });
  const isTestMatch = isTestMatchRecord(match);
  const inningsCount = scorecardHistoryInnings({ match, scoringState })
    .filter(Boolean).length;

  if (!records.length) return null;

  return (
    <section className="win-prediction-history">
      <div className="section-title">
        <span>WIN PREDICTION BY OVER</span>
        <small>
          Before match, every recorded over across {inningsCount || "available"}{" "}
          innings, and after match
        </small>
      </div>

      <div className="win-prediction-history-list">
        {records.map((record) => {
          const prediction = record.prediction;
          const teamA = Math.round(Number(prediction.A || 0));
          const teamB = Math.round(Number(prediction.B || 0));
          const draw = Math.round(Number(prediction.draw || 0));

          return (
            <div className="win-prediction-history-record" key={record.key}>
              <div className="win-prediction-history-record-head">
                <div>
                  <strong>{record.label}</strong>
                  <small>{record.subLabel}</small>
                </div>
                <span>{prediction.phase === "pre-match" ? "PRE-MATCH" : prediction.phase === "finished" ? "FINAL" : "LIVE"}</span>
              </div>

              {isTestMatch ? (
                <div className="win-prediction-history-probabilities test-prediction-history-probabilities">
                  <div className="prediction-history-outcome">
                    <strong>{prediction.teamA} {teamA}%</strong>
                    <div className="win-prediction-mini-track" aria-hidden="true">
                      <span style={{ width: `${teamA}%` }} />
                    </div>
                  </div>
                  <div className="prediction-history-outcome">
                    <strong>Draw {draw}%</strong>
                    <div className="win-prediction-mini-track draw" aria-hidden="true">
                      <span style={{ width: `${draw}%` }} />
                    </div>
                  </div>
                  <div className="prediction-history-outcome">
                    <strong>{prediction.teamB} {teamB}%</strong>
                    <div className="win-prediction-mini-track" aria-hidden="true">
                      <span style={{ width: `${teamB}%` }} />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="win-prediction-history-probabilities">
                  <strong>{prediction.teamA} {teamA}%</strong>
                  <div className="win-prediction-mini-track" aria-hidden="true">
                    <span style={{ width: `${teamA}%` }} />
                  </div>
                  <strong>{prediction.teamB} {teamB}%</strong>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const recordedPlayerPerformances = ({ match }) => {
  const teams = [
    match?.teamA || {
      id: "A",
      name: match?.teamAName || "Team A",
      players: match?.teamAPlayers || [],
    },
    match?.teamB || {
      id: "B",
      name: match?.teamBName || "Team B",
      players: match?.teamBPlayers || [],
    },
  ];

  const innings = isTestMatchRecord(match)
    ? scorecardHistoryInnings({
        match,
        scoringState: match?.scoringState || {},
      })
    : [match?.firstInningsData, match?.secondInningsData].filter(Boolean);
  const map = new Map();

  const ensurePlayer = (playerId, name, team) => {
    const key = String(playerId || name || "").trim();
    if (!key) return null;
    if (!map.has(key)) {
      map.set(key, {
        id: key,
        name: name || "Unknown Player",
        teamId: team?.id || null,
        teamName: team?.name || "Team",
        teamIds: new Set(team?.id ? [String(team.id)] : []),
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        wickets: 0,
        legalBalls: 0,
        runsConceded: 0,
      });
    }
    const player = map.get(key);
    if (team?.id) player.teamIds.add(String(team.id));
    return player;
  };

  teams.forEach((team) => {
    (team?.players || []).forEach((player) => {
      const id = scorecardPlayerId(player);
      ensurePlayer(id, scorecardPlayerName(player), team);
    });
  });

  innings.forEach((inning) => {
    const battingTeam = teams.find((team) => team?.id === inning?.teamId);
    const bowlingTeam = teams.find((team) => team?.id !== inning?.teamId);
    const battingStats = inning?.battingStats || {};
    const bowlingStats = inning?.bowlingStats || {};

    Object.entries(battingStats).forEach(([id, stats]) => {
      const player = ensurePlayer(
        id,
        stats?.name || stats?.playerName,
        battingTeam
      );
      if (!player) return;
      player.runs += Number(stats?.runs || 0);
      player.balls += Number(stats?.balls || 0);
      player.fours += Number(stats?.fours || 0);
      player.sixes += Number(stats?.sixes || 0);
    });

    Object.entries(bowlingStats).forEach(([id, stats]) => {
      const player = ensurePlayer(
        id,
        stats?.name || stats?.playerName,
        bowlingTeam
      );
      if (!player) return;
      player.wickets += Number(stats?.wickets || 0);
      player.legalBalls += Number((stats?.legalBalls ?? stats?.balls) || 0);
      player.runsConceded += Number(stats?.runs || stats?.runsConceded || 0);
    });
  });

  return [...map.values()].map((player) => {
    const strikeRate = player.balls > 0 ? (player.runs / player.balls) * 100 : 0;
    const economy = player.legalBalls > 0
      ? (player.runsConceded / player.legalBalls) * 6
      : null;

    const battingImpact =
      player.runs*2 +
      player.fours * 0.5 +
      player.sixes * 1.5 +
      (player.balls > 0 ? Math.max(-4, Math.min(4, (strikeRate - 100) * 0.04)) : 0);

    const bowlingImpact =
      player.wickets * 7 +
      (economy == null ? 0 : Math.max(-8, Math.min(8, (6.5 - economy) * 2)));

    return {
      ...player,
      strikeRate,
      economy,
      impact: (battingImpact + bowlingImpact) /
        Math.max(1, player.teamIds.size),
      teamIds: [...player.teamIds],
    };
  });
};

const getWinningTeam = (match) => {
  if (!match) return null;

  const teams = [
    match.teamA || {
      id: "A",
      name: match.teamAName || "Team A",
    },
    match.teamB || {
      id: "B",
      name: match.teamBName || "Team B",
    },
  ];
  const result = match.result;
  const winnerValues = [
    match.winnerId,
    match.winnerTeamId,
    match.winner,
    match.winnerName,
    result?.winnerId,
    result?.winnerTeamId,
    result?.winner,
  ]
    .filter((value) => value != null)
    .map((value) => String(value).trim().toLowerCase());

  if (!winnerValues.length || winnerValues.includes("draw") || winnerValues.includes("tie")) {
    return null;
  }

  return teams.find((team, index) => {
    const aliases = [
      team?.id,
      team?.name,
      index === 0 ? "a" : "b",
    ]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase());
    return winnerValues.some((winner) => aliases.includes(winner));
  }) || null;
};

const getPlayerOfTheMatch = (match) => {
  if (!match) return null;

  const winningTeam = getWinningTeam(match);
  const allPerformances = recordedPlayerPerformances({ match });
  const performances = (winningTeam
    ? allPerformances.filter((player) =>
        player.teamIds?.some((teamId) =>
          String(teamId).toLowerCase() === String(winningTeam.id || "").toLowerCase()
        ) ||
        String(player.teamId || "").toLowerCase() === String(winningTeam.id || "").toLowerCase() ||
        String(player.teamName || "").toLowerCase() === String(winningTeam.name || "").toLowerCase()
      )
    : allPerformances)
    .filter((player) => player.runs > 0 || player.wickets > 0 || player.balls > 0 || player.legalBalls > 0)
    .sort((a, b) => b.impact - a.impact);

  return performances[0] || allPerformances[0] || null;
};


const describeTurningPointDelivery = (delivery) => {
  const wicket = delivery?.wicket;
  if (wicket) {
    const dismissed = wicket?.batterName || "a batter";
    return `${dismissed} dismissed (${wicket?.type || "wicket"})`;
  }

  const runs = Number(delivery?.runs ?? delivery?.batterRuns ?? 0);
  const type = String(delivery?.type || "").toUpperCase();
  if (type === "NB") return `No-ball sequence added ${runs} run${runs === 1 ? "" : "s"}`;
  if (type === "WD") return `Wide added ${runs} run${runs === 1 ? "" : "s"}`;
  if (runs >= 6) return "Six";
  if (runs === 4) return "Four";
  if (runs > 0) return `${runs} run${runs === 1 ? "" : "s"}`;
  return "Dot ball";
};

const getTurningPoint = ({ match, scoringState }) => {
  const historyMatch = predictionHistoryMatch(match);
  const innings = scorecardHistoryInnings({ match, scoringState });
  let best = null;

  innings.forEach((inningsData, inningsIndex) => {
    let previousA = null;
    let previousFallback = 50;
    const deliveries = Array.isArray(inningsData?.deliveries)
      ? inningsData.deliveries
      : [];

    deliveries.forEach((delivery, deliveryIndex) => {
      const upto = deliveries.slice(0, deliveryIndex + 1);
      const totals = deliveryHistoryTotals(upto);
      const state = {
        ...(inningsData || {}),
        inningsIndex,
        inningsRuns: totals.runs,
        inningsWickets: totals.wickets,
        legalBalls: totals.legalBalls,
        deliveries: upto,
        battingStats: inningsData?.battingStats || {},
        bowlingStats: inningsData?.bowlingStats || {},
        strikerId: delivery?.strikerId || "",
        nonStrikerId: delivery?.nonStrikerId || "",
        currentBowlerId: delivery?.bowlerId || "",
      };

      const prediction = getPredictionForDelivery({
        match: historyMatch,
        scoringState: state,
        deliveryIndex,
      });
      const runs = Number(delivery?.runs ?? delivery?.batterRuns ?? 0);
      const wicket = Boolean(delivery?.wicket);
      const type = String(delivery?.type || "").toUpperCase();
      const fallbackImpact =
        (wicket ? 25 : 0) +
        Math.min(14, Math.max(0, runs) * 2) +
        (runs >= 4 ? 5 : 0) +
        (runs >= 6 ? 4 : 0) +
        (type === "NB" || type === "NO_BALL" || type === "WD" || type === "WIDE" ? 3 : 0);
      const currentA = prediction
        ? Number(prediction.A || 0)
        : Math.max(0, Math.min(100, previousFallback + (
            inningsData?.teamId === "B" ? -fallbackImpact : fallbackImpact
          )));
      const change = previousA == null
        ? (prediction ? 0 : fallbackImpact)
        : Math.abs(currentA - previousA);

      if ((!prediction || previousA != null || !best) && (!best || change > best.change)) {
        best = {
          innings: inningsIndex + 1,
          over: Number(delivery?.over || Math.floor(deliveryIndex / 6) + 1),
          ball: Number(delivery?.ball || (deliveryIndex % 6) + 1),
          change,
          from: previousA ?? previousFallback,
          to: currentA,
          delivery,
          summary: describeTurningPointDelivery(delivery),
        };
      }

      previousA = currentA;
      previousFallback = currentA;
    });
  });

  if (best) return best;

  const fallbackInnings = innings.find((item) =>
    Object.keys(item?.battingStats || {}).length ||
    Object.keys(item?.bowlingStats || {}).length
  );
  if (!fallbackInnings) return null;

  const stats = Object.values(fallbackInnings.battingStats || {});
  const topBatter = stats.sort((a, b) => Number(b?.runs || 0) - Number(a?.runs || 0))[0];
  return {
    innings: Number(fallbackInnings.inningsIndex || 0) + 1,
    over: Math.max(1, Math.ceil(Number(fallbackInnings.balls || 0) / 6)),
    ball: Math.max(1, Number(fallbackInnings.balls || 0) % 6 || 6),
    change: 0,
    from: 50,
    to: 50,
    summary: topBatter?.name
      ? `${topBatter.name} made the biggest recorded batting contribution`
      : "Recorded scorecard contribution",
  };
};

function MatchMatchImpactSections({ match, scoringState }) {
  const teamA = match?.teamA || {
    id: "A",
    name: match?.teamAName || "Team A",
    players: match?.teamAPlayers || [],
  };
  const teamB = match?.teamB || {
    id: "B",
    name: match?.teamBName || "Team B",
    players: match?.teamBPlayers || [],
  };
  const teamAName = teamA.name;
  const teamBName = teamB.name;
  const player = getPlayerOfTheMatch(match);
  const turningPoint = getTurningPoint({ match, scoringState });
  const finished =
    String(match?.status || "").toLowerCase() === "finished" ||
    String(match?.status || "").toLowerCase() === "completed";

  return (
    <div className="match-impact-sections">
      <section className="match-impact-card">
        <div className="section-title">
          <span>PLAYER OF THE MATCH</span>
          <small>{finished ? "Calculated from the recorded scorecard" : "Available after the match is finished"}</small>
        </div>

        {player ? (
          <div className="match-impact-content">
            <strong>{scorecardDisplayName(match, player.teamId, player)}</strong>
            <span>{player.teamName}</span>
            <div className="match-impact-stats">
              {player.runs > 0 && <small>{player.runs} runs</small>}
              {player.wickets > 0 && <small>{player.wickets} wicket{player.wickets === 1 ? "" : "s"}</small>}
              {player.balls > 0 && <small>SR {player.strikeRate.toFixed(1)}</small>}
              {player.legalBalls > 0 && player.economy != null && <small>Eco {player.economy.toFixed(2)}</small>}
            </div>
          </div>
        ) : (
          <p className="match-impact-empty">Player of the match will appear here after a completed match with recorded player statistics.</p>
        )}
      </section>

      <section className="match-impact-card">
        <div className="section-title">
          <span>TURNING POINT OF THE MATCH</span>
          <small>{turningPoint ? "Largest recorded change in win probability" : "Built from recorded deliveries"}</small>
        </div>

        {turningPoint ? (
          <div className="match-impact-content">
            <strong>{turningPoint.summary}</strong>
            <span>{turningPoint.innings === 1 ? "1st innings" : "2nd innings"} • Over {turningPoint.over} • Ball {turningPoint.ball}</span>
            <div className="match-turning-point-probability">
              <small>{match?.teamA?.name || match?.teamAName || "Team A"} {turningPoint.from.toFixed(1)}% → {turningPoint.to.toFixed(1)}%</small>
              <small>Change {turningPoint.change.toFixed(1)}%</small>
            </div>
          </div>
        ) : (
          <p className="match-impact-empty">The turning point will appear here after recorded deliveries are available.</p>
        )}
      </section>
    </div>
  );
}

function MatchInningsScorecard({
  innings,
  battingTeam,
  bowlingTeam,
  match,
  careerStatsByPlayer,
  commentaryLoading = false,
  commentaryEnabled = true,
}) {
  if (!battingTeam) return null;

  const data = innings || {};
  const battingStats = data.battingStats || {};
  const bowlingStats = data.bowlingStats || {};
  const extras = data.extras || { nb: 0, wd: 0, bye: 0, lb: 0 };
  const savedFallOfWickets = Array.isArray(data.fallOfWickets)
    ? data.fallOfWickets
    : [];
  const fallOfWicketsByNumber = new Map(
    savedFallOfWickets.map((entry) => [Number(entry?.wicket), entry])
  );
  let deliveryRuns = 0;
  let deliveryWickets = 0;
  [...(Array.isArray(data.deliveries) ? data.deliveries : [])]
    .sort((left, right) =>
      Number(left?.overNumber ?? left?.over ?? 0) -
        Number(right?.overNumber ?? right?.over ?? 0) ||
      Number(left?.ballNumber ?? left?.ball ?? 0) -
        Number(right?.ballNumber ?? right?.ball ?? 0)
    )
    .forEach((delivery) => {
      deliveryRuns += Number(
        delivery?.runs ?? delivery?.totalRuns ?? delivery?.batterRuns ?? 0
      ) || 0;
      const wicket = delivery?.wicket || (
        delivery?.wicketType || delivery?.dismissedPlayerId
          ? {
              type: delivery.wicketType,
              batterName: delivery.dismissedPlayerName,
            }
          : null
      );
      if (!wicket) return;
      deliveryWickets += 1;
      if (!fallOfWicketsByNumber.has(deliveryWickets)) {
        const over = Number(delivery?.overNumber ?? delivery?.over);
        const ball = Number(delivery?.ballNumber ?? delivery?.ball);
        fallOfWicketsByNumber.set(deliveryWickets, {
          wicket: deliveryWickets,
          score: deliveryRuns,
          batter:
            wicket.batterName ||
            delivery.dismissedPlayerName ||
            delivery.batterName ||
            "Unknown batter",
          over:
            Number.isFinite(over) && Number.isFinite(ball)
              ? `${over}.${ball}`
              : "",
        });
      }
    });
  const fallOfWickets = [...fallOfWicketsByNumber.values()].sort(
    (left, right) => Number(left?.wicket || 0) - Number(right?.wicket || 0)
  );

  const batters = (battingTeam.players || []).map((player, index) => {
    const stats = battingStats[scorecardPlayerId(player)] || {};
    const career = careerStatsByPlayer?.get(
      scorecardPlayerId(player).trim().toLowerCase()
    );

    return {
      id: scorecardPlayerId(player),
      name: scorecardDisplayStatName(
        match,
        battingTeam.id,
        player,
        stats.name
      ),
      battingOrder: stats.battingOrder || index + 1,
      runs: Number(stats.runs || 0),
      balls: Number(stats.balls || 0),
      fours: Number(stats.fours || 0),
      sixes: Number(stats.sixes || 0),
      status: stats.status || "yet",
      dismissal: stats.dismissal || "",
      fielder: stats.fielder || "",
      bowler: stats.bowler || "",
      career,
    };
  });

  const played = batters.filter(
    (batter) =>
      batter.status !== "yet" ||
      batter.balls > 0 ||
      batter.runs > 0
  );

  const yetToBat = batters.filter(
    (batter) => batter.status === "yet" && !batter.balls && !batter.runs
  );

  const bowlers = (bowlingTeam?.players || [])
    .map((player) => {
      const stats = bowlingStats[scorecardPlayerId(player)] || {};
      const career = careerStatsByPlayer?.get(
        scorecardPlayerId(player).trim().toLowerCase()
      );

      return {
        id: scorecardPlayerId(player),
        name: scorecardDisplayStatName(
          match,
          bowlingTeam.id,
          player,
          stats.name
        ),
        legalBalls: Number(stats.legalBalls || 0),
        runs: Number(stats.runs || 0),
        wickets: Number(stats.wickets || 0),
        maidens: scorecardMaidens(data, scorecardPlayerId(player), stats.maidens),
        career,
      };
    })
    .filter(
      (bowler) =>
        bowler.legalBalls || bowler.runs || bowler.wickets
    );

  const commentaryDeliveries = hydrateDeliveryCommentary(
    Array.isArray(data.deliveries) ? data.deliveries : []
  );

  const totalExtras =
    Number(extras.nb || 0) +
    Number(extras.wd || 0) +
    Number(extras.bye || 0) +
    Number(extras.lb || 0);

  return (
    <section className="match-innings-scorecard">
      <div className="match-innings-heading">
        <div>
          <p className="eyebrow">INNINGS</p>
          <small>{battingTeam.name}</small>
        </div>
        <strong>
          {Number(data.runs ?? 0)}/{Number(data.wickets ?? 0)}
        </strong>
      </div>

      <div className="match-scorecard-block">
        <h4>Batting</h4>
        <div className="match-scorecard-table-wrap">
          <table className="match-scorecard-table">
            <thead>
              <tr>
                <th>Batter</th>
                <th>R</th>
                <th>B</th>
                <th>4s</th>
                <th>6s</th>
                <th>SR</th>
              </tr>
            </thead>
            <tbody>
              {played.length ? played.map((batter) => (
                <tr key={batter.id}>
                  <td>
                    <strong>{batter.name}</strong>
                    <small>
                      {batter.status === "out"
                        ? `out • ${batter.dismissal}${batter.fielder ? ` • ${batter.fielder}` : ""}`
                        : batter.status === "retired hurt"
                          ? "Retired hurt"
                          : "not out"}
                      {batter.bowler ? ` • Bowler: ${batter.bowler}` : ""}
                    </small>
                    {/* {batter.career && (
                      <small>
                        Career: {batter.career.battingRuns} runs · Avg {batter.career.battingAverage} · SR {batter.career.strikeRate}
                      </small>
                    )} */}
                  </td>
                  <td>{batter.runs}</td>
                  <td>{batter.balls}</td>
                  <td>{batter.fours}</td>
                  <td>{batter.sixes}</td>
                  <td>{scorecardStrikeRate(batter.runs, batter.balls)}</td>
                </tr>
              )) : (
                <tr><td colSpan="6" className="match-scorecard-empty">No batting data saved</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="match-scorecard-block">
        <h4>Yet to Bat</h4>
        <p className="match-scorecard-note">
          {yetToBat.length ? yetToBat.map((batter) => batter.name).join(", ") : "None"}
        </p>
      </div>

      <div className="match-scorecard-block">
        <h4>Fall of Wickets</h4>
        {fallOfWickets.length ? (
          <div className="match-fow-list">
            {fallOfWickets.map((item) => (
              <span key={`${item.wicket}-${item.score}-${item.batter}`}>
                {item.wicket}-{item.score} ({item.batter}, {item.over})
              </span>
            ))}
          </div>
        ) : <p className="match-scorecard-note">No wickets</p>}
      </div>

      <div className="match-scorecard-block">
        <h4>Extras</h4>
        <p className="match-scorecard-note">
          NB {extras.nb || 0}, WD {extras.wd || 0}, BYE {extras.bye || 0}, LB {extras.lb || 0} • Total {totalExtras}
        </p>
      </div>

      <div className="match-scorecard-block">
        <h4>Bowling</h4>
        <div className="match-scorecard-table-wrap">
          <table className="match-scorecard-table">
            <thead>
              <tr>
                <th>Bowler</th>
                <th>O</th>
                <th>M</th>
                <th>R</th>
                <th>W</th>
                <th>Econ</th>
              </tr>
            </thead>
            <tbody>
              {bowlers.length ? bowlers.map((bowler) => (
                <tr key={bowler.id}>
                  <td>
                    <strong>{bowler.name}</strong>
                    {/* {bowler.career && (
                      <small>
                        Career: {bowler.career.wickets} wickets · Eco {bowler.career.economy}
                      </small>
                    )} */}
                  </td>
                  <td>{scorecardOvers(bowler.legalBalls)}</td>
                  <td>{bowler.maidens}</td>
                  <td>{bowler.runs}</td>
                  <td>{bowler.wickets}</td>
                  <td>{scorecardEconomy(bowler.runs, bowler.legalBalls)}</td>
                </tr>
              )) : (
                <tr><td colSpan="6" className="match-scorecard-empty">No bowling data saved</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {commentaryEnabled && (
        <CommentarySections
          deliveries={commentaryDeliveries}
          loading={commentaryLoading && !commentaryDeliveries.length}
        />
      )}
    </section>
  );
}



/* =========================================================
   FINISHED MATCH ANALYSIS GRAPHS
   ---------------------------------------------------------
   1. Match prediction throughout the match
   2. Batter performance - both teams
   3. Bowler performance - both teams

   Uses every recorded match state, including live and unfinished matches.
========================================================= */

function FinishedMatchAnalysisGraphs({ match }) {
  if (!match) return null;

  const isTestMatch = isTestMatchRecord(match);
  const teamA = scorecardTeam(match, "A");
  const teamB = scorecardTeam(match, "B");


  /* =======================================================
     TEAM HELPERS
  ======================================================= */

  const getTeamName = (team) =>
    team?.name ||
    "Team";


  const getTeamId = (team) =>
    String(
      team?.id ??
      team?.teamId ??
      ""
    );


  const teamAName =
    getTeamName(teamA);

  const teamBName =
    getTeamName(teamB);


  /* =======================================================
     INNINGS
  ======================================================= */

  const innings = scorecardHistoryInnings({
    match,
    scoringState: match.scoringState || {},
  });


  /* =======================================================
     1. MATCH PREDICTION DATA
     -------------------------------------------------------
     One point after every recorded delivery.

     Team A and Team B are kept in the same graph.
  ======================================================= */

  const predictionPoints = [];


  innings.forEach(
    (inningsData, inningsIndex) => {
      const deliveries =
        Array.isArray(
          inningsData?.deliveries
        )
          ? inningsData.deliveries
          : [];


      deliveries.forEach(
        (delivery, deliveryIndex) => {
          if (!deliveries.length) {
            return;
          }


          const upto =
            deliveries.slice(
              0,
              deliveryIndex + 1
            );


          const totals =
            deliveryHistoryTotals(
              upto
            );


          const state = {
            ...(inningsData || {}),

            inningsIndex,

            inningsRuns:
              totals.runs,

            inningsWickets:
              totals.wickets,

            legalBalls:
              totals.legalBalls,

            deliveries:
              upto,

            battingStats:
              inningsData?.battingStats ||
              {},

            bowlingStats:
              inningsData?.bowlingStats ||
              {},

            strikerId:
              delivery?.strikerId ||
              "",

            nonStrikerId:
              delivery?.nonStrikerId ||
              "",

            currentBowlerId:
              delivery?.bowlerId ||
              "",
          };


          const prediction =
            getPredictionForDelivery({
              match:
                predictionHistoryMatch(
                  match
                ),

              scoringState:
                state,

              deliveryIndex,
            });


          const fallbackImpact = Math.min(
            45,
            (delivery?.wicket ? 25 : 0) +
              Math.min(
                14,
                Math.max(0, Number(delivery?.runs ?? delivery?.batterRuns ?? 0)) * 2
              )
          );
          const fallbackA = Math.max(
            0,
            Math.min(
              100,
              50 + (inningsData?.teamId === "B" ? -fallbackImpact : fallbackImpact)
            )
          );
          const usablePrediction = prediction || {
            A: fallbackA,
            B: 100 - fallbackA,
            draw: isTestMatch ? 0 : undefined,
          };


          const globalIndex =
            predictionPoints.length;


          predictionPoints.push({
            index:
              globalIndex + 1,

            innings:
              inningsIndex + 1,

            over:
              Number(
                delivery?.over ||
                Math.floor(
                  deliveryIndex / 6
                ) + 1
              ),

            ball:
              Number(
                delivery?.ball ||
                (deliveryIndex % 6) + 1
              ),

            teamA:
              Number(
                usablePrediction.A || 0
              ),

            teamB:
              Number(
                usablePrediction.B || 0
              ),

            draw:
              Number(
                usablePrediction.draw || 0
              ),
          });
        }
      );
    }
  );

  if (!predictionPoints.length) {
    const fallbackPrediction = calculateWinPrediction({
      match: predictionHistoryMatch(match),
      scoringState: match.scoringState || null,
    }) || { A: 50, B: 50, draw: isTestMatch ? 0 : undefined };
    predictionPoints.push({
      index: 1,
      innings: 1,
      over: 0,
      ball: 0,
      teamA: Number(fallbackPrediction.A || 50),
      teamB: Number(fallbackPrediction.B || 50),
      draw: Number(fallbackPrediction.draw || 0),
    });
  }


  /* =======================================================
     2. BATTER PERFORMANCE DATA
     -------------------------------------------------------
     Uses the same recorded scorecard statistics already
     used by the existing Player of the Match section.
  ======================================================= */

  const performances =
    recordedPlayerPerformances({
      match,
    });


  const teamAPlayers =
    performances
      .filter(
        (player) =>
          String(
            player.teamName
          ) ===
          String(teamAName)
      )
      .filter(
        (player) =>
          player.runs > 0 ||
          player.balls > 0
      )
      .sort(
        (a, b) =>
          b.runs - a.runs
      );


  const teamBPlayers =
    performances
      .filter(
        (player) =>
          String(
            player.teamName
          ) ===
          String(teamBName)
      )
      .filter(
        (player) =>
          player.runs > 0 ||
          player.balls > 0
      )
      .sort(
        (a, b) =>
          b.runs - a.runs
      );


  /*
   * Keep every recorded batter.
   *
   * The graph container becomes horizontally scrollable
   * on very small screens instead of hiding players.
   */

  const batterPlayers = [
    ...teamAPlayers.map(
      (player) => ({
        ...player,
        graphTeam: "A",
      })
    ),

    ...teamBPlayers.map(
      (player) => ({
        ...player,
        graphTeam: "B",
      })
    ),
  ];


  /* =======================================================
     3. BOWLER PERFORMANCE DATA
     -------------------------------------------------------
     Primary metric = wickets.

     Economy is retained for tooltip information.
  ======================================================= */

  const teamABowlers =
    performances
      .filter(
        (player) =>
          String(
            player.teamName
          ) ===
          String(teamAName)
      )
      .filter(
        (player) =>
          player.wickets > 0 ||
          player.legalBalls > 0
      )
      .sort(
        (a, b) => {
          if (
            b.wickets !==
            a.wickets
          ) {
            return (
              b.wickets -
              a.wickets
            );
          }

          return (
            (a.economy ?? 999) -
            (b.economy ?? 999)
          );
        }
      );


  const teamBBowlers =
    performances
      .filter(
        (player) =>
          String(
            player.teamName
          ) ===
          String(teamBName)
      )
      .filter(
        (player) =>
          player.wickets > 0 ||
          player.legalBalls > 0
      )
      .sort(
        (a, b) => {
          if (
            b.wickets !==
            a.wickets
          ) {
            return (
              b.wickets -
              a.wickets
            );
          }

          return (
            (a.economy ?? 999) -
            (b.economy ?? 999)
          );
        }
      );


  const bowlerPlayers = [
    ...teamABowlers.map(
      (player) => ({
        ...player,
        graphTeam: "A",
      })
    ),

    ...teamBBowlers.map(
      (player) => ({
        ...player,
        graphTeam: "B",
      })
    ),
  ];


  /* =======================================================
     EMPTY GRAPH HANDLER
  ======================================================= */

  const GraphEmpty = ({
    message,
  }) => (
    <div className="match-analysis-empty">
      {message}
    </div>
  );


  /* =======================================================
     GRAPH POINT GENERATOR
  ======================================================= */

  const createPoints = (
    values,
    maxValue,
    width,
    height,
    padding
  ) => {
    if (!values.length) {
      return [];
    }


    const usableWidth =
      width -
      padding.left -
      padding.right;


    const usableHeight =
      height -
      padding.top -
      padding.bottom;


    const step =
      values.length === 1
        ? 0
        : usableWidth /
          (values.length - 1);


    return values.map(
      (value, index) => {
        const safeValue =
          Math.max(
            0,
            Number(value) || 0
          );


        const x =
          padding.left +
          index * step;


        const y =
          padding.top +
          usableHeight -
          (safeValue /
            Math.max(
              maxValue,
              1
            )) *
            usableHeight;


        return {
          x,
          y,
          value:
            safeValue,
        };
      }
    );
  };


  /* =======================================================
     LINE PATH
  ======================================================= */

  const createLinePath = (
    points
  ) => {
    if (!points.length) {
      return "";
    }


    return points
      .map(
        (point, index) =>
          `${
            index === 0
              ? "M"
              : "L"
          } ${point.x} ${point.y}`
      )
      .join(" ");
  };


  /* =======================================================
     GRAPH CONSTANTS
  ======================================================= */

  const chartWidth = 1000;
  const chartHeight = 300;

  const chartPadding = {
    left: 48,
    right: 24,
    top: 25,
    bottom: 45,
  };


  /* =======================================================
     PREDICTION GRAPH
  ======================================================= */

  const predictionMax = 100;

  const predictionA =
    createPoints(
      predictionPoints.map(
        (point) =>
          point.teamA
      ),
      predictionMax,
      chartWidth,
      chartHeight,
      chartPadding
    );


  const predictionB =
    createPoints(
      predictionPoints.map(
        (point) =>
          point.teamB
      ),
      predictionMax,
      chartWidth,
      chartHeight,
      chartPadding
    );

  const predictionDraw = isTestMatch
    ? createPoints(
        predictionPoints.map((point) => point.draw),
        predictionMax,
        chartWidth,
        chartHeight,
        chartPadding
      )
    : [];


  /* =======================================================
     BATTER GRAPH
  ======================================================= */

  const batterMax =
    Math.max(
      ...batterPlayers.map(
        (player) =>
          Number(
            player.runs || 0
          )
      ),
      10
    );


  const batterPoints =
    createPoints(
      batterPlayers.map(
        (player) =>
          Number(
            player.runs || 0
          )
      ),
      batterMax,
      chartWidth,
      chartHeight,
      chartPadding
    );


  /* =======================================================
     BOWLER GRAPH
  ======================================================= */

  const bowlerMax =
    Math.max(
      ...bowlerPlayers.map(
        (player) =>
          Number(
            player.wickets || 0
          )
      ),
      1
    );


  const bowlerPoints =
    createPoints(
      bowlerPlayers.map(
        (player) =>
          Number(
            player.wickets || 0
          )
      ),
      bowlerMax,
      chartWidth,
      chartHeight,
      chartPadding
    );


  /* =======================================================
     Y-AXIS LABELS
  ======================================================= */

  const PredictionYAxis = () => (
    <>
      <text
        x="15"
        y="31"
        className="match-analysis-axis-label"
      >
        100%
      </text>

      <text
        x="23"
        y="150"
        className="match-analysis-axis-label"
      >
        50%
      </text>

      <text
        x="30"
        y="272"
        className="match-analysis-axis-label"
      >
        0%
      </text>
    </>
  );


  /* =======================================================
     PERFORMANCE Y AXIS
  ======================================================= */

  const PerformanceYAxis = ({
    max,
    suffix = "",
  }) => (
    <>
      <text
        x="18"
        y="31"
        className="match-analysis-axis-label"
      >
        {max}
        {suffix}
      </text>

      <text
        x="23"
        y="150"
        className="match-analysis-axis-label"
      >
        {Math.round(
          max / 2
        )}
        {suffix}
      </text>

      <text
        x="30"
        y="272"
        className="match-analysis-axis-label"
      >
        0{suffix}
      </text>
    </>
  );


  return (
    <section className="finished-match-analysis">

  <div className="finished-match-analysis-header">

    <div>
      <p className="finished-match-analysis-eyebrow">
        MATCH ANALYSIS
      </p>

      <h3>
        Match Performance Graphs
      </h3>

      <small>
        Detailed visual analysis from the completed scorecard
      </small>
    </div>

    <span className="finished-analysis-badge">
      COMPLETED
    </span>

  </div>


  {/* =================================================
      GRAPH 1
  ================================================== */}

  <div className="match-analysis-chart-card">

    <div className="match-analysis-chart-header">

      <div>
        <strong>
          Win Prediction Throughout Match
        </strong>

        <small>
          Probability movement after each recorded delivery
        </small>
      </div>

      <div className="match-analysis-legend">

        <span>
          <i className="legend-team-a" />
          {teamAName}
        </span>

        <span>
          <i className="legend-team-b" />
          {teamBName}
        </span>
        {isTestMatch && (
          <span>
            <i className="legend-draw" />
            Draw
          </span>
        )}

      </div>

    </div>


    {predictionPoints.length ? (
      <div className="match-analysis-chart-scroll">

        <svg
          className="match-analysis-svg"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Match win prediction graph"
        >

          {/* Grid */}

          <line
            x1={chartPadding.left}
            y1="25"
            x2={chartWidth - chartPadding.right}
            y2="25"
            className="analysis-grid-line"
          />

          <line
            x1={chartPadding.left}
            y1="150"
            x2={chartWidth - chartPadding.right}
            y2="150"
            className="analysis-grid-line"
          />

          <line
            x1={chartPadding.left}
            y1="275"
            x2={chartWidth - chartPadding.right}
            y2="275"
            className="analysis-grid-line"
          />


          <PredictionYAxis />


          {/* Team A */}

          <path
            d={createLinePath(
              predictionA
            )}
            className="analysis-line team-a-line"
            fill="none"
          />


          {/* Team B */}

          <path
            d={createLinePath(
              predictionB
            )}
            className="analysis-line team-b-line"
            fill="none"
          />

          {isTestMatch && (
            <path
              d={createLinePath(predictionDraw)}
              className="analysis-line draw-line"
              fill="none"
            />
          )}


          {/* Team A points */}

          {predictionA.map(
            (point, index) => (
              <circle
                key={`prediction-a-${index}`}
                cx={point.x}
                cy={point.y}
                r="3.2"
                className="analysis-point team-a-point"
              >
                <title>
                  Over{" "}
                  {
                    predictionPoints[
                      index
                    ]?.over
                  }
                  .
                  {
                    predictionPoints[
                      index
                    ]?.ball
                  }{" "}
                  •{" "}
                  {teamAName}:{" "}
                  {point.value.toFixed(
                    1
                  )}
                  %
                </title>
              </circle>
            )
          )}


          {/* Team B points */}

          {predictionB.map(
            (point, index) => (
              <circle
                key={`prediction-b-${index}`}
                cx={point.x}
                cy={point.y}
                r="3.2"
                className="analysis-point team-b-point"
              >
                <title>
                  Over{" "}
                  {
                    predictionPoints[
                      index
                    ]?.over
                  }
                  .
                  {
                    predictionPoints[
                      index
                    ]?.ball
                  }{" "}
                  •{" "}
                  {teamBName}:{" "}
                  {point.value.toFixed(
                    1
                  )}

                  {isTestMatch && predictionDraw.map((point, index) => (
                    <circle
                      key={`prediction-draw-${index}`}
                      cx={point.x}
                      cy={point.y}
                      r="3.2"
                      className="analysis-point draw-point"
                    >
                      <title>
                        Over {predictionPoints[index]?.over}.{predictionPoints[index]?.ball}
                        {" • Draw: "}
                        {point.value.toFixed(1)}%
                      </title>
                    </circle>
                  ))}
                  %
                </title>
              </circle>
            )
          )}

        </svg>

      </div>
    ) : (
      <GraphEmpty
        message="Prediction data is not available for this completed match."
      />
    )}

  </div>


  {/* =================================================
      GRAPH 2 - BATTER RUNS BAR GRAPH
  ================================================== */}

  <div className="match-analysis-chart-card">

    <div className="match-analysis-chart-header">

      <div>
        <strong>
          Batter Performance
        </strong>

        <small>
          Runs scored by every recorded batter from both innings
        </small>
      </div>

      <div className="match-analysis-legend">

        <span>
          <i className="legend-team-a" />
          {teamAName}
        </span>

        <span>
          <i className="legend-team-b" />
          {teamBName}
        </span>

      </div>

    </div>


    {batterPlayers.length ? (
      <div className="match-analysis-chart-scroll">

        <svg
          className="match-analysis-svg performance-svg batter-bar-svg"
          viewBox={`0 0 ${Math.max(
            chartWidth,
            batterPlayers.length * 75
          )} ${chartHeight}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Batter runs bar graph"
        >

          {(() => {

            const graphWidth = Math.max(
              chartWidth,
              batterPlayers.length * 75
            );

            const graphLeft =
              chartPadding.left;

            const graphRight =
              graphWidth -
              chartPadding.right;

            const graphTop = 25;
            const graphBottom = 265;
            const graphHeight =
              graphBottom - graphTop;

            const maxRuns = Math.max(
              10,
              ...batterPlayers.map(
                (player) =>
                  Number(
                    player.runs || 0
                  )
              )
            );

            const slotWidth =
              (graphRight - graphLeft) /
              Math.max(
                batterPlayers.length,
                1
              );

            const barWidth =
              Math.min(
                38,
                slotWidth * 0.55
              );

            return (
              <>

                {/* Grid */}

                <line
                  x1={graphLeft}
                  y1={graphTop}
                  x2={graphRight}
                  y2={graphTop}
                  className="analysis-grid-line"
                />

                <line
                  x1={graphLeft}
                  y1={
                    graphTop +
                    graphHeight / 2
                  }
                  x2={graphRight}
                  y2={
                    graphTop +
                    graphHeight / 2
                  }
                  className="analysis-grid-line"
                />

                <line
                  x1={graphLeft}
                  y1={graphBottom}
                  x2={graphRight}
                  y2={graphBottom}
                  className="analysis-grid-line"
                />


                {/* Y Axis */}

                <text
                  x="10"
                  y={graphTop + 4}
                  className="analysis-axis-label"
                >
                  {maxRuns}
                </text>

                <text
                  x="10"
                  y={
                    graphTop +
                    graphHeight / 2 +
                    4
                  }
                  className="analysis-axis-label"
                >
                  {Math.round(
                    maxRuns / 2
                  )}
                </text>

                <text
                  x="10"
                  y={graphBottom + 4}
                  className="analysis-axis-label"
                >
                  0
                </text>


                {/* Bars */}

                {batterPlayers.map(
                  (player, index) => {

                    const runs = Number(
                      player.runs || 0
                    );

                    const barHeight =
                      maxRuns > 0
                        ? (runs / maxRuns) *
                          graphHeight
                        : 0;

                    const x =
                      graphLeft +
                      slotWidth * index +
                      slotWidth / 2 -
                      barWidth / 2;

                    const y =
                      graphBottom -
                      barHeight;

                    const teamClass =
                      player.graphTeam ===
                      "A"
                        ? "team-a-bar"
                        : "team-b-bar";

                    return (
                      <g
                        key={`batter-bar-${player.id}-${index}`}
                      >

                        {/* Bar */}

                        <rect
                          x={x}
                          y={y}
                          width={barWidth}
                          height={Math.max(
                            barHeight,
                            runs > 0 ? 3 : 1
                          )}
                          rx="6"
                          ry="6"
                          className={`analysis-bar ${teamClass}`}
                        >
                          <title>
                            {player.name} •{" "}
                            {runs} runs
                            {player.balls != null
                              ? ` • ${player.balls} balls`
                              : ""}
                            {player.strikeRate != null
                              ? ` • SR ${Number(
                                  player.strikeRate
                                ).toFixed(1)}`
                              : ""}
                          </title>
                        </rect>


                        {/* Run value */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y={Math.max(
                            y - 7,
                            15
                          )}
                          textAnchor="middle"
                          className="analysis-bar-value"
                        >
                          {runs}
                        </text>


                        {/* Player name */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y="292"
                          textAnchor="middle"
                          className={
                            player.graphTeam ===
                            "A"
                              ? "analysis-player-label team-a-label"
                              : "analysis-player-label team-b-label"
                          }
                        >
                          {String(
                            player.name ||
                              "Player"
                          ).slice(
                            0,
                            10
                          )}
                        </text>

                      </g>
                    );
                  }
                )}

              </>
            );

          })()}

        </svg>

      </div>
    ) : (
      <GraphEmpty
        message="No recorded batting performance is available."
      />
    )}

  </div>


  {/* =================================================
      GRAPH 3 - BOWLER WICKETS + ECONOMY
  ================================================== */}

  <div className="match-analysis-chart-card">

    <div className="match-analysis-chart-header">

      <div>
        <strong>
          Bowler Performance
        </strong>

        <small>
          Wickets and economy of recorded bowlers from both teams
        </small>
      </div>

      <div className="match-analysis-legend">

        <span>
          <i className="legend-team-a" />
          {teamAName}
        </span>

        <span>
          <i className="legend-team-b" />
          {teamBName}
        </span>

      </div>

    </div>


    {bowlerPlayers.length ? (
      <div className="match-analysis-chart-scroll">

        <svg
          className="match-analysis-svg performance-svg bowler-bar-svg"
          viewBox={`0 0 ${Math.max(
            chartWidth,
            bowlerPlayers.length * 85
          )} ${chartHeight}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Bowler wickets and economy graph"
        >

          {(() => {

            const graphWidth = Math.max(
              chartWidth,
              bowlerPlayers.length * 85
            );

            const graphLeft =
              chartPadding.left;

            const graphRight =
              graphWidth -
              chartPadding.right;

            const graphTop = 25;
            const graphBottom = 265;
            const graphHeight =
              graphBottom - graphTop;

            const maxWickets = Math.max(
              1,
              ...bowlerPlayers.map(
                (player) =>
                  Number(
                    player.wickets || 0
                  )
              )
            );

            const slotWidth =
              (graphRight - graphLeft) /
              Math.max(
                bowlerPlayers.length,
                1
              );

            const barWidth =
              Math.min(
                34,
                slotWidth * 0.48
              );

            return (
              <>

                {/* Grid */}

                <line
                  x1={graphLeft}
                  y1={graphTop}
                  x2={graphRight}
                  y2={graphTop}
                  className="analysis-grid-line"
                />

                <line
                  x1={graphLeft}
                  y1={
                    graphTop +
                    graphHeight / 2
                  }
                  x2={graphRight}
                  y2={
                    graphTop +
                    graphHeight / 2
                  }
                  className="analysis-grid-line"
                />

                <line
                  x1={graphLeft}
                  y1={graphBottom}
                  x2={graphRight}
                  y2={graphBottom}
                  className="analysis-grid-line"
                />


                {/* Y Axis */}

                <text
                  x="8"
                  y={graphTop + 4}
                  className="analysis-axis-label"
                >
                  {maxWickets}
                </text>

                <text
                  x="8"
                  y={
                    graphTop +
                    graphHeight / 2 +
                    4
                  }
                  className="analysis-axis-label"
                >
                  {Math.round(
                    maxWickets / 2
                  )}
                </text>

                <text
                  x="8"
                  y={graphBottom + 4}
                  className="analysis-axis-label"
                >
                  0
                </text>


                {/* Wickets bars */}

                {bowlerPlayers.map(
                  (player, index) => {

                    const wickets =
                      Number(
                        player.wickets || 0
                      );

                    const economy =
                      Number(
                        player.economy || 0
                      );

                    const barHeight =
                      maxWickets > 0
                        ? (wickets /
                            maxWickets) *
                          graphHeight
                        : 0;

                    const x =
                      graphLeft +
                      slotWidth * index +
                      slotWidth / 2 -
                      barWidth / 2;

                    const y =
                      graphBottom -
                      barHeight;

                    const teamClass =
                      player.graphTeam ===
                      "A"
                        ? "team-a-bar"
                        : "team-b-bar";

                    return (
                      <g
                        key={`bowler-bar-${player.id}-${index}`}
                      >

                        {/* Wicket bar */}

                        <rect
                          x={x}
                          y={y}
                          width={barWidth}
                          height={Math.max(
                            barHeight,
                            wickets > 0
                              ? 3
                              : 1
                          )}
                          rx="6"
                          ry="6"
                          className={`analysis-bar ${teamClass}`}
                        >
                          <title>
                            {player.name} •{" "}
                            {wickets} wickets •
                            Economy{" "}
                            {economy.toFixed(
                              2
                            )}
                          </title>
                        </rect>


                        {/* Wicket value */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y={Math.max(
                            y - 7,
                            15
                          )}
                          textAnchor="middle"
                          className="analysis-bar-value"
                        >
                          {wickets}W
                        </text>


                        {/* Economy */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y="280"
                          textAnchor="middle"
                          className="analysis-economy-label"
                        >
                          Eco{" "}
                          {economy.toFixed(
                            2
                          )}
                        </text>


                        {/* Bowler name */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y="295"
                          textAnchor="middle"
                          className={
                            player.graphTeam ===
                            "A"
                              ? "analysis-player-label team-a-label"
                              : "analysis-player-label team-b-label"
                          }
                        >
                          {String(
                            player.name ||
                              "Player"
                          ).slice(
                            0,
                            9
                          )}
                        </text>

                      </g>
                    );
                  }
                )}

              </>
            );

          })()}

        </svg>

      </div>
    ) : (
      <GraphEmpty
        message="No recorded bowling performance is available."
      />
    )}

  </div>


  {/* =================================================
      PARTNERSHIP ANALYSIS - BOTH INNINGS
  ================================================== */}

  <div className="match-analysis-chart-card partnership-analysis-card">

    <div className="match-analysis-chart-header">

      <div>
        <strong>
          Batting Partnerships
        </strong>

        <small>
          Partnerships between batters in both innings
        </small>
      </div>

    </div>


    {(() => {

      const partnershipInnings = isTestMatchRecord(match)
        ? scorecardHistoryInnings({
            match,
            scoringState: match?.scoringState || {},
          })
        : [
            match?.firstInningsData,
            match?.secondInningsData,
          ].filter(Boolean);

      const getId = (value) => {
        if (value == null || value === "") return "";
        if (typeof value === "object") {
          return String(
            value.id ??
            value.playerId ??
            value.uid ??
            value._id ??
            ""
          );
        }
        return String(value);
      };

      const getNameFromPlayer = (player) =>
        player?.name ||
        player?.displayName ||
        player?.playerName ||
        player?.fullName ||
        "";

      const getPlayerName = (innings, playerId) => {
        const id = getId(playerId);
        if (!id) return "";

        const battingStats = innings?.battingStats || {};
        const directStats = battingStats[id];
        if (directStats) {
          const directName = getNameFromPlayer(directStats);
          if (directName) return directName;
        }

        const matchingStat = Object.entries(battingStats).find(
          ([key, stats]) =>
            getId(key) === id ||
            getId(stats?.id) === id ||
            getId(stats?.playerId) === id ||
            getId(stats?.uid) === id
        );

        if (matchingStat) {
          const statName = getNameFromPlayer(matchingStat[1]);
          if (statName) return statName;
        }

        const players = [
          ...(teamA?.players || []),
          ...(teamB?.players || []),
        ];

        const player = players.find(
          (item) => getId(scorecardPlayerId(item)) === id || getId(item) === id
        );

        return getNameFromPlayer(player) || id;
      };

      const getDeliveryPlayerId = (delivery, fields) => {
        for (const field of fields) {
          const id = getId(delivery?.[field]);
          if (id) return id;
        }
        return "";
      };

      const getDeliveryPlayerName = (delivery, fields) => {
        for (const field of fields) {
          const value = delivery?.[field];
          const name = typeof value === "object"
            ? getNameFromPlayer(value)
            : "";
          if (name) return name;
        }
        return "";
      };

      const hasDeliveryPlayerField = (delivery, fields) =>
        fields.some((field) =>
          Object.prototype.hasOwnProperty.call(delivery || {}, field)
        );

      const getDeliveryRuns = (delivery) => {
        const runs = delivery?.runs;

        if (runs && typeof runs === "object") {
          const total = Number(
            runs.total ??
            runs.runs ??
            delivery?.totalRuns ??
            0
          );
          if (Number.isFinite(total)) return total;
        }

        const total = Number(
          delivery?.totalRuns ??
          runs ??
          0
        );

        if (Number.isFinite(total)) return total;

        const batterRuns = Number(
          delivery?.batterRuns ??
          delivery?.batsmanRuns ??
          0
        );
        const extras = Number(
          delivery?.extras?.total ??
          delivery?.extrasRuns ??
          0
        );

        return (Number.isFinite(batterRuns) ? batterRuns : 0) +
          (Number.isFinite(extras) ? extras : 0);
      };

      const isLegalDelivery = (delivery) => {
        if (delivery?.validBall === true) return true;
        if (delivery?.validBall === false) return false;
        if (
          delivery?.legalBall === true ||
          delivery?.isLegal === true ||
          delivery?.isLegalDelivery === true ||
          delivery?.countsAsLegalBall === true
        ) return true;
        if (
          delivery?.legalBall === false ||
          delivery?.isLegal === false ||
          delivery?.isLegalDelivery === false ||
          delivery?.countsAsLegalBall === false
        ) return false;

        const type = String(
          delivery?.type ??
          delivery?.deliveryType ??
          ""
        ).toUpperCase();

        return ![
          "NB",
          "NO_BALL",
          "NO-BALL",
          "WD",
          "WIDE",
          "DEAD",
        ].includes(type);
      };

      const isWicketDelivery = (delivery) =>
        Boolean(
          delivery?.wicket ||
          delivery?.wicketInfo ||
          delivery?.isWicket ||
          delivery?.dismissal ||
          delivery?.dismissalType ||
          delivery?.wicketType ||
          Number(delivery?.wickets || 0) > 0
        );

      const buildPartnerships = (innings, inningsNumber) => {
        if (!innings) return [];

        const deliveries = Array.isArray(innings?.deliveries)
          ? innings.deliveries
          : [];

        const playedBatters = Object.entries(innings?.battingStats || {})
          .filter(([, stats]) =>
            stats?.status !== "yet" ||
            Number(stats?.balls || 0) > 0 ||
            Number(stats?.runs || 0) > 0
          )
          .sort(([, left], [, right]) =>
            Number(left?.battingOrder || 0) - Number(right?.battingOrder || 0)
          );

        const normalizeName = (value) =>
          String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

        const batterIds = playedBatters.map(([id]) => id);

        const batterName = (id) => getPlayerName(innings, id) || id || "";

        const countLegalBalls = (fromIndex, toIndex) => {
          let balls = 0;
          for (let index = fromIndex; index <= toIndex; index += 1) {
            if (isLegalDelivery(deliveries[index])) balls += 1;
          }
          return balls;
        };

        const findBatterIdByName = (rawName) => {
          const target = normalizeName(rawName);
          if (!target) return "";
          const exact = batterIds.find(
            (id) => normalizeName(batterName(id)) === target
          );
          if (exact) return exact;
          return (
            batterIds.find((id) =>
              normalizeName(batterName(id)).includes(target)
            ) ||
            batterIds.find((id) =>
              target.includes(normalizeName(batterName(id)))
            ) ||
            ""
          );
        };

        const fallOfWickets = (Array.isArray(innings?.fallOfWickets)
          ? innings.fallOfWickets
          : []
        )
          .slice()
          .sort((a, b) => Number(a?.wicket || 0) - Number(b?.wicket || 0));

        const totalInningsRuns = Number(innings?.runs || 0);

        // Index of every delivery that ended in a wicket. This is only used
        // to attach an approximate ball count to each partnership when full
        // ball-by-ball data exists -- it is NOT used to work out who batted
        // together, since per-ball striker/non-striker fields are not
        // reliable enough for that.
        const wicketDeliveryIndices = [];
        deliveries.forEach((delivery, index) => {
          if (isWicketDelivery(delivery)) {
            wicketDeliveryIndices.push(index);
          }
        });

        const ballsFromStats = (ids) =>
          ids
            .filter(Boolean)
            .reduce((total, id) => {
              const stats = playedBatters.find(([playerId]) =>
                getId(playerId) === getId(id)
              )?.[1];
              return total + Number(stats?.balls || 0);
            }, 0);

        const ballsForSegment = (fromIndex, toIndex, ids) => {
          if (deliveries.length && fromIndex >= 0 && fromIndex <= toIndex) {
            return countLegalBalls(fromIndex, toIndex);
          }
          return ballsFromStats(ids);
        };

        const asBatter = (id) => (id ? { id, name: batterName(id) } : null);

        const partnerships = [];

        // ==================================================
        // PRIMARY LOGIC — REBUILT FROM FALL OF WICKETS
        // ==================================================
        // Real world scorecard rule: every partnership is measured between
        // two consecutive wickets (or from the start of the innings / the
        // last wicket to the end of the innings). The fall-of-wickets list
        // together with the batting order is the authoritative source for
        // who was actually at the crease during each partnership.
        //
        // The innings always starts with the two openers (battingOrder 1
        // and 2) at the crease. Every time a wicket falls: the dismissed
        // batter (identified from the fall-of-wickets entry) is removed,
        // the surviving batter carries straight over into the NEXT
        // partnership, and the next player in the batting order walks in
        // to join them. If there is no next player left, the surviving
        // batter continues alone and that partnership is correctly shown
        // as a single-batsman partnership (last man).
        if (fallOfWickets.length && batterIds.length) {
          let crease = [asBatter(batterIds[0]), asBatter(batterIds[1])].filter(
            Boolean
          );
          let nextBatterIndex = 2;
          let segmentStart = 0;
          let previousScore = 0;

          fallOfWickets.forEach((item, index) => {
            const wicketNumber = Number(item?.wicket || index + 1);
            const wicketScore = Number(item?.score || 0);
            const partnershipRuns = Math.max(0, wicketScore - previousScore);

            const wicketDeliveryIndex = wicketDeliveryIndices[index];
            const segmentEnd = Number.isInteger(wicketDeliveryIndex)
              ? wicketDeliveryIndex
              : segmentStart - 1;

            // Work out which of the two current crease batters is the one
            // who actually got out this time, so the survivor can be
            // carried forward correctly. Fall back to the first crease
            // batter if the fall-of-wickets name can't be matched, so the
            // pairing degrades gracefully instead of collapsing.
            const outId = findBatterIdByName(item?.batter);
            const outIndexInCrease = crease.findIndex(
              (batter) => getId(batter?.id) === getId(outId)
            );
            const dismissedIndex = outIndexInCrease !== -1 ? outIndexInCrease : 0;
            const survivor =
              crease.find((_, idx) => idx !== dismissedIndex) || null;

            const partnershipBatters = crease.filter(Boolean);
            const first = partnershipBatters[0] || {};
            const second = partnershipBatters[1] || null;

            partnerships.push({
              innings: inningsNumber,
              wicket: wicketNumber,
              striker: first.id || "",
              nonStriker: second?.id || "",
              strikerName: first.name || String(item?.batter || ""),
              nonStrikerName: second?.name || "",
              runs: partnershipRuns,
              balls: ballsForSegment(
                segmentStart,
                segmentEnd,
                partnershipBatters.map((batter) => batter.id)
              ),
            });

            // New partnership begins: the survivor stays at the crease,
            // the next batter in the batting order (if any) joins them.
            const incoming =
              nextBatterIndex < batterIds.length
                ? asBatter(batterIds[nextBatterIndex])
                : null;
            if (incoming) nextBatterIndex += 1;

            crease = [survivor, incoming].filter(Boolean);
            previousScore = wicketScore;
            segmentStart = Number.isInteger(wicketDeliveryIndex)
              ? wicketDeliveryIndex + 1
              : segmentStart;
          });

          // Final unbroken partnership after the last recorded wicket (the
          // batter(s) who finished the innings not out).
          const remainingRuns = Math.max(0, totalInningsRuns - previousScore);
          const remainingBatters = crease.filter(Boolean);
          const remainingBalls = ballsForSegment(
            segmentStart,
            deliveries.length - 1,
            remainingBatters.map((batter) => batter.id)
          );

          if (
            remainingBatters.length &&
            (remainingRuns > 0 || remainingBalls > 0)
          ) {
            const first = remainingBatters[0] || {};
            const second = remainingBatters[1] || null;
            partnerships.push({
              innings: inningsNumber,
              wicket: partnerships.length + 1,
              striker: first.id || "",
              nonStriker: second?.id || "",
              strikerName: first.name || "",
              nonStrikerName: second?.name || "",
              runs: remainingRuns,
              balls: remainingBalls,
            });
          }

          return partnerships.sort(
            (left, right) => left.wicket - right.wicket
          );
        }

        // ==================================================
        // NO WICKETS FALLEN — SINGLE OPENING PARTNERSHIP
        // ==================================================
        if (batterIds.length) {
          return [
            {
              innings: inningsNumber,
              wicket: 1,
              striker: batterIds[0],
              nonStriker: batterIds[1] || "",
              strikerName: batterName(batterIds[0]),
              nonStrikerName: batterIds[1] ? batterName(batterIds[1]) : "",
              runs: totalInningsRuns,
              balls: deliveries.length
                ? countLegalBalls(0, deliveries.length - 1)
                : Number(
                    playedBatters[0]?.[1]?.balls || 0
                  ),
            },
          ];
        }

        return [];
      };

      const inningsPartnerships = partnershipInnings.map(
        (innings, index) => ({
          title: `${index + 1}${testInningsSuffix(index)} Innings`,
          team:
            innings?.teamName ||
            (innings?.teamId === "B" ? teamBName : teamAName),
          items: buildPartnerships(innings, index + 1).sort(
            (left, right) => left.wicket - right.wicket
          ),
        })
      );

      const allPartnerships = inningsPartnerships.flatMap(
        (inningsData) => inningsData.items
      );

      if (!allPartnerships.length) {
        return (
          <GraphEmpty
            message="Partnership data is not available for this completed match."
          />
        );
      }

      return (
        <div className="partnership-list">

          {inningsPartnerships.map(
            (inningsData, inningsIndex) => (

              <div
                className="partnership-innings"
                key={`partnership-innings-${inningsIndex}`}
              >

                <div className="partnership-innings-header">

                  <strong>
                    {inningsData.title}
                  </strong>

                  <span>
                    {inningsData.team}
                  </span>

                </div>

                {inningsData.items.length ? (

                  <div className="partnership-items">

                    {inningsData.items.map(
                      (partnership, index) => (

                        <div
                          className="partnership-item"
                          key={`partnership-${inningsIndex}-${index}`}
                        >

                          <div className="partnership-batters">

                            <div className="partnership-player">
                              <span className="partnership-player-name">
                                {partnership.strikerName}
                                {!partnership.nonStrikerName && " (Single)"}
                              </span>
                            </div>

                            <div className="partnership-vs">
                              {partnership.nonStrikerName ? "+" : ""}
                            </div>

                            {partnership.nonStrikerName ? (
                              <div className="partnership-player">
                                <span className="partnership-player-name">
                                  {partnership.nonStrikerName}
                                </span>
                              </div>
                            ) : null}

                          </div>

                          <div className="partnership-score">

                            <strong>
                              {partnership.runs}
                            </strong>

                            <span>
                              runs
                            </span>

                          </div>

                          {/* <div className="partnership-balls">
                            {partnership.balls}{" "}
                            balls
                          </div> */}

                        </div>
                      )
                    )}

                  </div>

                ) : (

                  <div className="partnership-empty">
                    No partnership data recorded for this innings.
                  </div>

                )}

              </div>
            )
          )}

        </div>
      );

    })()}

  </div>

</section>
  );
}

function MatchScorecard({
  match,
  careerStatsByPlayer,
  commentaryLoading = false,
}) {
  const [activeInnings, setActiveInnings] = useState(
    () => {
      if (!isTestMatchRecord(match)) return "first";
      const inningsIndex = Number(match?.scoringState?.inningsIndex);
      return Number.isInteger(inningsIndex) && inningsIndex >= 0
        ? `test-${inningsIndex}`
        : "test-0";
    }
  );
  const teamA = scorecardTeam(match, "A");
  const teamB = scorecardTeam(match, "B");
  const savedState = match.scoringState || {};
  const liveTeamId = savedState.inningsIndex === 1
    ? (match.battingTeamId === "A" ? "B" : "A")
    : match.battingTeamId || "A";
  const liveInnings = savedState.battingStats
    ? {
        teamId: liveTeamId,
        teamName: liveTeamId === "A" ? teamA.name : teamB.name,
        runs: savedState.inningsRuns ?? (liveTeamId === "A" ? match.scoreA : match.scoreB) ?? 0,
        wickets: savedState.inningsWickets ?? 0,
        balls: savedState.legalBalls ?? 0,
        battingStats: savedState.battingStats,
        bowlingStats: savedState.bowlingStats,
        extras: savedState.extras,
        deliveries: savedState.deliveries,
        fallOfWickets: savedState.fallOfWickets,
        completedOvers: savedState.completedOvers,
      }
    : null;
  const firstTeamId = match.firstInningsData?.teamId ||
    (match.firstInningsTeamId === "B" ? "B" : "A");
  const secondTeamId = firstTeamId === "A" ? "B" : "A";
  const historicalInnings = scorecardHistoryInnings({
    match,
    scoringState: savedState,
  });
  const firstInnings = historicalInnings[0] || match.firstInningsData || (
    savedState.inningsIndex === 0 ? liveInnings : null
  );
  const secondInnings = historicalInnings[1] || match.secondInningsData || (
    savedState.inningsIndex === 1 ? liveInnings : null
  );

  const tossResult = match.secondTossResult || null;
  const tossWinner = match.secondTossWinner;

  const inningsFor = (data, defaultBattingTeam, options = {}) => {
    const battingTeam = data?.teamId === "B" ? teamB : data?.teamId === "A" ? teamA : defaultBattingTeam;
    const bowlingTeam = battingTeam.id === "A" ? teamB : teamA;

    return (
      <MatchInningsScorecard
        key={`${battingTeam.id}-${data?.teamId || "saved"}`}
        innings={data}
        battingTeam={battingTeam}
        bowlingTeam={bowlingTeam}
        match={match}
        careerStatsByPlayer={careerStatsByPlayer}
        commentaryLoading={commentaryLoading}
        commentaryEnabled={options.commentaryEnabled === true}
      />
    );
  };

  const prediction = calculateWinPrediction({
    match,
    scoringState: savedState,
  });
  const isTestMatch = isTestMatchRecord(match);
  const testScorecardInnings = isTestMatch
    ? scorecardHistoryInnings({ match, scoringState: savedState })
    : [];
  const commentaryInnings = isFinalMatch(match)
    ? getFinishedCommentaryInnings({
        match,
        scoringState: savedState,
      })
    : getLiveCommentaryInnings({
        match,
        scoringState: savedState,
      });

  // useEffect(() => {
  //   if (!isFinalMatch(match)) return;

  //   const deliveriesByInnings = commentaryInnings.map((innings, inningsIndex) => ({
  //     innings: inningsIndex + 1,
  //     team: innings?.teamName || innings?.teamId || "Unknown team",
  //     overs: hydrateDeliveryCommentary(
  //       Array.isArray(innings?.deliveries) ? innings.deliveries : []
  //     ).reduce((overs, delivery) => {
  //       const overNumber = Number(
  //         delivery.__normalizedOver ??
  //         delivery.over ??
  //         delivery.overNumber ??
  //         0
  //       );
  //       const key = String(Number.isFinite(overNumber) ? overNumber : 0);
  //       if (!overs[key]) overs[key] = [];
  //       overs[key].push({
  //         over: overNumber,
  //         ball: Number(
  //           delivery.__normalizedBall ??
  //           delivery.ball ??
  //           delivery.ballNumber ??
  //           0
  //         ),
  //         batter: delivery.strikerName || delivery.batterName || "Unknown batter",
  //         bowler: delivery.bowlerName || "Unknown bowler",
  //         runs: Number(
  //           delivery.runs ??
  //           delivery.totalRuns ??
  //           delivery.batterRuns ??
  //           0
  //         ),
  //         wicket: delivery.wicket?.type || delivery.wicketType || null,
  //         position: delivery.shotRegion || delivery.shotPosition || "(no position)",
  //       });
  //       return overs;
  //     }, {}),
  //   }));

  //   console.groupCollapsed(
  //     `[Scorify] Finished match deliveries: ${match.id || "unknown match"}`
  //   );
  //   deliveriesByInnings.forEach((innings) => {
  //     console.groupCollapsed(
  //       `Innings ${innings.innings} - ${innings.team}`
  //     );
  //     Object.keys(innings.overs)
  //       .sort((left, right) => Number(left) - Number(right))
  //       .forEach((over) => {
  //         console.log(`Over ${over}`, innings.overs[over]);
  //       });
  //     console.groupEnd();
  //   });
  //   console.groupEnd();
  // }, [
  //   match?.id,
  //   match?.persistedDeliveries?.length,
  //   match?.scoringState?.deliveries?.length,
  //   commentaryInnings.length,
  // ]);

  const finalMatch = isFinalMatch(match);
  const printableCommentaryInnings = commentaryInnings.map((innings) => ({
    ...innings,
    deliveries: hydrateDeliveryCommentary(
      Array.isArray(innings?.deliveries) ? innings.deliveries : []
    ),
  }));
  const testTotals = testScorecardInnings.reduce((totals, innings) => {
    totals[innings.teamId === "B" ? "B" : "A"] += Number(innings.runs || 0);
    return totals;
  }, { A: 0, B: 0 });
  const testLeadText = isTestMatch
    ? testTotals.A === testTotals.B
      ? "Scores level"
      : testTotals.A > testTotals.B
        ? `${teamA.name} lead by ${testTotals.A - testTotals.B}`
        : `${teamB.name} lead by ${testTotals.B - testTotals.A}`
    : "";
  const currentTestDisplayDay = isTestMatch
    ? testDisplayDay({
        match,
        innings: testScorecardInnings,
        scoringState: savedState,
      })
    : 1;

  const handleDownloadScorecardPdf = () => {
    const printSheet = document.querySelector(".scorecard-print-sheet");

    if (!printSheet) {
      alert("Unable to prepare the complete scorecard for PDF.");
      return;
    }

    const printWindow = window.open("", "_blank");

    if (!printWindow) {
      alert("Please allow pop-ups in your browser to download the scorecard PDF.");
      return;
    }

    const teamAName = teamA?.name || "Team A";
    const teamBName = teamB?.name || "Team B";
    const printTitle = `${teamAName} vs ${teamBName} - Scorecard`;

    // Reuse every stylesheet already loaded by the app so the PDF window is
    // visually identical to the scorecard, while the complete print sheet
    // already contains BOTH innings instead of only the selected tab.
    const stylesheetLinks = Array.from(
      document.querySelectorAll('link[rel="stylesheet"]')
    )
      .map((link) => {
        const href = link.href;
        return href
          ? `<link rel="stylesheet" href="${href.replace(/"/g, "&quot;")}">`
          : "";
      })
      .join("\n");

    const inlineStyles = Array.from(document.querySelectorAll("style"))
      .map((style) => style.outerHTML)
      .join("\n");

    const printWindowDocument = printWindow.document;
    printWindowDocument.open();
    printWindowDocument.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${printTitle.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
    ${stylesheetLinks}
    ${inlineStyles}
    <style>
      @page { size: A4; margin: 10mm; }
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        background: #ffffff !important;
      }
      body {
        min-width: 0 !important;
      }
      .scorecard-print-sheet {
        display: block !important;
        position: static !important;
        width: 100% !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
        background: #ffffff !important;
        color: #111827 !important;
      }
      .scorecard-print-sheet,
      .scorecard-print-sheet * {
        visibility: visible !important;
      }
      .scorecard-print-sheet .match-scorecard-table-wrap {
        overflow: visible !important;
      }
      .scorecard-print-sheet .match-scorecard-table {
        width: 100% !important;
        min-width: 0 !important;
        table-layout: fixed !important;
      }
      .scorecard-print-sheet .match-scorecard-table th,
      .scorecard-print-sheet .match-scorecard-table td {
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }
      .scorecard-print-sheet .scorecard-download-button,
      .scorecard-print-sheet .match-scorecard-tabs {
        display: none !important;
      }
      .scorecard-print-page-break {
        break-before: page !important;
        page-break-before: always !important;
        height: 1px !important;
      }
      .scorecard-print-header,
      .match-toss-summary,
      .match-innings-scorecard,
      .match-scorecard-block,
      .win-prediction-card,
      .win-prediction-history,
      .match-impact-card,
      .finished-match-analysis,
      .match-analysis-chart-card {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
      svg {
        max-width: 100% !important;
      }
    </style>
  </head>
  <body class="scorecard-print-mode">
    ${printSheet.outerHTML}
  </body>
</html>`);
    printWindowDocument.close();

    const startPrint = () => {
      try {
        printWindow.focus();
        printWindow.print();
      } finally {
        window.setTimeout(() => {
          try {
            printWindow.close();
          } catch {
            // Ignore browser restrictions on closing a print window.
          }
        }, 1000);
      }
    };

    if (printWindow.document.fonts?.ready) {
      printWindow.document.fonts.ready
        .then(() => window.setTimeout(startPrint, 250))
        .catch(() => window.setTimeout(startPrint, 250));
    } else {
      window.setTimeout(startPrint, 500);
    }
  };

  const matchResultText =
    typeof match?.result === "string"
      ? match.result
      : match?.result?.text || match?.resultText || "";

  return (
    <>
      <div className="scorecard-print-sheet" aria-hidden="true">
        <div className="scorecard-print-header">
          <p className="eyebrow">MATCH SCORECARD</p>
          {isTestMatch && <strong className="test-match-label">TEST MATCH</strong>}
          <h1>{teamA.name} vs {teamB.name}</h1>
          {match?.createdAt && (
            <p>
              {new Date(match.createdAt).toLocaleString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
          {(matchResultText || match?.winner) && (
            <strong>{matchResultText || match.winner}</strong>
          )}
        </div>

        <LiveWinPredictionCard prediction={prediction} testMatch={isTestMatch} />
        {isTestMatch && (
          <section className="test-scorecard-innings">
            <h2>Test Match Innings</h2>
            {testScorecardInnings.map((innings, index) => (
              <div key={`${innings.teamId}-${index}`} className="test-scorecard-innings-block">
                <h3>
                  {innings.teamName} — {index + 1}{testInningsSuffix(index)} Innings
                  {innings.declared || (Array.isArray(match.declaredInnings) && match.declaredInnings.includes(Number(innings.inningsIndex))) ? " (d)" : ""}
                  {match.followOnEnforced && Number(innings.inningsIndex) === 2 ? " (f/o)" : ""}
                </h3>
                {inningsFor(innings, innings.teamId === "B" ? teamB : teamA, {
                  commentaryEnabled: false,
                })}
              </div>
            ))}
          </section>
        )}
        {finalMatch && (
          <MatchMatchImpactSections match={match} scoringState={savedState} />
        )}

        <div className="match-toss-summary">
          <span className="match-toss-coin">
            {tossResult === "Tails" ? "T" : "H"}
          </span>
          <span>
            Toss: {tossResult || "Not recorded"}
            {tossWinner?.name ? ` • ${tossWinner.name}` : ""}
          </span>
        </div>

        {firstInnings
          ? inningsFor(firstInnings, firstTeamId === "B" ? teamB : teamA, {
              commentaryEnabled: false,
            })
          : (
            <p className="match-scorecard-note">
              Detailed first-innings scorecard is not available for this match.
            </p>
          )}

        <div className="scorecard-print-page-break" />

        {secondInnings
          ? inningsFor(secondInnings, secondTeamId === "B" ? teamB : teamA, {
              commentaryEnabled: false,
            })
          : (
            <p className="match-scorecard-note">
              Detailed second-innings scorecard is not available for this match.
            </p>
          )}

        {finalMatch && (
          <>
            <FinishedMatchAnalysisGraphs match={match} />
            <PredictionOverHistory match={match} scoringState={savedState} />
          </>
        )}
        {finalMatch && printableCommentaryInnings.map((innings, index) => (
          <section className="scorecard-print-commentary" key={`print-commentary-${index}`}>
            <h2>{innings.teamName || `Innings ${index + 1}`} Commentary</h2>
            <CommentarySections deliveries={innings.deliveries} />
          </section>
        ))}
      </div>

      <div className="match-scorecard-full">
        {finalMatch && <button
          type="button"
          className="scorecard-download-button"
          onClick={handleDownloadScorecardPdf}
          aria-label="Download whole match scorecard as PDF"
          title="Download whole match scorecard as PDF"
        >
          <svg
            className="scorecard-download-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
          <span>Download PDF</span>
        </button>}
           <CommentaryTabs
        innings={commentaryInnings}
        autoScrollLatest={!finalMatch}
      />

        <LiveWinPredictionCard prediction={prediction} testMatch={isTestMatch} />
        {isTestMatch && <strong className="test-match-label">TEST MATCH</strong>}
        {finalMatch && (
          <MatchMatchImpactSections match={match} scoringState={savedState} />
        )}
      {isTestMatch ? (
        <>
          <div className="test-scorecard-summary">
            <strong>Day {currentTestDisplayDay} / {Number(match.maxDays || match.testDays || 5)}</strong>
            <span>
              {testScorecardInnings.reduce((total, innings) => total + testCompletedOvers(innings.balls), 0)} total overs played
              {" • "}
              {testScorecardInnings.length} innings played
              {" • "}
              {currentTestDisplayDay} days played
            </span>
            <span>{testLeadText}</span>
          </div>
          <div className="match-scorecard-tabs test-scorecard-tabs" role="tablist" aria-label="Test match innings">
            {testScorecardInnings.map((innings, index) => (
              <button
                key={`${innings.teamId}-${index}`}
                type="button"
                className={activeInnings === `test-${index}` ? "active" : ""}
                onClick={() => setActiveInnings(`test-${index}`)}
              >
                {innings.teamName}
                {innings.declared || (Array.isArray(match.declaredInnings) && match.declaredInnings.includes(Number(innings.inningsIndex))) ? " (d)" : ""}
                {match.followOnEnforced && Number(innings.inningsIndex) === 2 ? " (f/o)" : ""}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="match-scorecard-tabs" role="tablist" aria-label="Match innings">
          <button
            type="button"
            className={activeInnings === "first" ? "active" : ""}
            onClick={() => setActiveInnings("first")}
          >
            {firstInnings?.teamName || (firstTeamId === "B" ? teamB.name : teamA.name)}
          </button>
          {secondInnings && (
            <button
              type="button"
              className={activeInnings === "second" ? "active" : ""}
              onClick={() => setActiveInnings("second")}
            >
              {secondInnings.teamName || (secondTeamId === "A" ? teamA.name : teamB.name)}
            </button>
          )}
        </div>
      )}

      <div className="match-toss-summary">
        <span className="match-toss-coin">{tossResult === "Tails" ? "T" : "H"}</span>
        <span>
          Toss: {tossResult || "Not recorded"}
          {tossWinner?.name ? ` • ${tossWinner.name}` : ""}
        </span>
      </div>

      {isTestMatch
        ? (() => {
            const selectedIndex = String(activeInnings).startsWith("test-")
              ? Number(String(activeInnings).replace("test-", ""))
              : 0;
            const selected = testScorecardInnings[selectedIndex];
            return selected
              ? inningsFor(selected, selected.teamId === "B" ? teamB : teamA)
              : <p className="match-scorecard-note">This innings has not started yet.</p>;
          })()
        : activeInnings === "first"
        ? firstInnings
          ? inningsFor(firstInnings, teamA)
          : <p className="match-scorecard-note">Detailed first-innings scorecard is not available for this match.</p>
        : secondInnings
          ? inningsFor(secondInnings, teamB)
          : <p className="match-scorecard-note">Detailed second-innings scorecard is not available for this match.</p>}
    
          {/* =================================================
          FINISHED MATCH ANALYSIS
          Only appears after the match is completed.
      ================================================== */}

      {finalMatch && (
        <>
          <FinishedMatchAnalysisGraphs match={match} />
          <PredictionOverHistory match={match} scoringState={savedState} />
        </>
      )}
      </div>
    </>
  );
}

function Matches() {
  const navigate = useNavigate();
  const { matchId: scorecardMatchId } = useParams();
  const [searchParams] = useSearchParams();
  const tournamentFilterId = searchParams.get("tournamentId");
  const tournamentFixtureId = searchParams.get("fixtureId");
  const isAdmin =
    Boolean(ADMIN_UID) &&
    String(getCurrentUserId() || "") === String(ADMIN_UID);

  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [savedTeams, setSavedTeams] = useState([]);
  const [savedTeamPlayers, setSavedTeamPlayers] = useState([]);
  const [careerRecords, setCareerRecords] = useState(null);

  const [screen, setScreen] = useState("list");
  const [teamMode, setTeamMode] = useState(null);

  const [teamA, setTeamA] = useState({
    ...emptyTeam,
    id: "A",
    name: "Team A",
  });

  const [teamB, setTeamB] = useState({
    ...emptyTeam,
    id: "B",
    name: "Team B",
  });

  // Captains are selected before the first toss.
  const [captainA, setCaptainA] = useState(null);
  const [captainB, setCaptainB] = useState(null);

  // First toss decides which captain gets the later player-selection step.
  const [firstTossCaller, setFirstTossCaller] = useState(null);
  const [firstTossChoice, setFirstTossChoice] = useState(null);
  const [firstTossResult, setFirstTossResult] = useState(null);
  const [firstTossWinner, setFirstTossWinner] = useState(null);
  const [firstTossSpinning, setFirstTossSpinning] = useState(false);

  // Player draft. The first toss winner's team always picks first.
  const [nextPickTeam, setNextPickTeam] = useState(null);
  const [draftSelections, setDraftSelections] = useState([]);
  const [playerChoiceHistory, setPlayerChoiceHistory] = useState([]);

  const [playerSearch, setPlayerSearch] = useState("");

  // Final toss.
  const [secondTossCaller, setSecondTossCaller] = useState(null);
  const [secondTossChoice, setSecondTossChoice] = useState(null);
  const [secondTossResult, setSecondTossResult] = useState(null);
  const [secondTossWinner, setSecondTossWinner] = useState(null);
  const [secondTossSpinning, setSecondTossSpinning] = useState(false);

  const [battingTeam, setBattingTeam] = useState(null);
  const [bowlingTeam, setBowlingTeam] = useState(null);

  const [matchOvers, setMatchOvers] = useState(5);
  // Kept separate from `overs` so existing limited-overs matches remain
  // completely backward compatible.
  const [matchType, setMatchType] = useState("limited-overs");
  const [testOvers, setTestOvers] = useState(90);
  const [testDays, setTestDays] = useState(5);

  const [score, setScore] = useState({
    runs: 0,
    wickets: 0,
    balls: 0,
  });

  const [viewingMatch, setViewingMatch] = useState(null);
  const [persistedDeliveries, setPersistedDeliveries] = useState([]);
  const [commentaryLoading, setCommentaryLoading] = useState(false);
  const careerStatsByPlayer = useMemo(() => {
    if (!careerRecords || !viewingMatch) return null;
    const teamAPlayers =
      viewingMatch.teamA?.players || viewingMatch.teamAPlayers || [];
    const teamBPlayers =
      viewingMatch.teamB?.players || viewingMatch.teamBPlayers || [];
    return getCareerPerformanceByPlayer(
      [...teamAPlayers, ...teamBPlayers],
      careerRecords
    );
  }, [careerRecords, viewingMatch]);

  // Id of the match currently being deleted (prevents double clicks).
  const [deletingMatchId, setDeletingMatchId] = useState(null);
  const [tournamentContext, setTournamentContext] = useState(null);

  // --------------------------------------------------
  // LOAD DATA
  // --------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    loadCareerRecords()
      .then((records) => {
        if (!cancelled) setCareerRecords(records);
      })
      .catch((error) => {
        console.error("Unable to load career performance records:", error);
      });

    const unsubscribePlayers = subscribeToPlayers(
      setPlayers,
      (error) => console.error("Unable to load Firebase players:", error)
    );
    const unsubscribeTeams = subscribeToTeams(
      (teams) =>
        setSavedTeams((current) => {
          const merged = new Map(
            current.map((team) => [
              String(team.teamId || team.id),
              team,
            ])
          );

          teams.forEach((team) => {
            merged.set(
              String(team.teamId || team.id),
              {
                ...merged.get(String(team.teamId || team.id)),
                ...team,
              }
            );
          });

          return Array.from(merged.values());
        }),
      (error) => console.error("Unable to load Firebase teams:", error)
    );
    const unsubscribeTeamPlayers = subscribeToTeamPlayers(
      setSavedTeamPlayers,
      (error) => console.error("Unable to load Firebase team players:", error)
    );
    const unsubscribeMatches = subscribeToMatches(
      (nextMatches) => setMatches(
        nextMatches.sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        )
      ),
      (error) => console.error("Unable to load Firebase matches:", error)
    );

    return () => {
      cancelled = true;
      unsubscribePlayers();
      unsubscribeTeams();
      unsubscribeTeamPlayers();
      unsubscribeMatches();
    };
  }, []);

  useEffect(() => {
    if (!tournamentFixtureId || !matches.length || screen !== "list") return;

    const fixture = matches.find(
      (item) => String(item.id || item.matchId) === String(tournamentFixtureId)
    );
    if (!fixture || String(fixture.tournamentId) !== String(tournamentFilterId)) return;

    if (String(fixture.tournamentCreatedBy || fixture.createdBy) !== String(getCurrentUserId())) {
      alert("Only the tournament creator can start this match.");
      return;
    }
    if (fixture.status !== "scheduled") return;
    if (!fixture.teamAName || !fixture.teamBName) return;

    const playersA = fixture.teamAPlayers || fixture.teamA?.players || [];
    const playersB = fixture.teamBPlayers || fixture.teamB?.players || [];
    const captainA = playersA[0] || null;
    const captainB = playersB[0] || null;
    if (!captainA || !captainB) {
      alert("Both tournament teams need at least one player before the match can start.");
      return;
    }

    setTournamentContext({
      tournamentId: fixture.tournamentId,
      tournamentName: fixture.tournamentName,
      tournamentMatchType: fixture.tournamentMatchType,
      tournamentStage: fixture.tournamentStage,
      tournamentParentMatchId: fixture.tournamentParentMatchId,
      tournamentBaseMatchId: fixture.tournamentBaseMatchId,
      tournamentSuperOverNumber: fixture.tournamentSuperOverNumber,
      tournamentFixtureId: fixture.tournamentFixtureId || fixture.id,
      tournamentGroup: fixture.tournamentGroup || fixture.groupId,
      tournamentCreatedBy: fixture.tournamentCreatedBy || fixture.createdBy,
    });
    setTeamA({ id: "A", teamId: fixture.teamAId, name: fixture.teamAName, players: playersA });
    setTeamB({ id: "B", teamId: fixture.teamBId, name: fixture.teamBName, players: playersB });
    setCaptainA(null);
    setCaptainB(null);
    setMatchType("limited-overs");
    setDraftSelections([
      ...playersA.map((player) => ({ player, team: "A" })),
      ...playersB.map((player) => ({ player, team: "B" })),
    ]);
    setScreen("tournament-setup");
  }, [matches, screen, tournamentFilterId, tournamentFixtureId]);

  const continueTournamentSetup = () => {
    if (!tournamentContext || !teamA.players?.length || !teamB.players?.length) {
      alert("Tournament teams must have players before starting the match.");
      return;
    }
    if (!captainA || !captainB) {
      alert("Please select both team captains.");
      return;
    }
    if (String(captainA.id) === String(captainB.id)) {
      alert("Team captains must be different players.");
      return;
    }
    setDraftSelections([
      ...teamA.players.map((player) => ({ player, team: "A" })),
      ...teamB.players.map((player) => ({ player, team: "B" })),
    ]);
    setPlayerChoiceHistory([]);
    setSecondTossCaller(captainA);
    setSecondTossChoice(null);
    setSecondTossResult(null);
    setSecondTossWinner(null);
    setSecondTossSpinning(false);
    setScreen("second-toss");
  };

  // Keep an opened scorecard in sync with the existing match snapshot stream.
  // This is event-driven and does not add any polling or database reads.
  useEffect(() => {
    if (!viewingMatch) return;

    const latestMatch = matches.find(
      (match) => String(match.id) === String(viewingMatch.id)
    );

    if (latestMatch && latestMatch !== viewingMatch) {
      setViewingMatch(latestMatch);
      if (isFinalMatch(latestMatch)) {
        setScreen("view-scorecard");
      }
    }
  }, [matches, viewingMatch]);

  useEffect(() => {
    if (!viewingMatch?.id) {
      setPersistedDeliveries([]);
      setCommentaryLoading(false);
      return undefined;
    }

    setCommentaryLoading(true);
    const deliveriesQuery = query(
      collection(db, "deliveries"),
      where("matchId", "==", String(viewingMatch.id))
    );

    return onSnapshot(
      deliveriesQuery,
      async (snapshot) => {
        let records = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));

        // Older matches may have stored a numeric matchId (or a legacy key)
        // even though new delivery records use a string matchId.
        if (!records.length) {
          try {
            const legacySnapshot = await getDocs(collection(db, "deliveries"));
            records = legacySnapshot.docs
              .map((item) => ({ id: item.id, ...item.data() }))
              .filter((delivery) => [
                delivery.matchId,
                delivery.matchID,
                delivery.match_id,
              ].some((value) => String(value ?? "") === String(viewingMatch.id)));
          } catch (error) {
            console.error("Unable to load legacy match commentary:", error);
          }
        }

        setPersistedDeliveries(records);
        setCommentaryLoading(false);
      },
      (error) => {
        console.error("Unable to load saved match commentary:", error);
        setPersistedDeliveries([]);
        setCommentaryLoading(false);
      }
    );
  }, [viewingMatch?.id]);

  // Open a scorecard requested from the finished scoring screen after the
  // event-driven matches snapshot has loaded.
  useEffect(() => {
    if (!scorecardMatchId || !matches.length) return;

    const requestedMatch = matches.find(
      (match) =>
        String(match?.id ?? match?.matchId ?? "") ===
        String(scorecardMatchId)
    );

    if (!requestedMatch) return;

    setViewingMatch((current) =>
      String(current?.id ?? current?.matchId ?? "") ===
      String(scorecardMatchId)
        ? current
        : requestedMatch
    );
    setScreen("view-scorecard");
  }, [matches, scorecardMatchId]);


  // --------------------------------------------------
  // AUTO CHANGE LIVE -> UNFINISHED AFTER 7 days
  // --------------------------------------------------

  useEffect(() => {
    const checkMatches = () => {
      setMatches((currentMatches) => {
        let changed = false;

        const updated = currentMatches.map((match) => {
          if (
            match.status === "live" &&
            match.startedAt &&
            Date.now() - new Date(match.startedAt).getTime() >=
              7* 24 * 60 * 60 * 1000
          ) {
            changed = true;

            return {
              ...match,
              status: "unfinished",
              updatedAt: new Date().toISOString(),
            };
          }

          return match;
        });

        if (changed) {
          updated
            .filter((match) => match.status === "unfinished")
            .forEach((match) => saveMatch(match).catch(console.error));
        }

        return updated;
      });
    };

    checkMatches();

    const interval = setInterval(checkMatches, 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  // --------------------------------------------------
  // HELPERS
  // --------------------------------------------------

  const resetMatchCreation = () => {
    setTeamMode(null);

    setTeamA({
      ...emptyTeam,
      id: "A",
      name: "Team A",
    });

    setTeamB({
      ...emptyTeam,
      id: "B",
      name: "Team B",
    });

    setCaptainA(null);
    setCaptainB(null);

    setFirstTossCaller(null);
    setFirstTossChoice(null);
    setFirstTossResult(null);
    setFirstTossWinner(null);
    setFirstTossSpinning(false);

    setNextPickTeam(null);
    setDraftSelections([]);
    setPlayerChoiceHistory([]);

    setPlayerSearch("");

    setSecondTossCaller(null);
    setSecondTossChoice(null);
    setSecondTossResult(null);
    setSecondTossWinner(null);

    setBattingTeam(null);
    setBowlingTeam(null);
    setMatchOvers(5);
    setMatchType("limited-overs");
    setTestOvers(90);
    setTestDays(5);

    setScore({
      runs: 0,
      wickets: 0,
      balls: 0,
    });
  };

  const getPlayerName = (player) => {
    if (!player) return "";

    if (typeof player === "string") {
      return player;
    }

    return player.name || "Unknown Player";
  };

  const playerStrength = (player) => {
    if (!player) return 0;

    let strength = 50;

    if (player.type === "Batsman") strength += 12;
    if (player.type === "Bowler") strength += 12;
    if (player.type === "All-rounder") strength += 18;
    if (player.type === "Wicketkeeper") strength += 10;

    if (player.battingPosition === "Opener") strength += 4;
    if (player.battingPosition === "Middle order") strength += 3;
    if (player.battingPosition === "Finisher") strength += 5;

    if (player.bowlingStyle === "Full pacer") strength += 5;
    if (player.bowlingStyle === "Medium pacer") strength += 3;
    if (player.bowlingStyle === "Spinner") strength += 4;

    return strength;
  };

  const playerMatchStrength = (player) => {
    const playerId = String(
      player?.id ??
        player?.uid ??
        player?.playerId ??
        ""
    );

    if (!playerId) return 0;

    if (!careerRecords) return 0;
    return Number(getCareerPerformanceStats({
      playerIds: [playerId, player.name].filter(Boolean),
      ...careerRecords,
    }).playerStrength) || 0;
  };

  const teamStrength = (team) => {
    if (!team) return 0;

    const captain =
      String(team.id) === "B"
        ? captainB
        : captainA;
    const strengthPlayers = [
      captain,
      ...(Array.isArray(team.players)
        ? team.players
        : []),
    ].filter(Boolean);

    const uniquePlayers = Array.from(
      new Map(
        strengthPlayers.map((player) => [
          String(
            player.id ??
              player.uid ??
              player.playerId
          ),
          player,
        ])
      ).values()
    );

    if (!uniquePlayers.length) return 0;

    const total = uniquePlayers.reduce(
      (sum, player) => sum + playerMatchStrength(player),
      0
    );

    return Number(
      (total / uniquePlayers.length).toFixed(1)
    );
  };

  const strengthBarWidth = (team) => {
    const teamAValue = teamStrength(teamA);
    const teamBValue = teamStrength(teamB);
    const strongestTeam = Math.max(
      teamAValue,
      teamBValue
    );

    if (!strongestTeam) return 0;

    return (teamStrength(team) / strongestTeam) * 100;
  };

  const teamAHasPlayer = (id) =>
    teamA.players.some(
      (player) => String(player.id) === String(id)
    );

  const teamBHasPlayer = (id) =>
    teamB.players.some(
      (player) => String(player.id) === String(id)
    );

  const bothPlayer = useMemo(() => {
    const bothA = teamA.players.filter((a) =>
      teamB.players.some(
        (b) => String(a.id) === String(b.id)
      )
    );

    return bothA[0] || null;
  }, [teamA.players, teamB.players]);

  // --------------------------------------------------
  // SELECT CAPTAINS FIRST
  // --------------------------------------------------

  const chooseCaptainA = (playerId) => {
    const player = players.find(
      (p) => String(p.id) === String(playerId)
    );

    if (!player) {
      setCaptainA(null);
      return;
    }

    setCaptainA(player);
  };

  const chooseCaptainB = (playerId) => {
    const player = players.find(
      (p) => String(p.id) === String(playerId)
    );

    if (!player) {
      setCaptainB(null);
      return;
    }

    setCaptainB(player);
  };

  // FIX: explicit screen transition.
  const continueAfterCaptains = () => {
    if (!captainA || !captainB) {
      alert("Please select both captains.");
      return;
    }

    if (String(captainA.id) === String(captainB.id)) {
      alert("Team captains must be different players.");
      return;
    }

    const nextTeamA = {
      ...teamA,
      players: teamA.players.some(
        (player) => String(player.id) === String(captainA.id)
      )
        ? teamA.players
        : [captainA, ...teamA.players],
    };
    const nextTeamB = {
      ...teamB,
      players: teamB.players.some(
        (player) => String(player.id) === String(captainB.id)
      )
        ? teamB.players
        : [captainB, ...teamB.players],
    };

    setTeamA(nextTeamA);
    setTeamB(nextTeamB);
    setDraftSelections([
      { player: captainA, team: "A" },
      { player: captainB, team: "B" },
    ]);
    setPlayerChoiceHistory([]);

    setFirstTossCaller(
      Math.random() < 0.5 ? captainA : captainB
    );
    setFirstTossChoice(null);
    setFirstTossResult(null);
    setFirstTossWinner(null);
    setFirstTossSpinning(false);

    setScreen("first-toss");
  };

  // --------------------------------------------------
  // FIRST TOSS
  // --------------------------------------------------

  const chooseFirstToss = (choice) => {
    if (firstTossResult || firstTossChoice) return;

    const caller = firstTossCaller || captainA;
    const other =
      String(caller?.id) === String(captainA?.id) ? captainB : captainA;

    setFirstTossChoice(choice);
    setFirstTossSpinning(true);

    window.setTimeout(() => {
      const result = Math.random() < 0.5 ? "Heads" : "Tails";
      const winner = result === choice ? caller : other;

      setFirstTossResult(result);
      setFirstTossWinner(winner);
      setFirstTossSpinning(false);

      const winnerIsA =
        String(winner?.id) === String(captainA?.id);

      setNextPickTeam(winnerIsA ? "A" : "B");
    }, TOSS_FLIP_MS);
  };

  // --------------------------------------------------
  // PLAYER SELECTION
  // --------------------------------------------------

  const savePlayerChoiceSnapshot = () => {
    setPlayerChoiceHistory((prev) => [
      ...prev,
      {
        teamAPlayers: [...teamA.players],
        teamBPlayers: [...teamB.players],
        draftSelections: [...draftSelections],
        nextPickTeam,
      },
    ]);
  };

  const selectPlayer = (player, choice) => {
    if (!player || !choice) return;

    const id = String(player.id);

    const alreadySelected = draftSelections.some(
      (item) => String(item.player.id) === id
    );

    const alreadyInA = teamA.players.some((p) => String(p.id) === id);
    const alreadyInB = teamB.players.some((p) => String(p.id) === id);
    const isCaptain =
      String(captainA?.id) === id ||
      String(captainB?.id) === id;

    if (alreadySelected) return;
    if (isCaptain) return;
    if (choice === "A" && alreadyInB) return;
    if (choice === "B" && alreadyInA) return;
    if (choice === "BOTH" && (alreadyInA || alreadyInB)) return;

    // BOTH is allowed only once. It does not replace the normal A/B turn.
    if (choice === "BOTH") {
      const existingBoth = teamA.players.find((p) =>
        teamB.players.some((b) => String(b.id) === String(p.id))
      );

      if (existingBoth) {
        alert(
          `Only one player can play for BOTH teams.\n\n${getPlayerName(existingBoth)} is already selected for both teams.`
        );
        return;
      }

      savePlayerChoiceSnapshot();

      setTeamA((prev) => ({
        ...prev,
        players: prev.players.some((p) => String(p.id) === id)
          ? prev.players
          : [...prev.players, player],
      }));

      setTeamB((prev) => ({
        ...prev,
        players: prev.players.some((p) => String(p.id) === id)
          ? prev.players
          : [...prev.players, player],
      }));

      setDraftSelections((prev) => [
        ...prev,
        { player, team: "BOTH" },
      ]);

      return;
    }

    // A/B picks must follow the first-toss order.
    if (choice !== nextPickTeam) return;

    if (choice === "A") {
      savePlayerChoiceSnapshot();

      setTeamA((prev) => ({
        ...prev,
        players: prev.players.some((p) => String(p.id) === id)
          ? prev.players
          : [...prev.players, player],
      }));

      setDraftSelections((prev) => [
        ...prev,
        { player, team: "A" },
      ]);

      setNextPickTeam("B");
      return;
    }

    if (choice === "B") {
      savePlayerChoiceSnapshot();

      setTeamB((prev) => ({
        ...prev,
        players: prev.players.some((p) => String(p.id) === id)
          ? prev.players
          : [...prev.players, player],
      }));

      setDraftSelections((prev) => [
        ...prev,
        { player, team: "B" },
      ]);

      setNextPickTeam("A");
    }
  };

  const isBothPlayer = (player) => {
    if (!player) return false;
    const id = String(player.id);
    return (
      teamA.players.some((p) => String(p.id) === id) &&
      teamB.players.some((p) => String(p.id) === id)
    );
  };

  const isPlayerSelected = (player) => {
    if (!player) return false;
    const id = String(player.id);
    return draftSelections.some(
      (item) => String(item.player.id) === id
    );
  };

  const isTeamOptionBlocked = (player, option) => {
    if (!player) return true;

    const id = String(player.id);

    const inA = teamA.players.some((p) => String(p.id) === id);
    const inB = teamB.players.some((p) => String(p.id) === id);

    // Once assigned to one team, the player cannot be assigned to the opposite team.
    if (option === "A" && inB) return true;
    if (option === "B" && inA) return true;

    if (isPlayerSelected(player)) return true;

    if (option === "A" && nextPickTeam !== "A") return true;
    if (option === "B" && nextPickTeam !== "B") return true;

    if (option === "BOTH") {
      const currentBoth = teamA.players.find((p) =>
        teamB.players.some((b) => String(b.id) === String(p.id))
      );

      if (currentBoth && String(currentBoth.id) !== id) return true;
    }

    return false;
  };

  const removePlayerFromTeam = (playerId, team) => {
    const id = String(playerId);

    if (
      (team === "A" && String(captainA?.id) === id) ||
      (team === "B" && String(captainB?.id) === id)
    ) {
      alert("A captain must remain in their own team.");
      return;
    }

    savePlayerChoiceSnapshot();

    const playerWasBoth =
      teamA.players.some((p) => String(p.id) === id) &&
      teamB.players.some((p) => String(p.id) === id);

    if (team === "A") {
      setTeamA((prev) => ({
        ...prev,
        players: prev.players.filter((p) => String(p.id) !== id),
      }));
    }

    if (team === "B") {
      setTeamB((prev) => ({
        ...prev,
        players: prev.players.filter((p) => String(p.id) !== id),
      }));
    }

    // A BOTH player is removed from BOTH sides and becomes available again.
    if (playerWasBoth) {
      setTeamA((prev) => ({
        ...prev,
        players: prev.players.filter((p) => String(p.id) !== id),
      }));
      setTeamB((prev) => ({
        ...prev,
        players: prev.players.filter((p) => String(p.id) !== id),
      }));
    }

    setDraftSelections((prev) => {
      const next = prev.filter((item) => String(item.player.id) !== id);
      const aCount = next.filter((item) => item.team === "A").length;
      const bCount = next.filter((item) => item.team === "B").length;
      const winnerIsA =
        String(firstTossWinner?.id) === String(captainA?.id);

      if (winnerIsA) {
        setNextPickTeam(aCount <= bCount ? "A" : "B");
      } else {
        setNextPickTeam(bCount <= aCount ? "B" : "A");
      }

      return next;
    });
  };

  const undoPlayerChoice = () => {
    const previous = playerChoiceHistory[playerChoiceHistory.length - 1];

    if (!previous) return;

    setTeamA((current) => ({
      ...current,
      players: previous.teamAPlayers,
    }));
    setTeamB((current) => ({
      ...current,
      players: previous.teamBPlayers,
    }));
    setDraftSelections(previous.draftSelections);
    setNextPickTeam(previous.nextPickTeam);
    setPlayerChoiceHistory((history) => history.slice(0, -1));
  };

  // --------------------------------------------------
  // AI TEAM BALANCE
  // --------------------------------------------------

  const [skippedAiPlayerIds, setSkippedAiPlayerIds] = useState([]);

  useEffect(() => {
    setSkippedAiPlayerIds([]);
  }, [nextPickTeam, draftSelections]);

  const aiSuggestion = useMemo(() => {
    if (!nextPickTeam) return null;

    const available = players.filter((player) => {
      const id = String(player.id);
      return !draftSelections.some(
        (item) => String(item.player.id) === id
      );
    });

    if (!available.length) return null;

    const strengthA = teamStrength(teamA);
    const strengthB = teamStrength(teamB);

    const candidates = available
      .filter((player) => {
        const id = String(player.id);
        return nextPickTeam === "A"
          ? !teamA.players.some((p) => String(p.id) === id)
          : !teamB.players.some((p) => String(p.id) === id);
      })
      .filter((player) => !skippedAiPlayerIds.includes(String(player.id)))
      .sort(
        (a, b) =>
          playerMatchStrength(b) - playerMatchStrength(a)
      );

    const candidate = candidates[0];
    if (!candidate) return null;

    return {
      team: nextPickTeam,
      player: candidate,
      strengthA,
      strengthB,
    };
  }, [
    players,
    teamA.players,
    teamB.players,
    nextPickTeam,
    draftSelections,
    careerRecords,
    skippedAiPlayerIds,
  ]);

  const skipAiSuggestion = () => {
    if (!aiSuggestion) return;
    setSkippedAiPlayerIds((previous) => [
      ...previous,
      String(aiSuggestion.player.id),
    ]);
  };

  // --------------------------------------------------
  // CONFIRM TEAMS
  // --------------------------------------------------

  const confirmTeams = async () => {
    if (!teamA.name.trim() || !teamB.name.trim()) {
      alert("Please enter both team names.");
      return;
    }

    if (String(teamA.name).trim().toLowerCase() === String(teamB.name).trim().toLowerCase()) {
      alert("Team A and Team B must have different names.");
      return;
    }

    if (!captainA || !captainB) {
      alert("Please select both captains.");
      return;
    }

    if (String(captainA.id) === String(captainB.id)) {
      alert("Captains must be different players.");
      return;
    }

    if (!teamA.players.length || !teamB.players.length) {
      alert("Both teams must have at least one player.");
      return;
    }

    // Captains are always included in their own teams.
    const uniquePlayers = (items) =>
      Array.from(
        new Map(
          items.map((player) => [
            String(player.id || player.uid || player.playerId),
            player,
          ])
        ).values()
      );

    const nextA = {
      ...teamA,
      players: uniquePlayers(
        teamA.players.some((p) => String(p.id) === String(captainA.id))
          ? teamA.players
          : [...teamA.players, captainA]
      ),
    };

    const nextB = {
      ...teamB,
      players: uniquePlayers(
        teamB.players.some((p) => String(p.id) === String(captainB.id))
          ? teamB.players
          : [...teamB.players, captainB]
      ),
    };

    setTeamA(nextA);
    setTeamB(nextB);

    // Persist reusable teams for the Use Existing Team flow.
    try {
      const current = Array.isArray(savedTeams) ? savedTeams : [];
      const now = new Date().toISOString();

      const makeSavedTeam = (team, captain) => {
        const existingTeamId =
          team.teamId && !["A", "B"].includes(String(team.teamId))
            ? String(team.teamId)
            : team.id && !["A", "B"].includes(String(team.id))
              ? String(team.id)
              : null;

        const savedId =
          existingTeamId ||
          `team-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        return {
          id: savedId,
          teamId: savedId,
          name: team.name.trim(),
          captain,
          players: team.players,
          updatedAt: now,
        };
      };

      // IMPORTANT: only save the two teams created/updated in this operation.
      // Never re-save every existing team here. Firestore team documents loaded
      // from the database contain playerIds/teamPlayers, not necessarily the
      // full `players` array. Re-saving those old teams with an empty players
      // array could overwrite their playerIds with [].
      const savedTeamA = makeSavedTeam(nextA, captainA);
      const savedTeamB = makeSavedTeam(nextB, captainB);
      const teamsToSave = [savedTeamA, savedTeamB];

      await Promise.all(teamsToSave.map((team) => saveTeam(team)));

      setSavedTeams((current) => {
        const merged = new Map(
          current.map((team) => [
            String(team.teamId || team.id),
            team,
          ])
        );

        teamsToSave.forEach((team) => {
          merged.set(
            String(team.teamId || team.id),
            team
          );
        });

        return Array.from(merged.values());
      });
    } catch (error) {
      alert(error.message || "Unable to save teams to Firebase.");
      return;
    }

    // Captain A is explicitly shown as the final toss caller in the existing UI.
    // Keep that caller deterministic so the Heads/Tails result matches the visible flow.
    setSecondTossCaller(captainA);
    setSecondTossChoice(null);
    setSecondTossResult(null);
    setSecondTossWinner(null);
    setSecondTossSpinning(false);
    setScreen("second-toss");
  };

  // --------------------------------------------------
  // SECOND TOSS
  // --------------------------------------------------

  const chooseSecondToss = (choice) => {
    if (secondTossResult || secondTossChoice) return;

    const caller = secondTossCaller || captainA;
    const other =
      String(caller?.id) === String(captainA?.id) ? captainB : captainA;

    setSecondTossChoice(choice);
    setSecondTossSpinning(true);

    window.setTimeout(() => {
      const result = Math.random() < 0.5 ? "Heads" : "Tails";

      setSecondTossResult(result);
      setSecondTossSpinning(false);

      if (result === choice) {
        setSecondTossWinner(caller);
      } else {
        setSecondTossWinner(other);
      }
    }, TOSS_FLIP_MS);
  };

  // --------------------------------------------------
  // BAT / BOWL
  // --------------------------------------------------

  const getTossTeams = () => {
    if (!secondTossWinner) return null;

    const winnerIsA =
      String(secondTossWinner.id) ===
      String(captainA.id);

    return {
      winnerTeam: winnerIsA ? teamA : teamB,
      otherTeam: winnerIsA ? teamB : teamA,
    };
  };

  const chooseBat = () => {
    const tossTeams = getTossTeams();
    if (!tossTeams) return;

    const { winnerTeam, otherTeam } = tossTeams;

    setBattingTeam(winnerTeam);
    setBowlingTeam(otherTeam);

    startLiveMatch(winnerTeam, otherTeam);
  };

  const chooseBowl = () => {
    const tossTeams = getTossTeams();
    if (!tossTeams) return;

    const { winnerTeam, otherTeam } = tossTeams;

    setBattingTeam(otherTeam);
    setBowlingTeam(winnerTeam);

    startLiveMatch(otherTeam, winnerTeam);
  };

  // --------------------------------------------------
  // START MATCH
  // --------------------------------------------------

  const startLiveMatch = async (batting, bowling) => {
    const now = new Date().toISOString();
    const id = tournamentContext?.tournamentFixtureId || Date.now();

    const battingTeamId =
      String(batting?.id) === "B" || batting === teamB ? "B" : "A";
    const bowlingTeamId = battingTeamId === "A" ? "B" : "A";

    const newMatch = {
      id,
      teamA: {
        id: "A",
        name: teamA.name.trim(),
        captain: captainA,
        players: teamA.players,
      },
      teamB: {
        id: "B",
        name: teamB.name.trim(),
        captain: captainB,
        players: teamB.players,
      },
      teamAPlayers: teamA.players,
      teamBPlayers: teamB.players,
      teamAName: teamA.name.trim(),
      teamBName: teamB.name.trim(),
      captainA,
      captainB,
      firstTossChoice,
      firstTossResult,
      firstTossWinner,
      secondTossChoice,
      secondTossResult,
      secondTossWinner,
      battingTeamId,
      bowlingTeamId,
      battingTeam: batting.name,
      bowlingTeam: bowling.name,
      overs: matchType === "test" ? null : Number(matchOvers),
      matchType,
      testOvers: matchType === "test"
        ? Math.min(90, Math.max(3, Number(testOvers) || 90))
        : null,
      oversPerDay: matchType === "test"
        ? Math.min(90, Math.max(3, Number(testOvers) || 90))
        : null,
      testDays: matchType === "test" ? 5 : null,
      maxDays: matchType === "test" ? 5 : null,
      currentDay: matchType === "test" ? 1 : null,
      testInnings: [],
      innings: [],
      inningsOrder: matchType === "test"
        ? [battingTeamId, bowlingTeamId, battingTeamId, bowlingTeamId]
        : null,
      currentInnings: 0,
      followOnAvailable: false,
      followOnEnforced: false,
      declaredInnings: [],
      drawState: matchType === "test" ? "possible" : null,
      scoreA: 0,
      wicketsA: 0,
      scoreB: 0,
      wicketsB: 0,
      status: "live",
      ...(tournamentContext || {}),
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      winner: null,
    };

    try {
      const savedMatch = await saveMatch(newMatch);
      setMatches((current) => [savedMatch, ...current.filter((item) => String(item.id) !== String(id))]);
    } catch (error) {
      alert(error.message || "Unable to save match to Firebase.");
      return;
    }

    // Scoring is handled by the dedicated Scoring page.
    navigate(matchType === "test" ? `/test-scoring/${id}` : `/scoring/${id}`);
  };

  // --------------------------------------------------
  // FINISH MATCH
  // --------------------------------------------------

  const finishMatch = async (winnerName = null) => {
    const latestMatch = matches[0];

    if (!latestMatch) return;

    const finishedAt = new Date().toISOString();
    const updatedMatches = matches.map(
      (match, index) => {
        if (index !== 0) return match;

        const savedMatch = {
          ...match,
          status: "finished",
          winner: winnerName,
          finishedAt,
          updatedAt: finishedAt,
        };

        saveMatch(savedMatch).catch(console.error);

        return savedMatch;
      }
    );

    setMatches(updatedMatches);

    setScreen("list");
  };

  // --------------------------------------------------
  // DATE FORMAT
  // --------------------------------------------------

  const formatDate = (date) =>
    new Date(date).toLocaleDateString(
      "en-IN",
      {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }
    );

  const formatTime = (date) =>
    new Date(date).toLocaleTimeString(
      "en-IN",
      {
        hour: "2-digit",
        minute: "2-digit",
      }
    );

  const getMatchStatus = (match) => {
    if (!match) return "live";
    const status = String(match.status || "").trim().toLowerCase();
    if (isFinalMatch(match)) return "finished";
    if (status === "unfinished") return "unfinished";
    if (status === "scheduled" || status === "upcoming") return "scheduled";
    return "live";
  };

  const getMatchResultText = (match) => {
    if (!match) return "";

    const savedText = typeof match.result === "string"
      ? match.result
      : match.result?.text ||
        match.result?.resultText ||
        match.resultText ||
        match.scoringState?.result?.text;
    if (String(savedText || "").trim()) return String(savedText).trim();

    const winner =
      match.result?.winner ??
      match.scoringState?.result?.winner ??
      match.winner ??
      match.winnerName;
    const winnerText = typeof winner === "object"
      ? winner?.name || winner?.teamName || winner?.label || ""
      : String(winner ?? "").trim();
    const winnerKey = winnerText.toLowerCase();
    if (
      winnerKey === "draw" ||
      winnerKey === "tied" ||
      winnerKey === "tie" ||
      String(match.drawState || "").trim().toLowerCase() === "draw"
    ) {
      return "Match drawn";
    }
    if (winnerText) {
      const teamAId = String(match.teamAId ?? match.teamA?.id ?? "A");
      const teamBId = String(match.teamBId ?? match.teamB?.id ?? "B");
      if (
        winnerKey === "a" ||
        winnerKey === teamAId.toLowerCase() ||
        winnerKey === String(match.teamA?.name || match.teamAName || "").toLowerCase()
      ) {
        return `${match.teamA?.name || match.teamAName || "Team A"} won`;
      }
      if (
        winnerKey === "b" ||
        winnerKey === teamBId.toLowerCase() ||
        winnerKey === String(match.teamB?.name || match.teamBName || "").toLowerCase()
      ) {
        return `${match.teamB?.name || match.teamBName || "Team B"} won`;
      }
      return `${winnerText} won`;
    }

    const winnerId =
      match.result?.winnerId ??
      match.scoringState?.result?.winnerId ??
      match.winnerId;
    if (winnerId != null) {
      if (String(winnerId) === String(match.teamAId ?? match.teamA?.id ?? "A")) {
        return `${match.teamA?.name || match.teamAName || "Team A"} won`;
      }
      if (String(winnerId) === String(match.teamBId ?? match.teamB?.id ?? "B")) {
        return `${match.teamB?.name || match.teamBName || "Team B"} won`;
      }
    }

    return isFinalMatch(match) ? "Match finished" : "";
  };

  const sortedMatches = [...matches].sort(
    (a, b) =>
      new Date(b.createdAt) -
      new Date(a.createdAt)
  );

  const visibleMatches = tournamentFilterId
    ? sortedMatches
        .filter(
          (match) => String(match.tournamentId) === String(tournamentFilterId)
        )
        .sort((a, b) => {
          const order = (match) => {
            const type = String(match.tournamentMatchType || "")
              .trim()
              .toLowerCase()
              .replace(/[_\s]+/g, "-");
            const isSuperOver = type.includes("super-over");
            const isFinal = type === "final" || (isSuperOver && type.startsWith("final-"));
            const isSemiFinal = type === "semi-final" || type === "semifinal" || type.startsWith("semi-");
            const semiNumber = Number(
              String(
                match.tournamentBaseMatchId ||
                match.tournamentParentMatchId ||
                match.id ||
                ""
              ).match(/-semi-(\d+)(?:-|$)/i)?.[1] || 0
            );
            const superOverNumber = Number(match.tournamentSuperOverNumber || 0);

            if (isFinal) return [0, isSuperOver ? 1 : 0, isSuperOver ? -superOverNumber : 0];
            if (isSemiFinal) {
              return [
                1,
                -semiNumber,
                isSuperOver ? 1 : 0,
                isSuperOver ? -superOverNumber : 0,
              ];
            }
            if (type === "league") return [2, 0, 0, 0];
            return [3, 0, 0, 0];
          };
          const left = order(a);
          const right = order(b);
          for (let index = 0; index < left.length; index += 1) {
            if (left[index] !== right[index]) return left[index] - right[index];
          }
          return new Date(b.createdAt) - new Date(a.createdAt);
        })
    : sortedMatches;

  const displayMatches = visibleMatches.map((match) =>
    getMatchStatus(match) === "live"
      ? buildLiveScorecardSnapshot(match)
      : match
  );

  // --------------------------------------------------
  // DELETE ONLY THE SELECTED MATCH (ADMIN)
  // --------------------------------------------------

  const handleDeleteMatch = async (match) => {
    if (!isAdmin) {
      alert("Only the admin can delete matches.");
      return;
    }

    // Lock onto the exact match whose button was clicked.
    const rawMatchId = match?.id ?? match?.matchId;
    const matchId = String(rawMatchId ?? "").trim();

    if (!matchId) {
      alert("Unable to delete: this match has no valid id.");
      return;
    }

    if (deletingMatchId) return;

    const matchLabel = `${
      match?.teamA?.name || match?.teamAName || "Team A"
    } vs ${
      match?.teamB?.name || match?.teamBName || "Team B"
    }`;

    if (
      !window.confirm(
        `Delete "${matchLabel}" and all its related score data?`
      )
    ) {
      return;
    }

    setDeletingMatchId(matchId);

    try {
      await deleteMatchCascade(rawMatchId);

      // Remove ONLY the deleted match from the list.
      setMatches((current) =>
        current.filter(
          (item) =>
            String(item?.id ?? item?.matchId ?? "") !== matchId
        )
      );

      setViewingMatch((current) =>
        current && String(current.id ?? current.matchId ?? "") === matchId
          ? null
          : current
      );
    } catch (error) {
      console.error("Unable to delete match:", matchId, error);
      alert(error?.message || "Unable to delete match.");
    } finally {
      setDeletingMatchId(null);
    }
  };

  // --------------------------------------------------
  // DARK MODE / FORM CONTROL FIX
  // --------------------------------------------------

  // --------------------------------------------------
  // MATCH LIST
  // --------------------------------------------------

  if (screen === "list") {
    return (
      <>
        <div className="page matches-page">
          <div className="matches-header">
            <div>
              <p className="eyebrow">CRICKET MATCHES</p>
              <h2>Matches</h2>
              <p className="subtitle">
                Manage live, unfinished and finished matches.
              </p>
            </div>

            <button
              type="button"
              className="primary-button"
              onClick={() => {
                resetMatchCreation();
                setScreen("team-mode");
              }}
            >
              ＋ Start Match
            </button>
          </div>

          {visibleMatches.length === 0 ? (
            <div className="empty-card matches-empty">
              <div className="empty-icon">🏏</div>

              <h3>No matches yet</h3>

              <p>
                Start your first local cricket match.
              </p>

              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  resetMatchCreation();
                  setScreen("team-mode");
                }}
              >
                Start Match
              </button>
            </div>
          ) : (
            <div className="matches-list">
              {displayMatches.map((match) => (
                <div
                  className="match-date-group"
                  key={match.id}
                >
                  <div className="match-date">
                    {formatDate(match.createdAt)}
                  </div>

                  <div className="match-card">
                    <div className="match-card-top">
                      <div className="match-card-heading">
                        <div className="match-card-competition">
                          <span className="match-card-competition-icon" aria-hidden="true">
                            {match.tournamentId ? "🏆" : "🏏"}
                          </span>
                          <strong>{match.tournamentId ? match.tournamentName : "Friendly Match"}</strong>
                        </div>
                        {match.tournamentId && (
                          <span className="tournament-match-stage">
                            {tournamentMatchLabel(match)}
                          </span>
                        )}
                      </div>
                      <div className="match-card-meta">
                        <span className="match-format-badge">
                          {String(match.matchType || "limited-overs").toLowerCase() === "test"
                            ? "TEST MATCH"
                            : "LIMITED OVERS"}
                        </span>
                        {getMatchStatus(match) === "live" && (
                          <span className="live-badge">
                            <span className="live-dot"></span>
                            LIVE
                          </span>
                        )}

                        {getMatchStatus(match) === "unfinished" && (
                          <span className="unfinished-badge">
                            UNFINISHED
                          </span>
                        )}

                        {getMatchStatus(match) === "finished" && (
                          <span className="finished-badge">
                            FINISHED
                          </span>
                        )}

                        <span className="match-time">
                          {formatTime(match.createdAt)}
                        </span>
                      </div>
                    </div>

                    {isTestMatchRecord(match) ? (() => {
                      const playedInnings = scorecardHistoryInnings({
                        match,
                        scoringState: match.scoringState || {},
                      }).filter(Boolean);
                      const renderTeam = (team, teamId) => (
                        <div className="match-team test-match-team">
                          <strong>{team?.name || match[teamId === "A" ? "teamAName" : "teamBName"] || "TBD"}</strong>
                          <div className="test-team-innings">
                            {testTeamInnings(playedInnings, teamId).map((innings, teamInningsIndex) => (
                              <span key={`${teamId}-${innings.inningsIndex}`}>
                                {testInningsDisplayLabel(
                                  innings,
                                  teamInningsIndex,
                                  match
                                )}
                              </span>
                            ))}
                            {!testTeamInnings(playedInnings, teamId).length && (
                              <span>0/0</span>
                            )}
                          </div>
                        </div>
                      );

                      return (
                        <div className="teams-display test-teams-display">
                          {renderTeam(match.teamA, "A")}
                          <div className="vs">VS</div>
                          {renderTeam(match.teamB, "B")}
                        </div>
                      );
                    })() : (
                      <div className="teams-display">
                        <div className="match-team">
                          <strong>{match.teamA?.name || match.teamAName || "TBD"}</strong>
                          <span>
                            {match.scoreA || 0}/
                            {match.wicketsA || 0}
                          </span>
                        </div>

                        <div className="vs">VS</div>

                        <div className="match-team">
                          <strong>{match.teamB?.name || match.teamBName || "TBD"}</strong>
                          <span>
                            {match.scoreB || 0}/
                            {match.wicketsB || 0}
                          </span>
                        </div>
                      </div>
                    )}

                    {isTestMatchRecord(match) && (() => {
                      const playedInnings = scorecardHistoryInnings({
                        match,
                        scoringState: match.scoringState || {},
                      }).filter(Boolean);
                      const totalOvers = playedInnings.reduce(
                        (total, innings) => total + testCompletedOvers(innings.balls),
                        0
                      );
                      const totals = playedInnings.reduce(
                        (result, innings) => {
                          result[innings.teamId] += Number(innings.runs || 0);
                          return result;
                        },
                        { A: 0, B: 0 }
                      );
                      const teamAName =
                        match.teamA?.name || match.teamAName || "Team A";
                      const teamBName =
                        match.teamB?.name || match.teamBName || "Team B";
                      const leadText = totals.A === totals.B
                        ? "Scores level"
                        : totals.A > totals.B
                          ? `${teamAName} lead by ${totals.A - totals.B}`
                          : `${teamBName} lead by ${totals.B - totals.A}`;
                      const displayDay = testDisplayDay({
                        match,
                        innings: playedInnings,
                        scoringState: match.scoringState || {},
                      });

                      return (
                        <div className="test-mini-scorecard">
                          <span>
                            Overs: {totalOvers} • Day {displayDay} / {Number(match.maxDays || match.testDays || 5)}
                          </span>
                          <span>{leadText}</span>
                          <div className="test-mini-innings">
                            {playedInnings.map((innings, index) => (
                              <span key={`${innings.teamId}-${innings.inningsIndex ?? index}`}>
                                {innings.teamName} — {testInningsDisplayLabel(innings, index, match)}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {getMatchStatus(match) === "finished" && (
                        <div className="winner-text">
                          {getMatchResultText(match).toLowerCase().includes("draw") ||
                          getMatchResultText(match).toLowerCase().includes("tie")
                            ? "🤝"
                            : "🏆"}{" "}
                          {getMatchResultText(match)}
                        </div>
                      )}

                    {getMatchStatus(match) === "unfinished" && (
                      <div className="unfinished-text">
                        Match was automatically marked
                        unfinished after 7 days.
                      </div>
                    )}

                    <div className="match-card-actions">
                      {match.tournamentId &&
                        getMatchStatus(match) === "scheduled" &&
                        String(match.tournamentCreatedBy || match.createdBy) === String(getCurrentUserId()) && (
                          <button
                            type="button"
                            className="primary-button full-button"
                            onClick={() => navigate(`/matches?tournamentId=${match.tournamentId}&fixtureId=${match.id}`)}
                          >
                            START THIS MATCH
                          </button>
                        )}
                      {(getMatchStatus(match) === "live" || getMatchStatus(match) === "unfinished") &&
                        (!match.createdBy || String(match.createdBy) === String(getCurrentUserId())) ? (
                        <button
                          type="button"
                          className="primary-button full-button"
                          onClick={() => navigate(`/scoring/${match.id}`)}
                        >
                          ▶ Resume Scoring
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className="secondary-button full-button"
                        disabled={getMatchStatus(match) === "scheduled"}
                        onClick={() => {
                          setViewingMatch(match);
                          setScreen("view-scorecard");
                        }}
                      >
                        View Scorecard
                      </button>

                      {isAdmin && (
                        <button
                          type="button"
                          className="danger-button full-button "
                          disabled={Boolean(deletingMatchId)}
                          onClick={() => handleDeleteMatch(match)}
                        >
                          {String(deletingMatchId) === String(match.id ?? match.matchId)
                            ? "Deleting..."
                            : "Delete Match"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    );
  }

  if (screen === "tournament-setup") {
    return (
      <div className="page matches-page">
        <div className="setup-modal-backdrop tournament-match-setup-backdrop">
          <div className="setup-card tournament-start-modal">
            <div className="setup-header">
              <p className="eyebrow">TOURNAMENT MATCH SETUP</p>
              <h2>{tournamentContext?.tournamentName || "Tournament Match"}</h2>
              <p className="subtitle">Choose overs and one captain from each team.</p>
            </div>
            <label htmlFor="tournament-match-overs">Overs to be played</label>
            <select
              id="tournament-match-overs"
              value={matchOvers}
              onChange={(event) => setMatchOvers(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20].map((overs) => (
                <option key={overs} value={overs}>{overs} Overs</option>
              ))}
            </select>
            <div className="captain-grid">
              <label>
                {teamA.name} Captain
                <select value={captainA?.id || ""} onChange={(event) => setCaptainA(teamA.players.find((player) => String(player.id) === String(event.target.value)) || null)}>
                  <option value="">Select captain</option>
                  {teamA.players.map((player) => <option key={player.id} value={player.id}>{getPlayerName(player)}</option>)}
                </select>
              </label>
              <label>
                {teamB.name} Captain
                <select value={captainB?.id || ""} onChange={(event) => setCaptainB(teamB.players.find((player) => String(player.id) === String(event.target.value)) || null)}>
                  <option value="">Select captain</option>
                  {teamB.players.map((player) => <option key={player.id} value={player.id}>{getPlayerName(player)}</option>)}
                </select>
              </label>
            </div>
            <button type="button" className="primary-button full-button" onClick={continueTournamentSetup}>Continue to Toss</button>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------
  // TEAM MODE
  // --------------------------------------------------

  if (screen === "team-mode") {
    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => setScreen("list")}
          >
            ← Back
          </button>

          <div className="setup-header">
            <p className="eyebrow">MATCH SETUP</p>

            <h2>Choose Teams</h2>

            <p className="subtitle">
              How do you want to create the teams?
            </p>
          </div>

           <div className="setup-card match-type-card">
            <label htmlFor="match-type">Match type</label>
            <select
              id="match-type"
              value={matchType}
              onChange={(e) => setMatchType(e.target.value)}
            >
              <option value="limited-overs">Limited overs</option>
              <option value="test">Test match</option>
            </select>
            {matchType === "test" && (
              <p className="subtitle">Four innings • no free hits • draw and follow-on tracking enabled.</p>
            )}
          </div>
       

          <div className="team-mode-grid">
            <button
              type="button"
              className="mode-card"
              onClick={() => {
                setTeamMode("create");
                setScreen("team-names");
              }}
            >
              <span className="mode-icon">👥</span>

              <h3>Create Team</h3>

              <p>
                Enter team names, choose captains, then build balanced teams.
              </p>
            </button>

            <button
              type="button"
              className="mode-card"
              onClick={() => {
                if (!savedTeams.length) {
                  alert(
                    "No existing teams found. Please create teams first."
                  );
                  return;
                }

                setTeamMode("existing");
                setScreen("existing-teams");
              }}
            >
              <span className="mode-icon">📋</span>

              <h3>Use Existing Team</h3>

              <p>
                Select two teams already created.
              </p>
            </button>
          </div>
          </div>
      </>
    );
  }

  // --------------------------------------------------
  // TEAM NAMES FIRST
  // --------------------------------------------------

  if (screen === "team-names") {
    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => setScreen("team-mode")}
          >
            ← Back
          </button>

          <div className="setup-header">
            <p className="eyebrow">STEP 1</p>
            <h2>Name Your Teams</h2>
            <p className="subtitle">Enter both team names first.</p>
          </div>

          <div className="team-name-grid">
            <div className="setup-card">
              <label>Team A Name</label>
              <input
                value={teamA.name}
                onChange={(e) =>
                  setTeamA((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="Enter Team A name"
              />
            </div>

            <div className="setup-card">
              <label>Team B Name</label>
              <input
                value={teamB.name}
                onChange={(e) =>
                  setTeamB((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="Enter Team B name"
              />
            </div>
          </div>

          {matchType !== "test" && <div className="setup-card">
            <label>Match Overs</label>
            <select
              value={matchOvers}
              onChange={(e) => setMatchOvers(e.target.value)}
            >
              <option value="1">1 Over</option>
              <option value="2">2 Overs</option>
              <option value="3">3 Overs</option>
              <option value="4">4 Overs</option>
              <option value="5">5 Overs</option>
              <option value="6">6 Overs</option>
              <option value="7">7 Overs</option>
              <option value="8">8 Overs</option>
              <option value="9">9 Overs</option>
              <option value="10">10 Overs</option>
              <option value="12">12 Overs</option>
              <option value="15">15 Overs</option>
              <option value="20">20 Overs</option>
            </select>
          </div>}
          {matchType === "test" && (
            <div className="setup-card">
              <label>Overs per day</label>
              <input type="number" min="3" max="90" value={testOvers} onChange={(e) => setTestOvers(e.target.value)} />
            </div>
          )}

          <button
            type="button"
            className="primary-button full-button"
            onClick={() => {
              if (!teamA.name.trim() || !teamB.name.trim()) {
                alert("Please enter both team names.");
                return;
              }
              if (teamA.name.trim().toLowerCase() === teamB.name.trim().toLowerCase()) {
                alert("Team names must be different.");
                return;
              }
              if (
                matchType === "test" &&
                (!Number.isInteger(Number(testOvers)) ||
                  Number(testOvers) < 3 ||
                  Number(testOvers) > 90)
              ) {
                alert("Overs per day for Test matches must be between 3 and 90.");
                return;
              }
              setScreen("captains");
            }}
          >
            Continue to Captains →
          </button>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // CAPTAINS FIRST
  // --------------------------------------------------

  if (screen === "captains") {
    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => setScreen("team-mode")}
          >
            ← Back
          </button>

          <div className="setup-header">
            <p className="eyebrow">STEP 2</p>

            <h2>Choose Captains</h2>

            <p className="subtitle">
              Select one captain for each team before the first toss.
            </p>
          </div>
{/* here remove the captain 1 , captain 2 and in placee of 1 ,2 put team name each */}
          <div className="captain-grid">
            <div className="setup-card">
              <h3>{teamA.name}</h3>

              <select
                value={captainA?.id || ""}
                onChange={(e) =>
                  chooseCaptainA(e.target.value)
                }
              >
                <option value="">
                  Select captain for {teamA.name}
                </option>

                {players.map((player) => (
                  <option
                    key={player.id}
                    value={player.id}
                    disabled={
                      captainB?.id != null &&
                      String(captainB.id) ===
                        String(player.id)
                    }
                  >
                    {getPlayerName(player)}
                  </option>
                ))}
              </select>

              {captainA && (
                <div className="selected-captain">
                  👤 {getPlayerName(captainA)}
                </div>
              )}
            </div>

            <div className="setup-card">
              <h3>{teamB.name}</h3>

              <select
                value={captainB?.id || ""}
                onChange={(e) =>
                  chooseCaptainB(e.target.value)
                }
              >
                <option value="">
                  Select captain for {teamB.name}
                </option>

                {players.map((player) => (
                  <option
                    key={player.id}
                    value={player.id}
                    disabled={
                      captainA?.id != null &&
                      String(captainA.id) ===
                        String(player.id)
                    }
                  >
                    {getPlayerName(player)}
                  </option>
                ))}
              </select>

              {captainB && (
                <div className="selected-captain">
                  👤 {getPlayerName(captainB)}
                </div>
              )}
            </div>
          </div>

          {/* FIXED NAVIGATION BUTTON */}
          <button
            type="button"
            className="primary-button full-button"
            onClick={continueAfterCaptains}
          >
            Continue to Toss →
          </button>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // FIRST TOSS
  // --------------------------------------------------

  if (screen === "first-toss") {
    return (
      <>
        <div className="page matches-page">
          <div className="setup-header">
            <p className="eyebrow">STEP 2</p>

            <h2>First Toss</h2>

            <p className="subtitle">
              {getPlayerName(captainA)} chooses first.
            </p>
          </div>

          <div className="toss-card">
            <div className="toss-captains">
              <div>
                <span>Captain 1</span>
                <strong>
                  {getPlayerName(captainA)}
                </strong>
              </div>

              <div className="toss-vs">VS</div>

              <div>
                <span>Captain 2</span>
                <strong>
                  {getPlayerName(captainB)}
                </strong>
              </div>
            </div>

            {!firstTossResult && (
              <>
                <h3>
                  {getPlayerName(firstTossCaller || captainA)}, choose your side
                </h3>

                {!firstTossChoice && (
                  <div className="toss-buttons">
                    <button
                      type="button"
                      className="toss-choice"
                      onClick={() =>
                        chooseFirstToss("Heads")
                      }
                    >
                      🪙
                      <span>Heads</span>
                    </button>

                    <button
                      type="button"
                      className="toss-choice"
                      onClick={() =>
                        chooseFirstToss("Tails")
                      }
                    >
                      🪙
                      <span>Tails</span>
                    </button>
                  </div>
                )}
              </>
            )}

            {firstTossChoice && !firstTossResult && (
              <CoinFlip spinning={firstTossSpinning} />
            )}

            {firstTossResult && (
              <div className="toss-result">
                <CoinFlip result={firstTossResult} spinning={firstTossSpinning} />

                <p>Toss result</p>

                <h2>{firstTossResult}</h2>

                <div className="toss-winner">
                  🏆 {getPlayerName(firstTossWinner)} won
                  the toss
                </div>

                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    if (!firstTossWinner || !nextPickTeam) return;
                    setScreen("player-selection");
                  }}
                >
                  Select Player→
                </button>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // PLAYER SELECTION
  // --------------------------------------------------

  if (screen === "player-selection") {
    const filteredPlayers = players.filter((player) =>
      getPlayerName(player)
        .toLowerCase()
        .includes(playerSearch.toLowerCase())
    );

    const currentBoth = teamA.players.find((p) =>
      teamB.players.some((b) => String(b.id) === String(p.id))
    );

    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => setScreen("first-toss")}
          >
            ← Back to Toss
          </button>

          <div className="setup-header">
            <p className="eyebrow">STEP 3</p>
            <h2>Select Players</h2>
            <p className="subtitle">
              Teams are picked alternately. The first toss winner picks first.
            </p>
          </div>

          <div className="draft-turn-card">
            <span className="draft-turn-label">CURRENT PICK</span>
            <strong>
              {nextPickTeam === "A" ? teamA.name : teamB.name}
            </strong>
            <p>Choose the next player for this team.</p>
          </div>

          <div className="ai-card">
            <div className="ai-title">
              <span className="ai-icon">✨</span>
              <div>
                <strong>AI Team Balance Suggestion</strong>
                <p>Suggested player for the current pick</p>
              </div>
            </div>

            {aiSuggestion ? (
              <div className="ai-suggestion">
                <div>
                  <span>
                    {aiSuggestion.team === "A" ? teamA.name : teamB.name}
                  </span>
                  <strong>Choose {getPlayerName(aiSuggestion.player)}</strong>
                </div>
                <button
                  type="button"
                  disabled={isTeamOptionBlocked(aiSuggestion.player, aiSuggestion.team)}
                  onClick={() => selectPlayer(aiSuggestion.player, aiSuggestion.team)}
                >
                  + Add
                </button>
                <button
                  type="button"
                  onClick={skipAiSuggestion}
                >
                  Skip
                </button>
              </div>
            ) : (
              <p className="ai-complete">No further AI suggestion is available.</p>
            )}

            <div className="strength-container">
              <div className="strength-team">
                <div>
                  <span>{teamA.name}</span>
                  <strong>{teamStrength(teamA)}</strong>
                </div>
                <div className="strength-bar">
                  <div
                    style={{
                      width: `${strengthBarWidth(teamA)}%`,
                    }}
                  />
                </div>
              </div>

              <div className="strength-team">
                <div>
                  <span>{teamB.name}</span>
                  <strong>{teamStrength(teamB)}</strong>
                </div>
                <div className="strength-bar">
                  <div
                    style={{
                      width: `${strengthBarWidth(teamB)}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="balance-text">
              Difference:{" "}
              {Math.abs(
                teamStrength(teamA) -
                  teamStrength(teamB)
              ).toFixed(1)}{" "}
              points
            </div>
          </div>
          <div className="player-picker">
            <div className="picker-header">
              <h3>Available Players</h3>
              <div className="picker-actions">
                <span>{players.length} available</span>
                <button
                  type="button"
                  className="danger-button undo-player-button"
                  onClick={undoPlayerChoice}
                  disabled={!playerChoiceHistory.length}
                >
                  Undo 
                </button>
              </div>
            </div>

            <input
              className="player-search"
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
              placeholder="🔍 Search player..."
            />

            {currentBoth && (
              <div className="both-info">
                ⭐ BOTH player: <strong>{getPlayerName(currentBoth)}</strong>
              </div>
            )}

            <div className="available-players">
              {filteredPlayers.length === 0 ? (
                <div className="no-players">No players found.</div>
              ) : (
                filteredPlayers.map((player) => {
                  const inA = teamAHasPlayer(player.id);
                  const inB = teamBHasPlayer(player.id);
                  const selected = isPlayerSelected(player) || inA || inB;
                  const both = inA && inB;

                  return (
                    <div className="available-player" key={player.id}>
                      <div className="player-info">
                        <div className="player-avatar">
                          {getPlayerName(player).charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <strong>{getPlayerName(player)}</strong>
                          <span>{player.type || "Player"}</span>
                        </div>
                      </div>

                      <div className="player-team-actions draft-player-actions">
                        {both ? (
                          <span className="team-tag both">BOTH</span>
                        ) : selected ? (
                          <span className="team-tag">Selected</span>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={`draft-team-button ${nextPickTeam === "A" ? "allowed" : "blocked"}`}
                              disabled={isTeamOptionBlocked(player, "A")}
                              onClick={() => selectPlayer(player, "A")}
                            >
                              {teamA.name}
                            </button>

                            <button
                              type="button"
                              className={`draft-team-button ${nextPickTeam === "B" ? "allowed" : "blocked"}`}
                              disabled={isTeamOptionBlocked(player, "B")}
                              onClick={() => selectPlayer(player, "B")}
                            >
                              {teamB.name}
                            </button>

                            <button
                              type="button"
                              className="draft-team-button both-button"
                              disabled={isTeamOptionBlocked(player, "BOTH")}
                              onClick={() => selectPlayer(player, "BOTH")}
                            >
                              BOTH
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="selected-teams-grid">
            <div className="selected-team-card">
              <div className="selected-team-header">
                <div>
                  <span>TEAM A</span>
                  <h3>{teamA.name}</h3>
                </div>
                <strong>{teamA.players.length}</strong>
              </div>

              {teamA.players.length === 0 ? (
                <p className="no-players">No players selected.</p>
              ) : (
                teamA.players.map((player) => (
                  <div className="selected-player" key={`A-${player.id}`}>
                    <div>
                      <strong>{getPlayerName(player)}</strong>
                      <span>{isBothPlayer(player) ? "BOTH" : teamA.name}</span>
                    </div>
                    {String(player.id) === String(captainA?.id) ? (
                      <span className="captain-lock">Captain</span>
                    ) : (
                      <button
                        type="button"
                        className="delete-player"
                        onClick={() => removePlayerFromTeam(player.id, "A")}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="selected-team-card">
              <div className="selected-team-header">
                <div>
                  <span>TEAM B</span>
                  <h3>{teamB.name}</h3>
                </div>
                <strong>{teamB.players.length}</strong>
              </div>

              {teamB.players.length === 0 ? (
                <p className="no-players">No players selected.</p>
              ) : (
                teamB.players.map((player) => (
                  <div className="selected-player" key={`B-${player.id}`}>
                    <div>
                      <strong>{getPlayerName(player)}</strong>
                      <span>{isBothPlayer(player) ? "BOTH" : teamB.name}</span>
                    </div>
                    {String(player.id) === String(captainB?.id) ? (
                      <span className="captain-lock">Captain</span>
                    ) : (
                      <button
                        type="button"
                        className="delete-player"
                        onClick={() => removePlayerFromTeam(player.id, "B")}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

         
          <button
            type="button"
            className="primary-button full-button"
            onClick={confirmTeams}
          >
            Confirm Teams →
          </button>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // EXISTING TEAMS
  // --------------------------------------------------

  if (screen === "existing-teams") {
   
const teamsWithPlayers = savedTeams.map((team) => {
  const teamId = String(
    team.teamId || team.id || ""
  );

  // ------------------------------------------------
  // PLAYER DOCUMENT MAP
  // ------------------------------------------------

  const playerMap = new Map();

  players.forEach((player) => {
    const playerId = String(
      player.id ??
        player.uid ??
        player.playerId ??
        ""
    );

    if (playerId) {
      playerMap.set(
        playerId,
        player
      );
    }
  });

  // ------------------------------------------------
  // FIRESTORE TEAM MEMBERSHIPS
  // ------------------------------------------------

  const memberships =
    savedTeamPlayers.filter(
      (item) =>
        String(item.teamId) ===
        teamId
    );

  // ------------------------------------------------
  // CONVERT MEMBERSHIPS INTO PLAYERS
  // ------------------------------------------------

  const membershipPlayers =
    memberships
      .map((item) => {
        const playerId = String(
          item.playerId || ""
        );

        // Prefer the full player document
        const fullPlayer =
          playerMap.get(playerId);

        if (fullPlayer) {
          return {
            ...fullPlayer,

            // Keep membership information
            // if it exists.
            battingPosition:
              item.battingPosition ??
              fullPlayer.battingPosition,

            battingHand:
              item.battingHand ??
              fullPlayer.battingHand,

            bowlingHand:
              item.bowlingHand ??
              fullPlayer.bowlingHand,

            bowlingStyle:
              item.bowlingStyle ??
              fullPlayer.bowlingStyle,

            type:
              fullPlayer.type ||
              item.role ||
              "",
          };
        }

        // Fallback if player document
        // is temporarily unavailable.
        return {
          id: playerId,
          uid: playerId,
          playerId: playerId,
          name:
            item.playerName ||
            "Unknown Player",
          email:
            item.playerEmail ||
            "",
          type:
            item.role ||
            "",
          battingPosition:
            item.battingPosition ||
            "",
          battingHand:
            item.battingHand ||
            "",
          bowlingHand:
            item.bowlingHand ||
            "",
          bowlingStyle:
            item.bowlingStyle ||
            "",
        };
      })
      .filter(
        (player) =>
          String(
            player.id ||
              player.uid ||
              player.playerId ||
              ""
          )
      );

  // ------------------------------------------------
  // OLD TEAM PLAYER IDS
  // Backward compatibility
  // ------------------------------------------------

  const oldPlayerIds =
    Array.isArray(team.playerIds)
      ? team.playerIds
      : [];

  const oldPlayers = oldPlayerIds
    .map((playerId) =>
      playerMap.get(
        String(playerId)
      )
    )
    .filter(Boolean);

  // ------------------------------------------------
  // OLD team.players SUPPORT
  // ------------------------------------------------

  const storedPlayers =
    Array.isArray(team.players)
      ? team.players
      : [];

  const resolvedStoredPlayers =
    storedPlayers
      .map((item) => {
        if (
          item &&
          typeof item === "object"
        ) {
          const id = String(
            item.id ??
              item.uid ??
              item.playerId ??
              ""
          );

          return (
            playerMap.get(id) ||
            item
          );
        }

        return playerMap.get(
          String(item)
        );
      })
      .filter(Boolean);

  // ------------------------------------------------
  // COMBINE EVERYTHING
  // ------------------------------------------------

  const uniquePlayers = new Map();

  [
    ...membershipPlayers,
    ...oldPlayers,
    ...resolvedStoredPlayers,
  ].forEach((player) => {
    const playerId = String(
      player.id ??
        player.uid ??
        player.playerId ??
        ""
    );

    if (!playerId) return;

    uniquePlayers.set(
      playerId,
      player
    );
  });

  return {
    ...team,

    // Always provide a usable name.
    name:
      team.name ||
      team.teamName ||
      "Unnamed Team",

    // Keep teamId available.
    teamId:
      team.teamId ||
      team.id,

    // Final verified player list.
    players:
      Array.from(
        uniquePlayers.values()
      ),
  };
});

    return (
      <>
        <ExistingTeamsScreen
          teams={teamsWithPlayers}
          players={players}
          matchType={matchType}
          testOvers={testOvers}
          testDays={testDays}
          onBack={() => setScreen("team-mode")}
          onContinue={(
            selectedA,
            selectedB,
            capA,
            capB,
            selectedOvers,
            selectedMatchType,
            selectedTestOvers,
            selectedTestDays
          ) => {
            setTeamA({
              id: "A",
              teamId: selectedA.teamId || selectedA.id,
              name: selectedA.name || "Team A",
              captain: capA,
              players: selectedA.players || [],
            });

            setTeamB({
              id: "B",
              teamId: selectedB.teamId || selectedB.id,
              name: selectedB.name || "Team B",
              captain: capB,
              players: selectedB.players || [],
            });

            setCaptainA(capA);
            setCaptainB(capB);
            setMatchOvers(Number(selectedOvers) || 5);
            setMatchType(selectedMatchType || "limited-overs");
            setTestOvers(Number(selectedTestOvers) || 90);
            setTestDays(Number(selectedTestDays) || 5);

            setFirstTossChoice(null);
            setFirstTossResult(null);
            setFirstTossWinner(null);
            setNextPickTeam(null);

            const existingA = selectedA.players || [];
            const existingB = selectedB.players || [];
            const existingIds = new Set();
            const existingDraft = [];

            existingA.forEach((player) => {
              const id = String(player.id);
              if (!existingIds.has(id)) {
                existingIds.add(id);
                existingDraft.push({ player, team: "A" });
              }
            });

            existingB.forEach((player) => {
              const id = String(player.id);
              const already = existingDraft.find(
                (item) => String(item.player.id) === id
              );

              if (already) {
                already.team = "BOTH";
              } else {
                existingIds.add(id);
                existingDraft.push({ player, team: "B" });
              }
            });

            setDraftSelections(existingDraft);
            setPlayerChoiceHistory([]);

            setFirstTossChoice(null);
            setFirstTossResult(null);
            setFirstTossWinner(null);
            setNextPickTeam(null);

            // Captain A is explicitly shown as the final toss caller in the existing UI.
            // Keep that caller deterministic so the Heads/Tails result matches the visible flow.
            setSecondTossCaller(capA);
            setSecondTossChoice(null);
            setSecondTossResult(null);
            setSecondTossWinner(null);

            setScreen("second-toss");
          }}
        />
      </>
    );
  }

  // --------------------------------------------------
  // SECOND TOSS
  // --------------------------------------------------

  if (screen === "second-toss") {
    return (
      <>
        <div className="page matches-page">
          <div className="setup-header">
            <p className="eyebrow">FINAL TOSS</p>

            <h2>Second Toss</h2>

            <p className="subtitle">
              {getPlayerName(captainA)} chooses first.
            </p>
          </div>

          <div className="toss-card">
            <div className="toss-captains">
              <div>
                <span>{teamA.name}</span>
                <strong>
                  {getPlayerName(captainA)}
                </strong>
              </div>

              <div className="toss-vs">VS</div>

              <div>
                <span>{teamB.name}</span>
                <strong>
                  {getPlayerName(captainB)}
                </strong>
              </div>
            </div>

            {!secondTossResult && (
              <>
                <h3>
                  {getPlayerName(captainA)}, choose
                </h3>

                {!secondTossChoice && (
                  <div className="toss-buttons">
                    <button
                      type="button"
                      className="toss-choice"
                      onClick={() =>
                        chooseSecondToss("Heads")
                      }
                    >
                      🪙
                      <span>Heads</span>
                    </button>

                    <button
                      type="button"
                      className="toss-choice"
                      onClick={() =>
                        chooseSecondToss("Tails")
                      }
                    >
                      🪙
                      <span>Tails</span>
                    </button>
                  </div>
                )}
              </>
            )}

            {secondTossChoice &&
              !secondTossResult && (
                <CoinFlip spinning={secondTossSpinning} />
              )}

            {secondTossResult && (
              <div className="toss-result">
                <CoinFlip result={secondTossResult} spinning={secondTossSpinning} />

                <p>Toss result</p>

                <h2>{secondTossResult}</h2>

                <div className="toss-winner">
                  🏆{" "}
                  {getPlayerName(secondTossWinner)}
                  {" "}won the toss
                </div>

                <div className="winner-team">
                  {String(secondTossWinner.id) ===
                  String(captainA.id)
                    ? teamA.name
                    : teamB.name}
                </div>

                <button
                  type="button"
                  className="primary-button"
                  onClick={() =>
                    setScreen("bat-bowl")
                  }
                >
                  Continue →
                </button>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // BAT / BOWL
  // --------------------------------------------------

  if (screen === "bat-bowl") {
    const tossTeams = getTossTeams();

    if (!tossTeams) {
      setScreen("second-toss");
      return null;
    }

    const { winnerTeam } = tossTeams;

    return (
      <>
        <div className="page matches-page">
          <div className="setup-header">
            <p className="eyebrow">TOSS DECISION</p>

            <h2>
              {getPlayerName(secondTossWinner)}
              {" "}won the toss
            </h2>

            <p className="subtitle">
              What would you like to choose?
            </p>
          </div>

          <div className="bat-bowl-card">
            <div className="winner-highlight">
              🏆
              <strong>{winnerTeam.name}</strong>
              <span>Toss Winner</span>
            </div>

            <div className="bat-bowl-buttons">
              <button
                type="button"
                className="bat-button"
                onClick={chooseBat}
              >
                <span>🏏</span>
                <strong>BAT</strong>
                <small>Choose to bat first</small>
              </button>

              <button
                type="button"
                className="bowl-button"
                onClick={chooseBowl}
              >
                <span>⚾</span>
                <strong>BOWL</strong>
                <small>Choose to bowl first</small>
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // LEGACY SCORECARD ROUTE
  // --------------------------------------------------

  if (screen === "scorecard") {
    const currentMatch = matches[0];

    if (!currentMatch) {
      setScreen("list");
      return null;
    }

    navigate(`/scoring/${currentMatch.id}`);
    return null;
  }

  // --------------------------------------------------
  // VIEW SCORECARD
  // --------------------------------------------------

  if (screen === "view-scorecard") {
    if (!viewingMatch) {
      setScreen("list");
      return null;
    }

    const scorecardMatch = buildLiveScorecardSnapshot(
      {
        ...viewingMatch,
        persistedDeliveries,
      },
      persistedDeliveries
    );

    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => {
                setViewingMatch(null);
                setScreen("list");
                navigate("/matches");
              }}
            >
            ← Back to Matches
          </button>

          <div className="setup-header">
            <p className="eyebrow">SCORECARD</p>

            <h2>
              {viewingMatch.teamA.name}
              {" "}vs{" "}
              {viewingMatch.teamB.name}
            </h2>

            <p className="subtitle">
              {formatDate(viewingMatch.createdAt)}
              {" • "}
              {formatTime(viewingMatch.createdAt)}
            </p>
          </div>

          <div className="view-scorecard-card">
            <div className="status-row">
              {viewingMatch.status === "live" && (
                <span className="live-badge">
                  <span className="live-dot"></span>
                  LIVE
                </span>
              )}

              {viewingMatch.status === "unfinished" && (
                <span className="unfinished-badge">
                  UNFINISHED
                </span>
              )}

              {viewingMatch.status === "finished" && (
                <span className="finished-badge">
                  FINISHED
                </span>
              )}
            </div>

            {isTestMatchRecord(viewingMatch) ? (() => {
              const playedInnings = scorecardHistoryInnings({
                match: scorecardMatch,
                scoringState: scorecardMatch.scoringState || {},
              });
              const renderTeam = (team, teamId) => (
                <div className="test-scorecard-team">
                  <strong>{team.name}</strong>
                  <div className="test-team-innings">
                    {testTeamInnings(playedInnings, teamId).map((innings, teamInningsIndex) => (
                      <span key={`${teamId}-${innings.inningsIndex}`}>
                        {testInningsDisplayLabel(
                          innings,
                          teamInningsIndex,
                          viewingMatch
                        )}
                      </span>
                    ))}
                    {!testTeamInnings(playedInnings, teamId).length && (
                      <span>0/0</span>
                    )}
                  </div>
                </div>
              );

              return (
                <div className="scorecard-teams test-scorecard-teams">
                  {renderTeam(viewingMatch.teamA, "A")}
                  <div className="score-vs">VS</div>
                  {renderTeam(viewingMatch.teamB, "B")}
                </div>
              );
            })() : (
              <div className="scorecard-teams">
                <div>
                  <strong>
                    {viewingMatch.teamA.name}
                    {getTossWinnerTeamId(viewingMatch) === "A" && (
                      <small className="scorecard-toss-badge">
                        <small className="scorecard-toss-coin">
                          {viewingMatch.secondTossResult === "Tails" ? "T" : "H"}
                        </small>
                      </small>
                    )}
                  </strong>
                  <span>
                    {scorecardMatch.scoreA || 0}/
                    {scorecardMatch.wicketsA || 0}
                  </span>
                </div>

                <div className="score-vs">VS</div>

                <div>
                  <strong>
                    {viewingMatch.teamB.name}
                    {getTossWinnerTeamId(viewingMatch) === "B" && (
                      <small className="scorecard-toss-badge">
                        <small className="scorecard-toss-coin">
                          {viewingMatch.secondTossResult === "Tails" ? "T" : "H"}
                        </small>
                      </small>
                    )}
                  </strong>
                  <span>
                    {scorecardMatch.scoreB || 0}/
                    {scorecardMatch.wicketsB || 0}
                  </span>
                </div>
              </div>
            )}

            {(viewingMatch.winner ||
              getMatchResultText(viewingMatch)) && (
              <div className="scorecard-winner">
                {getMatchResultText(viewingMatch).toLowerCase().includes("draw") ||
                getMatchResultText(viewingMatch).toLowerCase().includes("tie")
                  ? "🤝"
                  : "🏆"}{" "}
                {getMatchResultText(viewingMatch) ||
                  viewingMatch.winner}
              </div>
            )}

            <div className="scorecard-info-grid">
              {isTestMatchRecord(viewingMatch) ? (() => {
                const playedInnings = scorecardHistoryInnings({
                  match: scorecardMatch,
                  scoringState: scorecardMatch.scoringState || {},
                });
                const totalOvers = playedInnings.reduce(
                  (total, innings) => total + testCompletedOvers(innings.balls),
                  0
                );
                const displayDay = testDisplayDay({
                  match: viewingMatch,
                  innings: playedInnings,
                  scoringState: viewingMatch.scoringState || {},
                });
                const totals = playedInnings.reduce(
                  (result, innings) => {
                    result[innings.teamId] += Number(innings.runs || 0);
                    return result;
                  },
                  { A: 0, B: 0 }
                );
                const leadText = totals.A === totals.B
                  ? "Scores level"
                  : totals.A > totals.B
                    ? `${viewingMatch.teamA.name} lead by ${totals.A - totals.B} runs`
                    : `${viewingMatch.teamB.name} lead by ${totals.B - totals.A} runs`;

                return (
                  <>
                    <div>
                      <span>Total match overs played</span>
                      <strong>{totalOvers}</strong>
                    </div>
                    <div>
                      <span>Days played</span>
                      <strong>{displayDay}</strong>
                    </div>
                    <div>
                      <span>Match position</span>
                      <strong>{leadText}</strong>
                    </div>
                  </>
                );
              })() : (
                <div>
                  <span>Overs</span>
                  <strong>{viewingMatch.overs}</strong>
                </div>
              )}

              {!isTestMatchRecord(viewingMatch) && <div>
                <span>Batting First</span>
                <strong>
                  {viewingMatch.battingTeam}
                </strong>
              </div>}

              {!isTestMatchRecord(viewingMatch) && <div>
                <span>Bowling First</span>
                <strong>
                  {viewingMatch.bowlingTeam}
                </strong>
              </div>}
            </div>
          </div>

          <MatchScorecard
            match={scorecardMatch}
            careerStatsByPlayer={careerStatsByPlayer}
            commentaryLoading={commentaryLoading}
          />
        </div>
      </>
    );
  }

  return null;
}

// ==================================================
// EXISTING TEAMS COMPONENT
// ==================================================

function ExistingTeamsScreen({
  teams,
  players,
  matchType = "limited-overs",
  testOvers = 90,
  testDays = 5,
  onBack,
  onContinue,
}) {
  const [teamAId, setTeamAId] = useState("");
  const [teamBId, setTeamBId] = useState("");

  const [captainAId, setCaptainAId] = useState("");
  const [captainBId, setCaptainBId] = useState("");
  const [selectedOvers, setSelectedOvers] = useState("5");
  const [testOversValue, setTestOversValue] = useState(testOvers);
  const [testDaysValue, setTestDaysValue] = useState(testDays);

  // --------------------------------------------------
  // SAFE ID HELPER
  // --------------------------------------------------

  const getId = (item) => {
    if (!item) return "";

    if (typeof item === "string" || typeof item === "number") {
      return String(item);
    }

    return String(
      item.id ??
        item.uid ??
        item.playerId ??
        item.teamId ??
        ""
    );
  };

  // --------------------------------------------------
  // SAFE NAME HELPERS
  // --------------------------------------------------

  const getTeamName = (team) => {
    return (
      team?.name ||
      team?.teamName ||
      "Unnamed Team"
    );
  };

  const getPlayerName = (player) => {
    return (
      player?.name ||
      player?.playerName ||
      "Unknown Player"
    );
  };

  // --------------------------------------------------
  // SELECTED TEAMS
  // --------------------------------------------------

  const selectedA = teams.find(
    (team) =>
      getId(team) === String(teamAId)
  );

  const selectedB = teams.find(
    (team) =>
      getId(team) === String(teamBId)
  );

  // --------------------------------------------------
  // GET PLAYERS BELONGING TO A TEAM
  // --------------------------------------------------

const getTeamPlayers = (team) => {
  if (!team) return [];

  const teamId = String(
    team.teamId ?? team.id ?? ""
  );

  if (!teamId) return [];

  // First priority: players already attached to this team
  const teamPlayerList = Array.isArray(team.players)
    ? team.players
    : [];

  // Global player lookup
  const playerMap = new Map(
    players.map((player) => [
      String(
        player.id ??
        player.uid ??
        player.playerId ??
        ""
      ),
      player,
    ])
  );

  const resolvedPlayers = [];

  teamPlayerList.forEach((item) => {
    const playerId =
      typeof item === "object"
        ? String(
            item.playerId ??
            item.id ??
            item.uid ??
            ""
          )
        : String(item);

    if (!playerId) return;

    // Resolve the player from global players,
    // but ONLY if that player is actually listed
    // in this team's player list.
    const globalPlayer = playerMap.get(playerId);

    if (globalPlayer) {
      resolvedPlayers.push({
        ...globalPlayer,
        ...(
          typeof item === "object"
            ? item
            : {}
        ),
        id: playerId,
      });
    } else if (typeof item === "object") {
      resolvedPlayers.push({
        ...item,
        id: playerId,
      });
    }
  });

  // Remove duplicate players
  return Array.from(
    new Map(
      resolvedPlayers.map((player) => [
        String(
          player.id ??
          player.uid ??
          player.playerId
        ),
        player,
      ])
    ).values()
  );
};
  const playersA =
    getTeamPlayers(selectedA);

  const playersB =
    getTeamPlayers(selectedB);

  // --------------------------------------------------
  // SELECTED CAPTAINS
  // IMPORTANT:
  // Captain A can ONLY come from Team A
  // Captain B can ONLY come from Team B
  // --------------------------------------------------

  const captainA = playersA.find(
    (player) =>
      getId(player) ===
      String(captainAId)
  );

  const captainB = playersB.find(
    (player) =>
      getId(player) ===
      String(captainBId)
  );

  // --------------------------------------------------
  // TEAM A CHANGE
  // --------------------------------------------------

  const handleTeamAChange = (e) => {
    const newTeamId = e.target.value;

    setTeamAId(newTeamId);

    // Changing the team invalidates
    // the previously selected captain.
    setCaptainAId("");

    // If somehow the same team was selected,
    // clear Team B captain as well.
    if (
      newTeamId &&
      newTeamId === String(teamBId)
    ) {
      setTeamBId("");
      setCaptainBId("");
    }
  };

  // --------------------------------------------------
  // TEAM B CHANGE
  // --------------------------------------------------

  const handleTeamBChange = (e) => {
    const newTeamId = e.target.value;

    setTeamBId(newTeamId);

    // Changing the team invalidates
    // the previously selected captain.
    setCaptainBId("");

    if (
      newTeamId &&
      newTeamId === String(teamAId)
    ) {
      setTeamAId("");
      setCaptainAId("");
    }
  };

  // --------------------------------------------------
  // CAPTAIN A CHANGE
  // --------------------------------------------------

  const handleCaptainAChange = (e) => {
    const newCaptainId =
      e.target.value;

    // Empty selection
    if (!newCaptainId) {
      setCaptainAId("");
      return;
    }

    // Make sure this player actually belongs
    // to Team A.
    const playerBelongsToA =
      playersA.some(
        (player) =>
          getId(player) ===
          String(newCaptainId)
      );

    if (!playerBelongsToA) {
      alert(
        "This player does not belong to Team A."
      );
      return;
    }

    // Same player cannot captain both teams.
    if (
      String(newCaptainId) ===
      String(captainBId)
    ) {
      alert(
        "The same player cannot be captain of both teams."
      );
      return;
    }

    setCaptainAId(
      newCaptainId
    );
  };

  // --------------------------------------------------
  // CAPTAIN B CHANGE
  // --------------------------------------------------

  const handleCaptainBChange = (e) => {
    const newCaptainId =
      e.target.value;

    if (!newCaptainId) {
      setCaptainBId("");
      return;
    }

    // Make sure this player actually belongs
    // to Team B.
    const playerBelongsToB =
      playersB.some(
        (player) =>
          getId(player) ===
          String(newCaptainId)
      );

    if (!playerBelongsToB) {
      alert(
        "This player does not belong to Team B."
      );
      return;
    }

    // Same player cannot captain both teams.
    if (
      String(newCaptainId) ===
      String(captainAId)
    ) {
      alert(
        "The same player cannot be captain of both teams."
      );
      return;
    }

    setCaptainBId(
      newCaptainId
    );
  };

  // --------------------------------------------------
  // CONTINUE
  // --------------------------------------------------

  const continueSetup = () => {
    if (
      matchType === "test" &&
      (!Number.isInteger(Number(testOversValue)) ||
        Number(testOversValue) < 3 ||
        Number(testOversValue) > 90)
    ) {
      alert("Overs per day for Test matches must be between 3 and 90.");
      return;
    }

    // Teams
    if (!selectedA || !selectedB) {
      alert(
        "Please select both teams."
      );
      return;
    }

    // Same team
    if (
      getId(selectedA) ===
      getId(selectedB)
    ) {
      alert(
        "Please select two different teams."
      );
      return;
    }

    // Captains
    if (!captainA || !captainB) {
      alert(
        "Please select both captains."
      );
      return;
    }

    // Same captain
    if (
      getId(captainA) ===
      getId(captainB)
    ) {
      alert(
        "Captains must be different players."
      );
      return;
    }

    // Captain A must belong to Team A
    const captainAInTeamA =
      playersA.some(
        (player) =>
          getId(player) ===
          getId(captainA)
      );

    // Captain B must belong to Team B
    const captainBInTeamB =
      playersB.some(
        (player) =>
          getId(player) ===
          getId(captainB)
      );

    if (!captainAInTeamA) {
      alert(
        `${getPlayerName(captainA)} does not belong to ${getTeamName(selectedA)}.`
      );
      return;
    }

    if (!captainBInTeamB) {
      alert(
        `${getPlayerName(captainB)} does not belong to ${getTeamName(selectedB)}.`
      );
      return;
    }

    // A player cannot be captain for both teams.
    if (
      getId(captainA) ===
      getId(captainB)
    ) {
      alert(
        "The same player cannot be captain for both teams."
      );
      return;
    }

    // Make sure both teams actually contain players.
    if (!playersA.length) {
      alert(
        `${getTeamName(selectedA)} has no players.`
      );
      return;
    }

    if (!playersB.length) {
      alert(
        `${getTeamName(selectedB)} has no players.`
      );
      return;
    }

    // ------------------------------------------------
    // SEND ONLY VERIFIED TEAM PLAYERS + CAPTAINS
    // ------------------------------------------------

    onContinue(
      {
        ...selectedA,
        name: getTeamName(selectedA),
        players: playersA,
      },
      {
        ...selectedB,
        name: getTeamName(selectedB),
        players: playersB,
      },
      captainA,
      captainB,
      selectedOvers,
      matchType,
      testOversValue,
      testDaysValue
    );
  };

  // ==================================================
  // UI
  // ==================================================

  return (
    <div className="page matches-page">

      <button
        type="button"
        className="back-button"
        onClick={onBack}
      >
        ← Back
      </button>

      <div className="setup-header">
        <p className="eyebrow">
          EXISTING TEAMS
        </p>

        <h2>
          Select Teams
        </h2>

        <p className="subtitle">
          Select two teams and their captains.
        </p>
      </div>

      <div className="existing-team-grid">

        {/* ==============================
            TEAM A
        ============================== */}

        <div className="setup-card">

          <h3>Team A</h3>

          <select
            value={teamAId}
            onChange={handleTeamAChange}
          >
            <option value="">
              Select Team A
            </option>

            {teams.map((team) => {
              const id = getId(team);

              return (
                <option
                  key={id}
                  value={id}
                  disabled={
                    id ===
                    String(teamBId)
                  }
                >
                  {getTeamName(team)}
                </option>
              );
            })}
          </select>

          {/* Team A captain */}

          {selectedA && (
            <>
              <label>
                Captain
              </label>

              <select
                value={captainAId}
                onChange={
                  handleCaptainAChange
                }
              >
                <option value="">
                  Select Captain for{" "}
                  {getTeamName(selectedA)}
                </option>

                {playersA.length === 0 ? (
                  <option disabled>
                    No players found in this team
                  </option>
                ) : (
                  playersA.map((player) => {
                    const playerId =
                      getId(player);

                    return (
                      <option
                        key={playerId}
                        value={playerId}
                        disabled={
                          playerId ===
                          String(captainBId)
                        }
                      >
                        {getPlayerName(player)}
                      </option>
                    );
                  })
                )}
              </select>
            </>
          )}

        </div>
        {matchType === "test" && (
          <div className="setup-card">
            <label>Overs per day</label>
            <input type="number" min="3" max="90" value={testOversValue} onChange={(e) => setTestOversValue(e.target.value)} />
          </div>
        )}

        {/* ==============================
            TEAM B
        ============================== */}

        <div className="setup-card">

          <h3>Team B</h3>

          <select
            value={teamBId}
            onChange={handleTeamBChange}
          >
            <option value="">
              Select Team B
            </option>

            {teams.map((team) => {
              const id = getId(team);

              return (
                <option
                  key={id}
                  value={id}
                  disabled={
                    id ===
                    String(teamAId)
                  }
                >
                  {getTeamName(team)}
                </option>
              );
            })}
          </select>

          {/* Team B captain */}

          {selectedB && (
            <>
              <label>
                Captain
              </label>

              <select
                value={captainBId}
                onChange={
                  handleCaptainBChange
                }
              >
                <option value="">
                  Select Captain for{" "}
                  {getTeamName(selectedB)}
                </option>

                {playersB.length === 0 ? (
                  <option disabled>
                    No players found in this team
                  </option>
                ) : (
                  playersB.map((player) => {
                    const playerId =
                      getId(player);

                    return (
                      <option
                        key={playerId}
                        value={playerId}
                        disabled={
                          playerId ===
                          String(captainAId)
                        }
                      >
                        {getPlayerName(player)}
                      </option>
                    );
                  })
                )}
              </select>
            </>
          )}

        </div>

      </div>

      {matchType !== "test" && <div className="setup-card">
        <label htmlFor="existing-match-overs">Match Overs</label>
        <select
          id="existing-match-overs"
          value={selectedOvers}
          onChange={(e) => setSelectedOvers(e.target.value)}
        >
          <option value="1">1 Over</option>
          <option value="2">2 Overs</option>
          <option value="3">3 Overs</option>
          <option value="4">4 Overs</option>
          <option value="5">5 Overs</option>
          <option value="6">6 Overs</option>
          <option value="7">7 Overs</option>
          <option value="8">8 Overs</option>
          <option value="9">9 Overs</option>
          <option value="10">10 Overs</option>
          <option value="12">12 Overs</option>
          <option value="15">15 Overs</option>
          <option value="20">20 Overs</option>
        </select>
      </div>}

      {/* ==============================
          CONTINUE
      ============================== */}

      <button
        type="button"
        className="primary-button full-button"
        onClick={continueSetup}
      >
        Continue to Toss →
      </button>

    </div>
  );
}


export default Matches;