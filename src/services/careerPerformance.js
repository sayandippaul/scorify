import { collection, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase";
import { getCareerMatchStats, getMaidenCount } from "./careerMatchStats";
import { getPlayerDismissalStats } from "./dismissalStats";
import { calculateStrengthPoints } from "./playerStrength";

const SHOT_REGIONS = {
  1: "Behind Keeper",
  2: "Third Man",
  3: "Square Off",
  4: "Cover",
  5: "Long Off",
  6: "Long On",
  7: "Midwicket",
  8: "Square Leg",
  9: "Fine Leg",
};

const shotRegionPosition = (delivery) => {
  const aliases = {
    "behind keeper": 1,
    "behind the keeper": 1,
    "behind wicket": 1,
    "behind the wicket": 1,
    "third man": 2,
    "square off": 3,
    "cover": 4,
    "long off": 5,
    "long on": 6,
    "midwicket": 7,
    "mid wicket": 7,
    "square leg": 8,
    "fine leg": 9,
  };

  for (const rawPosition of [
    delivery?.shotPosition,
    delivery?.shotRegion,
  ]) {
    const numericPosition = Number(rawPosition);

    if (
      rawPosition !== null &&
      rawPosition !== undefined &&
      Number.isInteger(numericPosition) &&
      SHOT_REGIONS[numericPosition]
    ) {
      return numericPosition;
    }

    const normalizedRegion = String(rawPosition ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ");

    if (aliases[normalizedRegion]) return aliases[normalizedRegion];

    const match = normalizedRegion.match(/^(?:region )?([1-9])$/);

    if (match) return Number(match[1]);
  }

  return null;
};

export const getCareerPerformanceByPlayer = (
  players = [],
  records = {}
) => {
  const result = new Map();

  players.forEach((player) => {
    const playerIds =
      typeof player === "object" && player !== null
        ? [
            player.id,
            player.uid,
            player.playerId,
            player.name,
          ].filter(Boolean)
        : [player].filter(Boolean);

    if (!playerIds.length) return;

    const stats = getCareerPerformanceStats({
      ...records,
      playerIds,
    });

    playerIds.forEach((id) =>
      result.set(normalize(id), stats)
    );
  });

  return result;
};

const normalize = (value) =>
  String(
    typeof value === "object"
      ? value?.id ??
          value?.uid ??
          value?.playerId ??
          value?._id ??
          value?.name ??
          ""
      : value ?? ""
  )
    .trim()
    .toLowerCase();

const asNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const toInningsArray = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean);

  if (value && typeof value === "object") {
    return Object.values(value).filter(Boolean);
  }

  return [];
};

const inningsNumber = (inning, fallbackIndex) => {
  const explicitNumber =
    inning?.inningsNumber === null ||
    inning?.inningsNumber === undefined
      ? NaN
      : Number(inning.inningsNumber);

  if (
    Number.isInteger(explicitNumber) &&
    explicitNumber > 0
  ) {
    return explicitNumber;
  }

  const inningsIndex =
    inning?.inningsIndex === null ||
    inning?.inningsIndex === undefined
      ? NaN
      : Number(inning.inningsIndex);

  if (
    Number.isInteger(inningsIndex) &&
    inningsIndex >= 0
  ) {
    return inningsIndex + 1;
  }

  const legacyNumber =
    inning?.innings === null ||
    inning?.innings === undefined
      ? NaN
      : Number(inning.innings);

  if (
    Number.isInteger(legacyNumber) &&
    legacyNumber > 0
  ) {
    return legacyNumber;
  }

  return fallbackIndex + 1;
};

const inningsMatchId = (inning) => {
  const explicitMatchId = normalize(
    inning?.matchId ??
      inning?.matchID ??
      inning?.match_id
  );

  if (explicitMatchId) return explicitMatchId;

  const inningsId = String(
    inning?.inningsId ?? inning?.id ?? ""
  );

  return normalize(
    inningsId.replace(/_innings_\d+$/i, "")
  );
};

const inningsIdentity = (inning, fallbackIndex) => {
  const number = inningsNumber(
    inning,
    fallbackIndex
  );

  if (
    Number.isInteger(number) &&
    number > 0
  ) {
    return `number:${number}`;
  }

  const inningsId = normalize(
    inning?.inningsId
  );

  if (inningsId) return inningsId;

  const teamId = normalize(
    inning?.teamId ??
      inning?.battingTeamId
  );

  const runs = asNumber(inning?.runs);

  const balls = asNumber(
    inning?.balls ??
      inning?.legalBalls
  );

  if (teamId || runs || balls) {
    return `score:${teamId}:${runs}:${balls}`;
  }

  return `index:${fallbackIndex}`;
};

const numberInnings = (value) =>
  toInningsArray(value).map(
    (inning, index) => ({
      ...inning,
      inningsNumber: inningsNumber(
        inning,
        index
      ),
    })
  );

const mergeInning = (previous, next) => {
  const merged = {
    ...previous,
    ...next,
  };

  for (const field of [
    "battingStats",
    "bowlingStats",
  ]) {
    if (
      previous?.[field] &&
      next?.[field]
    ) {
      merged[field] = {
        ...previous[field],
        ...next[field],
      };
    } else if (
      previous?.[field] &&
      !next?.[field]
    ) {
      merged[field] = previous[field];
    }
  }

  for (const field of [
    "deliveries",
    "completedOvers",
    "fallOfWickets",
  ]) {
    if (
      Array.isArray(previous?.[field]) ||
      Array.isArray(next?.[field])
    ) {
      const items = [
        ...(Array.isArray(previous?.[field])
          ? previous[field]
          : []),
        ...(Array.isArray(next?.[field])
          ? next[field]
          : []),
      ];

      const seen = new Set();

      merged[field] = items.filter(
        (item, index) => {
          const key = normalize(
            item?.id ??
              item?.deliveryId ??
              item?.fallOfWicketId ??
              [
                item?.inningsNumber ??
                  item?.inningsIndex ??
                  "",
                item?.overNumber ??
                  item?.over ??
                  "",
                item?.ballNumber ??
                  item?.ball ??
                  "",
                item?.wicket ?? "",
                item?.score ?? "",
                item?.batterId ??
                  item?.batter ??
                  "",
              ].join(":")
          );

          const uniqueKey =
            key || `index:${index}`;

          if (seen.has(uniqueKey)) {
            return false;
          }

          seen.add(uniqueKey);

          return true;
        }
      );
    }
  }

  return merged;
};

const inningsFor = (match) => {
  const persisted = [
    ...numberInnings(
      match?.testInnings
    ),

    ...numberInnings(
      match?.innings
    ),

    ...numberInnings(
      match?.inningsData
    ),

    ...numberInnings(
      match?.savedInnings
    ),

    ...(match?.firstInningsData
      ? [
          {
            ...match.firstInningsData,
            inningsNumber: 1,
          },
        ]
      : []),

    ...(match?.secondInningsData
      ? [
          {
            ...match.secondInningsData,
            inningsNumber: 2,
          },
        ]
      : []),

    ...numberInnings(
      match?.careerInnings
    ),
  ];

  const inningsByKey = new Map();

  persisted.forEach(
    (inning, index) => {
      const key = inningsIdentity(
        inning,
        index
      );

      const number = inningsNumber(
        inning,
        index
      );

      const normalizedInning = {
        ...inning,

        inningsNumber: number,

        inningsIndex:
          inning?.inningsIndex !== null &&
          inning?.inningsIndex !== undefined &&
          Number.isInteger(
            Number(inning.inningsIndex)
          )
            ? Number(inning.inningsIndex)
            : number - 1,
      };

      inningsByKey.set(
        key,
        inningsByKey.has(key)
          ? mergeInning(
              inningsByKey.get(key),
              normalizedInning
            )
          : normalizedInning
      );
    }
  );

  const state =
    match?.scoringState || {};

  const live =
    state.battingStats &&
    state.inningsIndex !== undefined
      ? {
          inningsIndex: Number(
            state.inningsIndex
          ),

          inningsNumber:
            Number(state.inningsIndex) + 1,

          teamId:
            state.teamId ??
            match?.battingTeamId,

          runs: state.inningsRuns,

          wickets:
            state.inningsWickets,

          balls:
            state.legalBalls,

          battingStats:
            state.battingStats,

          bowlingStats:
            state.bowlingStats || {},

          deliveries:
            state.deliveries || [],

          completedOvers:
            state.completedOvers || [],
        }
      : null;

  if (
    live &&
    Number.isInteger(
      live.inningsIndex
    ) &&
    live.inningsIndex >= 0
  ) {
    const key =
      `number:${live.inningsIndex + 1}`;

    inningsByKey.set(
      key,
      inningsByKey.has(key)
        ? mergeInning(
            inningsByKey.get(key),
            live
          )
        : live
    );
  }

  return [
    ...inningsByKey.values(),
  ].sort(
    (left, right) =>
      Number(left.inningsNumber) -
      Number(right.inningsNumber)
  );
};

const isCompletedCareerMatch = (
  match
) => {
  const status = String(
    match?.status || ""
  ).toLowerCase();

  return (
    ["finished", "completed"].includes(
      status
    ) ||
    Boolean(
      match?.finishedAt ||
        match?.completedAt
    ) ||
    match?.winner != null ||
    match?.winnerId != null ||
    match?.result?.winner != null ||
    match?.result?.winnerId != null ||
    (typeof match?.result === "string" &&
      Boolean(match.result.trim()))
  );
};

const findPlayerStat = (
  stats,
  playerIds
) => {
  const entries = Array.isArray(stats)
    ? stats.map((stat) => [
        stat?.playerId ??
          stat?.uid ??
          stat?.id,
        stat,
      ])
    : stats &&
      typeof stats === "object"
      ? Object.entries(stats)
      : [];

  return (
    entries.find(
      ([key, stat]) =>
        playerIds.has(
          normalize(key)
        ) ||
        playerIds.has(
          normalize(
            stat?.playerId ??
              stat?.uid ??
              stat?.id ??
              stat?._id
          )
        )
    )?.[1] || null
  );
};

const statInningsNumber = (
  stat,
  kind
) => {
  if (
    stat?.inningsNumber !== null &&
    stat?.inningsNumber !== undefined
  ) {
    const inningsNumber = Number(
      stat.inningsNumber
    );

    if (
      Number.isInteger(
        inningsNumber
      ) &&
      inningsNumber > 0
    ) {
      return inningsNumber;
    }
  }

  if (
    stat?.inningsIndex !== null &&
    stat?.inningsIndex !== undefined
  ) {
    const inningsIndex = Number(
      stat.inningsIndex
    );

    if (
      Number.isInteger(
        inningsIndex
      ) &&
      inningsIndex >= 0
    ) {
      return inningsIndex + 1;
    }
  }

  if (
    stat?.innings !== null &&
    stat?.innings !== undefined
  ) {
    const inningsNumber = Number(
      stat.innings
    );

    if (
      Number.isInteger(
        inningsNumber
      ) &&
      inningsNumber > 0
    ) {
      return inningsNumber;
    }
  }

  const inningsId = String(
    stat?.inningsId ?? ""
  );

  const fromInningsId =
    inningsId.match(
      /_innings_(\d+)$/i
    );

  if (fromInningsId) {
    return Number(
      fromInningsId[1]
    );
  }

  const documentId = String(
    kind === "batting"
      ? stat?.battingStatId ??
          stat?.id ??
          ""
      : stat?.bowlingStatId ??
          stat?.id ??
          ""
  );

  const fromDocumentId =
    documentId.match(
      kind === "batting"
        ? /_(\d+)_bat_/i
        : /_(\d+)_bowl_/i
    );

  return fromDocumentId
    ? Number(fromDocumentId[1])
    : null;
};

const statDocumentId = (
  stat,
  kind
) =>
  String(
    kind === "batting"
      ? stat?.battingStatId ??
          stat?.id ??
          ""
      : stat?.bowlingStatId ??
          stat?.id ??
          ""
  );

const statMatchId = (
  stat,
  kind
) => {
  const explicitMatchId = normalize(
    stat?.matchId ??
      stat?.matchID ??
      stat?.match_id
  );

  if (explicitMatchId) {
    return explicitMatchId;
  }

  const documentId = statDocumentId(
    stat,
    kind
  );

  const matchId =
    documentId.match(
      kind === "batting"
        ? /^(.*)_\d+_bat_/i
        : /^(.*)_\d+_bowl_/i
    );

  return normalize(
    matchId?.[1]
  );
};

const statPlayerId = (
  stat,
  kind
) => {
  const explicitPlayerId = normalize(
    stat?.playerId ??
      stat?.playerUid ??
      stat?.uid ??
      stat?.batterId ??
      stat?.bowlerId
  );

  if (explicitPlayerId) {
    return explicitPlayerId;
  }

  const documentId =
    statDocumentId(
      stat,
      kind
    );

  const playerId =
    documentId.match(
      kind === "batting"
        ? /_\d+_bat_(.+)$/i
        : /_\d+_bowl_(.+)$/i
    );

  return normalize(
    playerId?.[1] ??
      stat?.playerName ??
      stat?.name
  );
};

const deliveryInningsNumber = (
  delivery
) => {
  const explicitNumber = Number(
    delivery?.inningsNumber ??
      delivery?.innings
  );

  if (
    Number.isInteger(
      explicitNumber
    ) &&
    explicitNumber > 0
  ) {
    return explicitNumber;
  }

  const inningsIndex = Number(
    delivery?.inningsIndex
  );

  if (
    Number.isInteger(
      inningsIndex
    ) &&
    inningsIndex >= 0
  ) {
    return inningsIndex + 1;
  }

  const inningsId = String(
    delivery?.inningsId ?? ""
  );

  const match =
    inningsId.match(
      /_innings_(\d+)$/i
    );

  return match
    ? Number(match[1])
    : null;
};

const derivePlayerInningsStats = (
  inning,
  playerIds
) => {
  const batting = {
    runs: 0,
    balls: 0,
    fours: 0,
    sixes: 0,
    status: "yet",
    dismissal: null,
  };

  const bowling = {
    legalBalls: 0,
    runs: 0,
    wickets: 0,
    maidens: 0,
  };

  let batted = false;
  let bowled = false;

  const illegalTypes = new Set([
    "NB",
    "NO_BALL",
    "NO-BALL",
    "WD",
    "WIDE",
    "DEAD",
  ]);

  const uncreditedWickets =
    new Set([
      "RUN OUT",
      "RETIRED HURT",
      "RETIRED OUT",
      "OBSTRUCTING THE FIELD",
      "TIMED OUT",
    ]);

  (
    Array.isArray(
      inning?.deliveries
    )
      ? inning.deliveries
      : []
  ).forEach((delivery) => {
    const strikerId = normalize(
      delivery?.strikerId ??
        delivery?.batterId ??
        delivery?.batsmanId
    );

    const bowlerId = normalize(
      delivery?.bowlerId ??
        delivery?.bowlerPlayerId
    );

    const wicket =
      delivery?.wicket || null;

    const wicketType = String(
      wicket?.type ??
        wicket?.dismissalType ??
        delivery?.wicketType ??
        ""
    ).trim();

    const type = String(
      delivery?.type ??
        delivery?.deliveryType ??
        ""
    ).toUpperCase();

    const validBall =
      delivery?.validBall !==
      undefined
        ? delivery.validBall === true
        : delivery?.legalBall !==
          undefined
          ? delivery.legalBall === true
          : !illegalTypes.has(
              type
            );

    const batterRuns = asNumber(
      delivery?.batterRuns ??
        delivery?.batsmanRuns ??
        delivery?.batter?.runs
    );

    if (
      playerIds.has(strikerId)
    ) {
      batted = true;

      batting.runs +=
        batterRuns;

      if (validBall) {
        batting.balls += 1;
      }

      if (batterRuns === 4) {
        batting.fours += 1;
      }

      if (batterRuns === 6) {
        batting.sixes += 1;
      }
    }

    if (
      playerIds.has(bowlerId)
    ) {
      bowled = true;

      if (validBall) {
        bowling.legalBalls += 1;
      }

      bowling.runs += asNumber(
        delivery?.bowlerRuns ??
          delivery?.runsConceded ??
          ([
            "BYE",
            "LB",
            "LEG_BYE",
          ].includes(type)
            ? 0
            : delivery?.runs)
      );

      if (
        (
          wicket ||
          delivery?.wicketType ||
          delivery?.dismissedPlayerId
        ) &&
        !uncreditedWickets.has(
          wicketType.toUpperCase()
        )
      ) {
        bowling.wickets += 1;
      }
    }

    const dismissedId = normalize(
      wicket?.batterId ??
        wicket?.playerId ??
        wicket?.dismissedPlayerId ??
        delivery?.dismissedPlayerId
    );

    if (
      playerIds.has(
        dismissedId
      )
    ) {
      batting.status = "out";

      batting.dismissal =
        wicketType || "out";
    }
  });

  return {
    batting:
      batted ||
      batting.status === "out"
        ? batting
        : null,

    bowling:
      bowled
        ? bowling
        : null,
  };
};

const rosterHasPlayer = (
  team,
  fallbackPlayers,
  playerIds
) => {
  const players =
    team?.players ||
    fallbackPlayers;

  return (
    Array.isArray(players) &&
    players.some((player) =>
      playerIds.has(
        normalize(player)
      )
    )
  );
};

const usableMatchLabel = (
  value
) => {
  const label = String(
    value ?? ""
  ).trim();

  return label &&
    label !== "—"
    ? label
    : "";
};

const matchName = (match) => {
  const namedLabel = [
    match?.name,
    match?.matchName,
    match?.title,
    match?.matchTitle,
    match?.opponent,
    match?.opponentName,

    [
      match?.teamA?.name ??
        match?.teamAName,
      match?.teamB?.name ??
        match?.teamBName,
    ]
      .filter(Boolean)
      .join(" vs "),

    match?.tournamentName,
  ]
    .map(usableMatchLabel)
    .find(Boolean);

  if (namedLabel) {
    return namedLabel;
  }

  const matchId =
    usableMatchLabel(
      match?.id ??
        match?.matchId ??
        match?.matchID
    );

  return matchId
    ? `Match ${matchId}`
    : "Match details unavailable";
};

const statMatchName = (
  stat,
  match
) =>
  [
    stat?.matchName,
    stat?.matchTitle,
    stat?.match?.name,
  ]
    .map(usableMatchLabel)
    .find(Boolean) ||
  matchName(match) ||
  "Match details unavailable";

const dismissalLeaders = (
  deliveries,
  playerIds,
  key,
  maximumCount = Infinity
) => {
  const counts = new Map();
  const seenDismissals =
    new Set();

  deliveries.forEach(
    (delivery) => {
      const method = String(
        delivery?.wicket?.type ||
          delivery?.wicket
            ?.dismissalType ||
          delivery?.wicketType ||
          delivery?.dismissalType ||
          ""
      ).trim();

      if (!method) return;

      const normalizedMethod =
        method
          .trim()
          .toLowerCase()
          .replace(
            /[-_]+/g,
            " "
          );

      const involvedPlayer =
        key === "batting"
          ? delivery?.wicket
              ?.batterId ||
            delivery?.wicket
              ?.playerId ||
            delivery?.wicket
              ?.dismissedPlayerId ||
            delivery?.batterId ||
            delivery?.batsmanId ||
            delivery?.dismissedPlayerId
          : delivery?.bowlerId ||
            delivery?.bowlerPlayerId;

      const playerId =
        normalize(
          involvedPlayer
        );

      if (
        !playerIds.has(
          playerId
        )
      ) {
        return;
      }

      const matchId = normalize(
        delivery?.matchId ??
          delivery?.matchID ??
          delivery?.match_id
      );

      const innings = normalize(
        delivery?.inningsNumber ??
          delivery?.innings ??
          delivery?.inningsIndex
      );

      const over = normalize(
        delivery?.overNumber ??
          delivery?.over
      );

      const ball = normalize(
        delivery?.ballNumber ??
          delivery?.ball
      );

      const hasBallCoordinates =
        Boolean(
          matchId &&
            (over || ball)
        );

      const fallbackDeliveryId =
        normalize(
          delivery?.id ??
            delivery?.deliveryId ??
            delivery?.sequence
        );

      const dismissalId =
        hasBallCoordinates
          ? [
              matchId,
              innings,
              over,
              ball,
              playerId,
              normalizedMethod,
            ].join(":")
          : fallbackDeliveryId
            ? `${matchId}:${fallbackDeliveryId}:${playerId}:${normalizedMethod}`
            : `${playerId}:${normalizedMethod}:${seenDismissals.size}`;

      if (
        seenDismissals.has(
          dismissalId
        )
      ) {
        return;
      }

      seenDismissals.add(
        dismissalId
      );

      const label = method
        .replace(
          /[-_]+/g,
          " "
        )
        .replace(
          /\b\w/g,
          (letter) =>
            letter.toUpperCase()
        );

      counts.set(
        label,
        (counts.get(label) || 0) +
          1
      );
    }
  );

  let remaining =
    maximumCount;

  return [
    ...counts.entries(),
  ]
    .map(
      ([method, count]) => ({
        method,
        count,
      })
    )
    .sort(
      (left, right) =>
        right.count -
          left.count ||
        left.method.localeCompare(
          right.method
        )
    )
    .map((item) => {
      const count = Math.min(
        item.count,
        remaining
      );

      remaining -= count;

      return {
        ...item,
        count,
      };
    })
    .filter(
      (item) => item.count > 0
    )
    .slice(0, 3);
};

export const loadCareerRecords =
  async () => {
    const collections = [
      "matches",
      "innings",
      "battingStats",
      "bowlingStats",
      "deliveries",
      "tournaments",
    ];

    const snapshots =
      await Promise.all(
        collections.map(
          (name) =>
            getDocs(
              collection(
                db,
                name
              )
            )
        )
      );

    const records =
      snapshots.map(
        (snapshot) =>
          snapshot.docs.map(
            (item) => ({
              ...item.data(),
              id: item.id,
            })
          )
      );

    return {
      matches: records[0],
      inningsRecords:
        records[1],
      battingStats:
        records[2],
      bowlingStats:
        records[3],
      deliveries:
        records[4],
      tournaments:
        records[5],
    };
  };

export const getCareerPerformanceStats =
  ({
    playerIds = [],
    matches = [],
    inningsRecords = [],
    battingStats = [],
    bowlingStats = [],
    deliveries = [],
    tournaments = [],
  } = {}) => {
    const ids = new Set(
      [...playerIds]
        .map(normalize)
        .filter(Boolean)
    );

    const records = {
      battingRuns: 0,
      ballsFaced: 0,
      timesOut: 0,
      twentyRunInnings: 0,
      highestScore: 0,
      highestScoreMatch: "—",
      totalBowls: 0,
      maidens: 0,
      wickets: 0,
      runsConceded: 0,
      threeWicketHauls: 0,
      bestBowlingWickets: 0,
      bestBowlingRuns: Infinity,
      bestBowlingMatch: "—",
      totalMatches: 0,
      wins: 0,
      losses: 0,
      draws: 0,
    };

    const battingByMatch =
      new Map();

    const bowlingByMatch =
      new Map();

    const matchIdAliases =
      new Map();

    matches.forEach(
      (match) => {
        const matchId = normalize(
          match?.id ??
            match?.matchId
        );

        if (!matchId) return;

        [
          match?.id,
          match?.matchId,
          match?.matchID,
          match?.match_id,
        ]
          .map(normalize)
          .filter(Boolean)
          .forEach((alias) =>
            matchIdAliases.set(
              alias,
              matchId
            )
          );
      }
    );

    const inningsByMatch =
      new Map();

    inningsRecords.forEach(
      (inning) => {
        const rawMatchId =
          inningsMatchId(
            inning
          );

        const matchId =
          matchIdAliases.get(
            rawMatchId
          ) || rawMatchId;

        if (!matchId) return;

        inningsByMatch.set(
          matchId,
          [
            ...(inningsByMatch.get(
              matchId
            ) || []),
            inning,
          ]
        );
      }
    );

    const deliveriesByMatchInnings =
      new Map();

    deliveries.forEach(
      (delivery) => {
        const rawMatchId =
          normalize(
            delivery?.matchId ??
              delivery?.matchID ??
              delivery?.match_id
          );

        const matchId =
          matchIdAliases.get(
            rawMatchId
          ) || rawMatchId;

        const number =
          deliveryInningsNumber(
            delivery
          );

        if (
          !matchId ||
          number === null
        ) {
          return;
        }

        const key =
          `${matchId}:${number}`;

        deliveriesByMatchInnings.set(
          key,
          [
            ...(deliveriesByMatchInnings.get(
              key
            ) || []),
            delivery,
          ]
        );
      }
    );

    const matchesWithInnings =
      matches.map(
        (match) => {
          const matchId =
            matchIdAliases.get(
              normalize(
                match?.id ??
                  match?.matchId ??
                  match?.matchID
              )
            ) ||
            normalize(
              match?.id ??
                match?.matchId ??
                match?.matchID
            );

          const savedInnings =
            inningsByMatch.get(
              matchId
            ) || [];

          const inningsWithDeliveries =
            Array.from(
              deliveriesByMatchInnings.entries()
            )
              .filter(
                ([key]) =>
                  key.startsWith(
                    `${matchId}:`
                  )
              )
              .map(
                ([key, records]) => {
                  const number =
                    Number(
                      key.slice(
                        key.lastIndexOf(
                          ":"
                        ) + 1
                      )
                    );

                  return {
                    matchId,
                    inningsNumber:
                      number,
                    inningsIndex:
                      number - 1,
                    deliveries:
                      records,
                  };
                }
              );

          return {
            ...match,

            careerInnings: [
              ...savedInnings,
              ...inningsWithDeliveries,
            ],
          };
        }
      );

    const indexStats = (
      source,
      target
    ) =>
      source.forEach(
        (stat) => {
          const kind =
            target ===
            battingByMatch
              ? "batting"
              : "bowling";

          const playerId =
            statPlayerId(
              stat,
              kind
            );

          const rawMatchId =
            statMatchId(
              stat,
              kind
            );

          const matchId =
            matchIdAliases.get(
              rawMatchId
            ) || rawMatchId;

          if (
            !ids.has(
              playerId
            ) ||
            !matchId
          ) {
            return;
          }

          target.set(
            matchId,
            [
              ...(target.get(
                matchId
              ) || []),
              stat,
            ]
          );
        }
      );

    indexStats(
      battingStats,
      battingByMatch
    );

    indexStats(
      bowlingStats,
      bowlingByMatch
    );

    const participation = [];

    const careerMatchIds =
      new Set();

    const productiveRuns =
      new Map();

    const addBatting = (
      batter,
      match
    ) => {
      const runs = asNumber(
        batter?.runs ??
          batter?.battingRuns ??
          batter?.totalRuns ??
          batter?.batterRuns
      );

      const balls = asNumber(
        batter?.balls ??
          batter?.ballsFaced ??
          batter?.totalBalls
      );

      const status = String(
        batter?.status ??
          batter?.dismissalStatus ??
          ""
      ).toLowerCase();

      records.battingRuns +=
        runs;

      records.ballsFaced +=
        balls;

      if (
        ["out", "dismissed"].includes(
          status
        ) ||
        batter?.dismissalType ||
        batter?.wicketType
      ) {
        records.timesOut +=
          1;
      }

      if (runs >= 20) {
        records.twentyRunInnings +=
          1;
      }

      if (
        runs >
        records.highestScore
      ) {
        records.highestScore =
          runs;

        records.highestScoreMatch =
          statMatchName(
            batter,
            match
          );
      }
    };

    const addBowling = (
      bowler,
      match,
      inning = null
    ) => {
      const legalBalls =
        asNumber(
          bowler?.legalBalls ??
            bowler?.balls ??
            bowler?.ballsBowled
        );

      const conceded =
        asNumber(
          bowler?.runsConceded ??
            bowler?.runs ??
            bowler?.conceded
        );

      const wickets =
        asNumber(
          bowler?.wickets ??
            bowler?.wicketCount ??
            bowler?.totalWickets
        );

      records.totalBowls +=
        legalBalls;

      records.runsConceded +=
        conceded;

      records.wickets +=
        wickets;

      records.maidens +=
        inning
          ? getMaidenCount(
              inning,
              bowler?.playerId ??
                bowler?.uid ??
                bowler?.id ??
                [...ids][0],
              bowler?.maidens
            )
          : asNumber(
              bowler?.maidens
            );

      if (wickets >= 3) {
        records.threeWicketHauls +=
          1;
      }

      if (
        wickets >
          records.bestBowlingWickets ||
        (
          wickets > 0 &&
          wickets ===
            records.bestBowlingWickets &&
          conceded <
            records.bestBowlingRuns
        )
      ) {
        records.bestBowlingWickets =
          wickets;

        records.bestBowlingRuns =
          conceded;

        records.bestBowlingMatch =
          statMatchName(
            bowler,
            match
          );
      }
    };

    matchesWithInnings.forEach(
      (match) => {
        const matchId =
          matchIdAliases.get(
            normalize(
              match?.id ??
                match?.matchId ??
                match?.matchID
            )
          ) ||
          normalize(
            match?.id ??
              match?.matchId ??
              match?.matchID
          );

        if (!matchId) return;

        const teamA =
          rosterHasPlayer(
            match?.teamA,
            match?.teamAPlayers,
            ids
          );

        const teamB =
          rosterHasPlayer(
            match?.teamB,
            match?.teamBPlayers,
            ids
          );

        const innings =
          inningsFor(match);

        const matchBatting =
          battingByMatch.get(
            matchId
          ) || [];

        const matchBowling =
          bowlingByMatch.get(
            matchId
          ) || [];

        const battingByInnings =
          new Map();

        const bowlingByInnings =
          new Map();

        const unassignedBatting =
          [];

        const unassignedBowling =
          [];

        matchBatting.forEach(
          (stat) => {
            const number =
              statInningsNumber(
                stat,
                "batting"
              );

            if (number === null) {
              unassignedBatting.push(
                stat
              );

              return;
            }

            battingByInnings.set(
              number,
              [
                ...(battingByInnings.get(
                  number
                ) || []),
                stat,
              ]
            );
          }
        );

        matchBowling.forEach(
          (stat) => {
            const number =
              statInningsNumber(
                stat,
                "bowling"
              );

            if (number === null) {
              unassignedBowling.push(
                stat
              );

              return;
            }

            bowlingByInnings.set(
              number,
              [
                ...(bowlingByInnings.get(
                  number
                ) || []),
                stat,
              ]
            );
          }
        );

        const isTestMatch =
          String(
            match?.matchType || ""
          )
            .trim()
            .toLowerCase() ===
          "test";

        const isFinishedTestMatch =
          isTestMatch &&
          isCompletedCareerMatch(
            match
          );

        let embeddedParticipation =
          false;

        const processedBattingStats =
          new Set();

        const processedBowlingStats =
          new Set();

        const finishedTestDeliveryInnings =
          new Set();

        let derivedBattingParticipation =
          false;

        let derivedBowlingParticipation =
          false;

        let hasInningsBattingSource =
          false;

        let hasInningsBowlingSource =
          false;

        innings.forEach(
          (inning, index) => {
            const currentInningsNumber =
              inningsNumber(
                inning,
                index
              );

            /*
             * TEST MATCH FINISH FIX:
             *
             * When a Test match finishes on the last delivery, the saved
             * batting/bowling stat document can sometimes still contain the
             * figures from immediately before that delivery.
             *
             * For a finished Test match, when the complete delivery list for
             * an innings is available, calculate that innings directly from
             * its deliveries.
             *
             * This means:
             *
             * Last ball = batsman scores 4
             * -> those 4 runs are included.
             *
             * Last ball = bowler takes wicket
             * -> that wicket is included.
             *
             * Non-Test matches and unfinished Test matches continue through
             * the original source-selection logic below.
             */

            const inningsDeliveries =
              Array.isArray(
                inning?.deliveries
              )
                ? inning.deliveries
                : [];

            if (
              isFinishedTestMatch &&
              inningsDeliveries.length
            ) {
              finishedTestDeliveryInnings.add(
                currentInningsNumber
              );

              const derived =
                derivePlayerInningsStats(
                  inning,
                  ids
                );

              if (
                derived.batting
              ) {
                embeddedParticipation =
                  true;

                derivedBattingParticipation =
                  true;

                hasInningsBattingSource =
                  true;

                addBatting(
                  derived.batting,
                  match
                );
              }

              if (
                derived.bowling
              ) {
                embeddedParticipation =
                  true;

                derivedBowlingParticipation =
                  true;

                hasInningsBowlingSource =
                  true;

                addBowling(
                  derived.bowling,
                  match,
                  inning
                );
              }

              /*
               * These stat records belong to this innings.
               * They must not be processed again because the complete
               * delivery-derived figures have already been added.
               */
              const battingStatsForFinishedInnings =
                battingByInnings.get(
                  currentInningsNumber
                ) || [];

              const bowlingStatsForFinishedInnings =
                bowlingByInnings.get(
                  currentInningsNumber
                ) || [];

              battingStatsForFinishedInnings.forEach(
                (stat) =>
                  processedBattingStats.add(
                    stat
                  )
              );

              bowlingStatsForFinishedInnings.forEach(
                (stat) =>
                  processedBowlingStats.add(
                    stat
                  )
              );

              return;
            }

            const battingStatsForInnings =
              battingByInnings.get(
                currentInningsNumber
              ) || [];

            const bowlingStatsForInnings =
              bowlingByInnings.get(
                currentInningsNumber
              ) || [];

            const batter =
              findPlayerStat(
                inning?.battingStats,
                ids
              );

            const bowler =
              findPlayerStat(
                inning?.bowlingStats,
                ids
              );

            const hasEmbeddedBatting =
              batter &&
              (
                String(
                  batter.status || ""
                ).toLowerCase() !==
                  "yet" ||
                asNumber(
                  batter.runs ??
                    batter.battingRuns ??
                    batter.totalRuns
                ) ||
                asNumber(
                  batter.balls ??
                    batter.ballsFaced ??
                    batter.totalBalls
                )
              );

            const hasEmbeddedBowling =
              bowler &&
              (
                asNumber(
                  bowler.legalBalls ??
                    bowler.balls ??
                    bowler.ballsBowled
                ) ||
                asNumber(
                  bowler.runs ??
                    bowler.runsConceded ??
                    bowler.conceded
                ) ||
                asNumber(
                  bowler.wickets ??
                    bowler.wicketCount ??
                    bowler.totalWickets
                ) ||
                asNumber(
                  bowler.maidens
                )
              );

            if (
              hasEmbeddedBatting
            ) {
              embeddedParticipation =
                true;

              hasInningsBattingSource =
                true;

              addBatting(
                batter,
                match
              );

              battingStatsForInnings.forEach(
                (stat) =>
                  processedBattingStats.add(
                    stat
                  )
              );
            } else if (
              battingStatsForInnings.length
            ) {
              hasInningsBattingSource =
                true;

              battingStatsForInnings.forEach(
                (stat) => {
                  processedBattingStats.add(
                    stat
                  );

                  addBatting(
                    stat,
                    match
                  );
                }
              );
            } else {
              const derived =
                derivePlayerInningsStats(
                  inning,
                  ids
                ).batting;

              if (derived) {
                embeddedParticipation =
                  true;

                derivedBattingParticipation =
                  true;

                hasInningsBattingSource =
                  true;

                addBatting(
                  derived,
                  match
                );
              }
            }

            if (
              hasEmbeddedBowling
            ) {
              embeddedParticipation =
                true;

              hasInningsBowlingSource =
                true;

              addBowling(
                bowler,
                match,
                inning
              );

              bowlingStatsForInnings.forEach(
                (stat) =>
                  processedBowlingStats.add(
                    stat
                  )
              );
            } else if (
              bowlingStatsForInnings.length
            ) {
              hasInningsBowlingSource =
                true;

              bowlingStatsForInnings.forEach(
                (stat) => {
                  processedBowlingStats.add(
                    stat
                  );

                  addBowling(
                    stat,
                    match,
                    inning
                  );
                }
              );
            } else {
              const derived =
                derivePlayerInningsStats(
                  inning,
                  ids
                ).bowling;

              if (derived) {
                embeddedParticipation =
                  true;

                derivedBowlingParticipation =
                  true;

                hasInningsBowlingSource =
                  true;

                addBowling(
                  derived,
                  match,
                  inning
                );
              }
            }
          }
        );

        if (isTestMatch) {
          /*
           * TEST MATCH CAREER FIX:
           *
           * Both innings must contribute to the same career totals.
           *
           * For finished Test innings that had complete delivery data,
           * those innings have already been calculated above and their
           * innings-specific stat records have been marked as processed.
           *
           * Do not use an unassigned stale aggregate stat when delivery data
           * already exists for the finished Test. Otherwise the same innings
           * could be counted twice.
           *
           * If a Test innings has no delivery data, its existing career stat
           * remains available as a fallback.
           */

          matchBatting.forEach(
            (stat) => {
              if (
                processedBattingStats.has(
                  stat
                )
              ) {
                return;
              }

              const statInnings =
                statInningsNumber(
                  stat,
                  "batting"
                );

              /*
               * A finished Test with delivery data has the authoritative
               * figures from deliveries. An unassigned stat in that situation
               * is normally the old/stale aggregate record, so do not add it.
               */
              if (
                isFinishedTestMatch &&
                statInnings === null &&
                finishedTestDeliveryInnings.size
              ) {
                return;
              }

              processedBattingStats.add(
                stat
              );

              addBatting(
                stat,
                match
              );
            }
          );

          matchBowling.forEach(
            (stat) => {
              if (
                processedBowlingStats.has(
                  stat
                )
              ) {
                return;
              }

              const statInnings =
                statInningsNumber(
                  stat,
                  "bowling"
                );

              if (
                isFinishedTestMatch &&
                statInnings === null &&
                finishedTestDeliveryInnings.size
              ) {
                return;
              }

              processedBowlingStats.add(
                stat
              );

              addBowling(
                stat,
                match
              );
            }
          );
        } else {
          /*
           * Existing limited-overs / non-Test behavior.
           * This section is intentionally unchanged.
           */

          if (
            !innings.length ||
            !hasInningsBattingSource
          ) {
            matchBatting.forEach(
              (stat) => {
                if (
                  !processedBattingStats.has(
                    stat
                  )
                ) {
                  addBatting(
                    stat,
                    match
                  );
                }
              }
            );
          } else {
            battingByInnings.forEach(
              (stats) =>
                stats.forEach(
                  (stat) => {
                    if (
                      !processedBattingStats.has(
                        stat
                      )
                    ) {
                      addBatting(
                        stat,
                        match
                      );
                    }
                  }
                )
            );
          }

          if (
            !innings.length ||
            !hasInningsBowlingSource
          ) {
            matchBowling.forEach(
              (stat) => {
                if (
                  !processedBowlingStats.has(
                    stat
                  )
                ) {
                  addBowling(
                    stat,
                    match
                  );
                }
              }
            );
          } else {
            bowlingByInnings.forEach(
              (stats) =>
                stats.forEach(
                  (stat) => {
                    if (
                      !processedBowlingStats.has(
                        stat
                      )
                    ) {
                      addBowling(
                        stat,
                        match
                      );
                    }
                  }
                )
            );
          }

          if (
            innings.length &&
            !derivedBattingParticipation &&
            !hasInningsBattingSource
          ) {
            unassignedBatting.forEach(
              (stat) =>
                addBatting(
                  stat,
                  match
                )
            );
          }

          if (
            innings.length &&
            !derivedBowlingParticipation &&
            !hasInningsBowlingSource
          ) {
            unassignedBowling.forEach(
              (stat) =>
                addBowling(
                  stat,
                  match
                )
            );
          }
        }

        const hasPlayerStats =
          matchBatting.length > 0 ||
          matchBowling.length > 0 ||
          embeddedParticipation;

        const participated =
          hasPlayerStats ||
          (
            (teamA || teamB) &&
            isCompletedCareerMatch(
              match
            )
          );

        if (!participated) {
          return;
        }

        /*
         * IMPORTANT:
         *
         * Even though a Test match can have 2, 3 or 4 innings,
         * it is still ONE match for the career match count.
         */
        if (
          !careerMatchIds.has(
            matchId
          )
        ) {
          records.totalMatches += 1;
        }

        participation.push(
          match
        );

        careerMatchIds.add(
          matchId
        );
      }
    );

    const careerDeliveries = [
      ...deliveries.filter(
        (delivery) => {
          const rawMatchId =
            normalize(
              delivery?.matchId ??
                delivery?.matchID ??
                delivery?.match_id
            );

          return careerMatchIds.has(
            matchIdAliases.get(
              rawMatchId
            ) || rawMatchId
          );
        }
      ),

      ...participation.flatMap(
        (match) =>
          inningsFor(match).flatMap(
            (inning) =>
              (
                Array.isArray(
                  inning?.deliveries
                )
                  ? inning.deliveries
                  : []
              ).map(
                (delivery) => ({
                  ...delivery,

                  matchId:
                    delivery?.matchId ??
                    delivery?.matchID ??
                    match?.id ??
                    match?.matchId,

                  inningsNumber:
                    delivery?.inningsNumber ??
                    delivery?.innings ??
                    Number(
                      inning?.inningsIndex ??
                        inning?.inningsNumber ??
                        0
                    ) + 1,
                })
              )
          )
      ),
    ];

    const processedDeliveries =
      new Set();

    const uniqueCareerDeliveries =
      careerDeliveries.filter(
        (delivery, index) => {
          const rawMatchId =
            normalize(
              delivery?.matchId ??
                delivery?.matchID ??
                delivery?.match_id
            );

          const matchKey =
            matchIdAliases.get(
              rawMatchId
            ) || rawMatchId;

          const inningsKey =
            normalize(
              delivery?.inningsNumber ??
                delivery?.innings ??
                delivery?.inningsIndex
            );

          const deliveryId =
            normalize(
              delivery?.id ??
                delivery?.deliveryId ??
                delivery?.sequence
            );

          const deliveryKey = [
            matchKey,
            inningsKey,

            deliveryId ||
              [
                delivery?.overNumber ??
                  delivery?.over ??
                  "",

                delivery?.ballNumber ??
                  delivery?.ball ??
                  "",

                normalize(
                  delivery?.strikerId ??
                    delivery?.batterId ??
                    delivery?.batsmanId
                ),

                normalize(
                  delivery?.bowlerId ??
                    delivery?.bowlerPlayerId
                ),

                asNumber(
                  delivery?.batterRuns ??
                    delivery?.batsmanRuns
                ),

                normalize(
                  delivery?.type ??
                    delivery?.deliveryType
                ),

                normalize(
                  delivery?.wicket?.type ??
                    delivery?.wicketType
                ),
              ].join(":") ||
              String(index),
          ].join(":");

          if (
            processedDeliveries.has(
              deliveryKey
            )
          ) {
            return;
          }

          processedDeliveries.add(
            deliveryKey
          );

          return true;
        }
      );

    uniqueCareerDeliveries.forEach(
      (delivery) => {
        const recordedBatterRuns =
          delivery?.batterRuns ??
          delivery?.batsmanRuns ??
          delivery?.batter?.runs;

        const runs =
          recordedBatterRuns ===
            undefined ||
          recordedBatterRuns ===
            null
            ? Math.max(
                0,
                asNumber(
                  delivery?.runs
                ) -
                  asNumber(
                    delivery?.extras
                  )
              )
            : asNumber(
                recordedBatterRuns
              );

        const position =
          shotRegionPosition(
            delivery
          );

        if (
          ids.has(
            normalize(
              delivery?.strikerId ??
                delivery?.batterId ??
                delivery?.batsmanId ??
                delivery?.batter?.id
            )
          ) &&
          runs > 0 &&
          position !== null
        ) {
          productiveRuns.set(
            position,
            (
              productiveRuns.get(
                position
              ) || 0
            ) + runs
          );
        }
      }
    );

    const matchRecords =
      getCareerMatchStats({
        playerIds: ids,
        matches: participation,
        tournaments,
      });

    const resultMatches =
      matches.filter(
        (match) =>
          participation.some(
            (played) =>
              normalize(
                played?.id ??
                  played?.matchId
              ) ===
              normalize(
                match?.id ??
                  match?.matchId
              )
          )
      );

    resultMatches.forEach(
      (match) => {
        const record =
          getCareerMatchStats({
            playerIds: ids,
            matches: [match],
            tournaments: [],
          });

        records.wins +=
          record.testWon +
          record.limitedWon;

        records.losses +=
          record.testLost +
          record.limitedLost;

        records.draws +=
          record.testDraw +
          record.limitedDraw;
      }
    );

    const totalOvers =
      `${Math.floor(
        records.totalBowls / 6
      )}.${records.totalBowls % 6}`;

    const percentage = (
      count
    ) =>
      records.totalMatches
        ? (
            (count /
              records.totalMatches) *
            100
          ).toFixed(2)
        : "0.00";

    const battingAverage =
      records.timesOut
        ? (
            records.battingRuns /
            records.timesOut
          ).toFixed(2)
        : "—";

    const strikeRate =
      records.ballsFaced
        ? (
            (records.battingRuns /
              records.ballsFaced) *
            100
          ).toFixed(2)
        : "0.00";

    const economy =
      records.totalBowls
        ? (
            (records.runsConceded /
              records.totalBowls) *
            6
          ).toFixed(2)
        : "0.00";

    const strength =
      calculateStrengthPoints({
        runs: records.battingRuns,
        wickets: records.wickets,
        matchesPlayed:
          records.totalMatches,
      }).toFixed(1);

    const bowlingFigures =
      records.bestBowlingWickets
        ? `${records.bestBowlingWickets}/${records.bestBowlingRuns}`
        : "—";

    return {
      ...records,
      ...matchRecords,

      battingAverage,
      strikeRate,
      economy,
      totalOvers,

      playerStrength:
        strength,

      winPercentage:
        percentage(
          records.wins
        ),

      losePercentage:
        percentage(
          records.losses
        ),

      drawPercentage:
        percentage(
          records.draws
        ),

      bestBowlingFigures:
        bowlingFigures,

      productiveShotRegions:
        [...productiveRuns.entries()]
          .map(
            ([position, runs]) => ({
              position,
              region:
                SHOT_REGIONS[
                  position
                ],
              runs,
            })
          )
          .sort(
            (left, right) =>
              right.runs -
              left.runs
          )
          .slice(0, 2),

      mostDismissedBy:
        dismissalLeaders(
          uniqueCareerDeliveries,
          ids,
          "batting",
          records.timesOut
        ),

      mostWicketsTakenBy:
        dismissalLeaders(
          uniqueCareerDeliveries,
          ids,
          "bowling"
        ),

      ...getPlayerDismissalStats(
        uniqueCareerDeliveries,
        ids
      ),
    };
  };