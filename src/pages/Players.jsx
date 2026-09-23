import { useEffect, useState } from "react";
import "./players.css";
import "./profile.css";

import {
  createUserWithEmailAndPassword,
} from "firebase/auth";

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

import {
  initializeApp,
  getApps,
} from "firebase/app";

import {
  getAuth,
} from "firebase/auth";

import {
  auth,
  db,
} from "../firebase/firebase";
import LoadingOverlay from "../components/LoadingOverlay";
import { calculateStrengthPoints } from "../services/playerStrength";
import { getCareerMatchStats } from "../services/careerMatchStats";


import { ADMIN_UID } from "../config/security";
import { saveLastAdminDelete } from "../services/adminUndoService";
const DEFAULT_PASSWORD = "cricket";

const formatBowlingOvers = (balls) => {
  const totalBalls = Math.max(0, Math.floor(Number(balls) || 0));
  return `${Math.floor(totalBalls / 6)}.${totalBalls % 6}`;
};


/* =========================================
   SECONDARY FIREBASE AUTH
   =========================================
   
   Used only when ADMIN adds a player.

   This prevents the currently logged-in
   admin/user from being signed out when
   createUserWithEmailAndPassword() is used.
========================================= */

const getPlayerCreationAuth = () => {

  const existingApp = getApps().find(
    (app) => app.name === "playerCreator"
  );

  const playerCreatorApp =
    existingApp ||
    initializeApp(
      auth.app.options,
      "playerCreator"
    );

  return getAuth(playerCreatorApp);
};


/* =========================================
   ADMIN STATE
========================================= */

// const getAdminState = () => {

//   if (typeof window === "undefined") {
//     return true;
//   }

//   return (
//     localStorage.getItem(
//       "cricket_admin_user_id"
//     ) === ADMIN_ID
//   );
// };


/* =========================================
   NORMALIZE FIRESTORE PLAYERS
========================================= */

const normalizePlayers = (players = []) => {

  if (!Array.isArray(players)) {
    return [];
  }

  return players.map(
    (player, index) => ({

      id:
        player?.id ??
        player?.uid ??
        index + 1,

      uid:
        player?.uid ??
        player?.id ??
        null,

      name:
        player?.name ??
        `Player ${index + 1}`,

      email:
        player?.email ??
        "",

      type:
        player?.type ??
        "Batsman",

      battingHand:
        player?.battingHand ??
        null,

      battingPosition:
        player?.battingPosition ??
        null,

      bowlingHand:
        player?.bowlingHand ??
        null,

      bowlingStyle:
        player?.bowlingStyle ??
        null,

      createdAt:
        player?.createdAt ??
        null,

    })
  );
};


/* =========================================
   PLAYER TYPES
========================================= */

const PLAYER_TYPES = [
  "Batsman",
  "Bowler",
  "All-rounder",
  "Wicketkeeper",
];


const BATTING_HANDS = [
  "Right hand",
  "Left hand",
];


const BATTING_POSITIONS = [
  "Opener",
  "Middle order",
  "Finisher",
];


const BOWLING_HANDS = [
  "Right hand",
  "Left hand",
];


const BOWLING_STYLES = [
  "Medium pacer",
  "Fast pacer",
  "Spinner",
];


/* =========================================
   STAT CARD
   (same card used on the Profile page)
========================================= */

function StatCard({
  icon,
  label,
  value,
}) {

  return (

    <div className="profile-stat-card">

      {icon && (

        <div className="profile-stat-card-icon">
          {icon}
        </div>

      )}


      <div className="profile-stat-card-content">

        <span>
          {label}
        </span>


        <strong>
          {value}
        </strong>

      </div>

    </div>

  );

}


/* =========================================
   GET MATCH NAME
========================================= */

function getMatchName(match) {

  if (!match) {
    return "Match not available";
  }


  const teamA =
    match.teamAName ||
    match.teamA ||
    "Team A";


  const teamB =
    match.teamBName ||
    match.teamB ||
    "Team B";


  return `${teamA} vs ${teamB}`;

}


/* =========================================
   PLAYER CAREER STATISTICS
   -----------------------------------------
   Built from the SAME saved scorecards that
   the match scorecard screen shows
   (firstInningsData / secondInningsData /
   live scoringState of every match), so the
   numbers always agree with the scorecard.

   The battingStats / bowlingStats collections
   are only used as a fallback for a match
   that has no saved scorecard.
========================================= */

const idString = (value) =>
  String(value ?? "").trim();


/* Innings of a match, exactly like the match scorecard builds them */

const getMatchInnings = (match) => {

  const isTestMatch =
    String(match?.matchType || "").toLowerCase() === "test";

  /*
   * Test matches persist each innings in testInnings. Unlike a
   * limited-overs match, a player can have batting and bowling
   * records in more than one innings, so all persisted innings
   * must be included in the career totals.
   */
  if (isTestMatch) {
    const persistedTestInnings =
      Array.isArray(match?.testInnings)
        ? match.testInnings
        : Array.isArray(match?.innings)
          ? match.innings
          : [];

    if (persistedTestInnings.length) {
      const currentIndex = Number(match?.scoringState?.inningsIndex);
      const liveState = match?.scoringState;
      if (
        liveState?.battingStats &&
        Number.isInteger(currentIndex) &&
        currentIndex >= 0
      ) {
        return [
          ...persistedTestInnings.filter(
            (inning) => Number(inning?.inningsIndex) !== currentIndex
          ),
          {
            ...persistedTestInnings.find(
              (inning) => Number(inning?.inningsIndex) === currentIndex
            ),
            inningsIndex: currentIndex,
            battingStats: liveState.battingStats,
            bowlingStats: liveState.bowlingStats || {},
            deliveries: liveState.deliveries || [],
          },
        ].sort(
          (left, right) =>
            Number(left?.inningsIndex || 0) - Number(right?.inningsIndex || 0)
        );
      }
      return persistedTestInnings;
    }
  }

  const savedState =
    match?.scoringState || {};


  const liveInnings =
    savedState.battingStats
      ? {
          battingStats:
            savedState.battingStats,
          bowlingStats:
            savedState.bowlingStats || {},
        }
      : null;


  const first =
    match?.firstInningsData ||
    (
      Number(savedState.inningsIndex) === 0
        ? liveInnings
        : null
    );


  const second =
    match?.secondInningsData ||
    (
      Number(savedState.inningsIndex) === 1
        ? liveInnings
        : null
    );


  return [first, second].filter(Boolean);

};


/* Find one player's stat inside an innings stat map */

const findPlayerStat = (
  statMap,
  playerIds
) => {

  if (
    !statMap ||
    typeof statMap !== "object"
  ) {
    return null;
  }


  for (const id of playerIds) {

    if (statMap[id]) {
      return statMap[id];
    }

  }


  for (const stat of Object.values(statMap)) {

    if (
      stat &&
      playerIds.has(
        idString(
          stat.id ??
          stat.playerId ??
          stat.uid
        )
      )
    ) {
      return stat;
    }

  }


  return null;

};


/* Team roster of a match */

const getRosterIds = (
  team,
  fallbackPlayers
) => {

  const list =
    Array.isArray(team?.players) &&
    team.players.length
      ? team.players
      : Array.isArray(fallbackPlayers)
        ? fallbackPlayers
        : [];


  return new Set(
    list.map((player) =>
      idString(
        typeof player === "object"
          ? (
              player?.id ??
              player?.uid ??
              player?._id ??
              player?.playerId
            )
          : player
      )
    )
  );

};


const computePlayerStatistics = ({
  playerIds,
  battingStats = [],
  bowlingStats = [],
  matches = [],
  tournaments = [],
  playerStrength = "0.0",
}) => {

  /* ---------- MATCH LOOKUP FOR FALLBACK ---------- */

  const collectionBatting =
    new Map();

  battingStats.forEach((stat) => {

    if (
      !playerIds.has(
        idString(
          stat.playerId ||
          stat.uid ||
          stat.id
        )
      )
    ) {
      return;
    }


    const key =
      idString(stat.matchId);


    if (!key) {
      return;
    }


    collectionBatting.set(
      key,
      [
        ...(collectionBatting.get(key) || []),
        stat,
      ]
    );

  });


  const collectionBowling =
    new Map();

  bowlingStats.forEach((stat) => {

    if (
      !playerIds.has(
        idString(
          stat.playerId ||
          stat.uid ||
          stat.id
        )
      )
    ) {
      return;
    }


    const key =
      idString(stat.matchId);


    if (!key) {
      return;
    }


    collectionBowling.set(
      key,
      [
        ...(collectionBowling.get(key) || []),
        stat,
      ]
    );

  });


  /* ---------- TOTALS ---------- */

  let battingRuns = 0;

  let ballsFaced = 0;

  let timesOut = 0;

  let twentyRunInnings = 0;

  let highestScore = 0;

  let highestScoreMatch =
    "—";


  let totalBowls = 0;

  let maidens = 0;

  let wickets = 0;

  let runsConceded = 0;

  let threeWicketHauls = 0;

  let bestBowlingWickets = 0;

  let bestBowlingRuns = Infinity;

  let bestBowlingMatch =
    "—";


  let totalMatches = 0;

  let wins = 0;

  let losses = 0;


  const addBatting = ({
    runs,
    balls,
    isOut,
    match,
  }) => {

    battingRuns += runs;

    ballsFaced += balls;

    if (isOut) {

      timesOut += 1;

    }


    if (runs >= 20) {

      twentyRunInnings += 1;

    }


    if (runs > highestScore) {

      highestScore = runs;

      highestScoreMatch =
        getMatchName(match);

    }

  };


  const addBowling = ({
    legalBalls,
    runs,
    wicketCount,
    maidenCount,
    match,
  }) => {

    totalBowls += legalBalls;

    runsConceded += runs;

    wickets += wicketCount;

    maidens += maidenCount;

    if (wicketCount >= 3) {

      threeWicketHauls += 1;

    }


    if (
      wicketCount > bestBowlingWickets ||
      (
        wicketCount > 0 &&
        wicketCount === bestBowlingWickets &&
        runs < bestBowlingRuns
      )
    ) {

      bestBowlingWickets =
        wicketCount;

      bestBowlingRuns =
        runs;

      bestBowlingMatch =
        getMatchName(match);

    }

  };


  /* ---------- EVERY MATCH ---------- */

  matches.forEach((match) => {

    const matchKey =
      idString(
        match.matchId ||
        match.id
      );


    const rosterA =
      getRosterIds(
        match.teamA,
        match.teamAPlayers
      );


    const rosterB =
      getRosterIds(
        match.teamB,
        match.teamBPlayers
      );


    const inTeamA =
      [...playerIds].some(
        (id) => rosterA.has(id)
      );


    const inTeamB =
      [...playerIds].some(
        (id) => rosterB.has(id)
      );


    let playedInMatch =
      inTeamA ||
      inTeamB;


    const innings =
      getMatchInnings(match);


    let foundInScorecard =
      false;


    if (innings.length) {

      innings.forEach((inning) => {

        /* ----- batting ----- */

        const bat =
          findPlayerStat(
            inning.battingStats,
            playerIds
          );


        if (bat) {

          const runs =
            Number(bat.runs) || 0;

          const balls =
            Number(bat.balls) || 0;

          const status =
            String(
              bat.status || ""
            ).toLowerCase();


          const hasBatted =
            status !== "yet" ||
            balls > 0 ||
            runs > 0;


          if (hasBatted) {

            foundInScorecard = true;

            addBatting({
              runs,
              balls,
              isOut:
                status === "out" ||
                status === "dismissed",
              match,
            });

          }

        }


        /* ----- bowling ----- */

        const bowl =
          findPlayerStat(
            inning.bowlingStats,
            playerIds
          );


        if (bowl) {

          const legalBalls =
            Number(
              bowl.legalBalls ??
              bowl.balls
            ) || 0;

          const runs =
            Number(
              bowl.runs ??
              bowl.runsConceded
            ) || 0;

          const wicketCount =
            Number(bowl.wickets) || 0;


          if (
            legalBalls ||
            runs ||
            wicketCount
          ) {

            foundInScorecard = true;

            addBowling({
              legalBalls,
              runs,
              wicketCount,
              maidenCount:
                Number(bowl.maidens) || 0,
              match,
            });

          }

        }

      });

    } else {

      /* Fallback: match without a saved scorecard */

      (collectionBatting.get(matchKey) || [])
        .forEach((stat) => {

          const runs =
            Number(stat.runs) || 0;

          const balls =
            Number(stat.balls) || 0;

          const status =
            String(
              stat.status || ""
            ).toLowerCase();


          if (
            status === "yet" &&
            !balls &&
            !runs
          ) {
            return;
          }


          foundInScorecard = true;

          addBatting({
            runs,
            balls,
            isOut:
              status === "out" ||
              status === "dismissed" ||
              String(
                stat.dismissalType || ""
              ).length > 0,
            match,
          });

        });


      (collectionBowling.get(matchKey) || [])
        .forEach((stat) => {

          const legalBalls =
            Number(
              stat.legalBalls ??
              stat.balls
            ) || 0;

          const runs =
            Number(
              stat.runs ??
              stat.runsConceded
            ) || 0;

          const wicketCount =
            Number(stat.wickets) || 0;


          if (
            !legalBalls &&
            !runs &&
            !wicketCount
          ) {
            return;
          }


          foundInScorecard = true;

          addBowling({
            legalBalls,
            runs,
            wicketCount,
            maidenCount:
              Number(stat.maidens) || 0,
            match,
          });

        });

    }


    if (foundInScorecard) {

      playedInMatch = true;

    }


    if (!playedInMatch) {

      return;

    }


    totalMatches += 1;


    /* ----- win / loss (only for a decided match, and only when
           the player belongs to exactly one side) ----- */

    if (
      inTeamA === inTeamB
    ) {

      return;

    }


    const teamId =
      inTeamA
        ? "a"
        : "b";


    const teamName =
      String(
        (
          inTeamA
            ? (
                match.teamAName ||
                match.teamA?.name
              )
            : (
                match.teamBName ||
                match.teamB?.name
              )
        ) ||
        ""
      ).trim().toLowerCase();


    const winnerName =
      String(
        match.winnerName ||
        match.winner ||
        match.result?.winner ||
        ""
      ).trim().toLowerCase();


    const winnerId =
      String(
        match.winnerId ||
        match.result?.winnerId ||
        ""
      ).trim().toLowerCase();


    const resultText =
      String(
        match.resultText ||
        (
          typeof match.result === "string"
            ? match.result
            : match.result?.text
        ) ||
        ""
      ).trim().toLowerCase();


    if (
      /live|ongoing|upcoming|draw|tie|not started/.test(
        String(match.status || "").toLowerCase() +
        " " +
        resultText
      )
    ) {

      return;

    }


    if (
      !winnerName &&
      !winnerId &&
      !resultText
    ) {

      return;

    }


    let isWinner;

    if (winnerId) {

      isWinner =
        winnerId === teamId ||
        winnerId === teamName;

    } else if (winnerName) {

      isWinner =
        winnerName === teamName ||
        winnerName === teamId;

    } else {

      isWinner =
        Boolean(teamName) &&
        resultText.includes(
          `${teamName} won`
        );

    }


    if (isWinner) {

      wins += 1;

    } else {

      losses += 1;

    }

  });


  /* ---------- DERIVED VALUES ---------- */

  const strikeRate =
    ballsFaced > 0
      ? (
          (battingRuns /
            ballsFaced) *
          100
        ).toFixed(2)
      : "0.00";


  /*
   * Cricket rule: career runs divided by times dismissed.
   * Not-out innings add runs but no dismissal.
   */

  const battingAverage =
    timesOut > 0
      ? (
          battingRuns /
          timesOut
        ).toFixed(2)
      : "—";


  const economy =
    totalBowls > 0
      ? (
          (runsConceded /
            totalBowls) *
          6
        ).toFixed(2)
      : "0.00";


  const decidedMatches =
    wins + losses;


  const winPercentage =
    decidedMatches > 0
      ? (
          (wins /
            decidedMatches) *
          100
        ).toFixed(2)
      : "0.00";


  const losePercentage =
    decidedMatches > 0
      ? (
          (losses /
            decidedMatches) *
          100
        ).toFixed(2)
      : "0.00";


  return {

    battingRuns,

    ballsFaced,

    strikeRate,

    battingAverage,

    timesOut,

    twentyRunInnings,

    highestScore,

    highestScoreMatch,

    totalBowls,

    maidens,

    economy,

    wickets,

    threeWicketHauls,

    bestBowlingWickets,

    bestBowlingMatch,

    totalMatches,

    playerStrength,

    wins,

    losses,

    winPercentage,

    losePercentage,

    ...getCareerMatchStats({
      playerIds,
      matches,
      tournaments,
    }),

  };

};


function Players() {

  /* =========================================
     PLAYERS
  ========================================= */

  const [players, setPlayers] = useState([]);
  const [battingStats, setBattingStats] = useState([]);
  const [bowlingStats, setBowlingStats] = useState([]);


  /* =========================================
     MATCH DATA
     (loaded only when a player is first viewed,
      used for matches played / results)
  ========================================= */

  const [matchesData, setMatchesData] =
    useState([]);

  const [tournamentsData, setTournamentsData] =
    useState([]);

  const [matchDataLoaded, setMatchDataLoaded] =
    useState(false);

  const [loadingMatchData, setLoadingMatchData] =
    useState(false);

  const [matchDataError, setMatchDataError] =
    useState("");


  /* =========================================
     UI STATE
  ========================================= */

  const [search, setSearch] =
    useState("");

  const [showModal, setShowModal] =
    useState(false);

  const [showPlayer, setShowPlayer] =
    useState(false);

  const [selectedPlayer, setSelectedPlayer] =
    useState(null);

  const [deletePlayer, setDeletePlayer] =
    useState(null);


  /* =========================================
     FORM
  ========================================= */

  const emptyForm = {

    name: "",

    type: "",

    email: "",

    password:
      DEFAULT_PASSWORD,

    battingHand: "",

    battingPosition: "",

    bowlingHand: "",

    bowlingStyle: "",

  };


  const [form, setForm] =
    useState(emptyForm);


  /* =========================================
     LOADING STATE
  ========================================= */

  const [loading, setLoading] =
    useState(true);


  const [saving, setSaving] =
    useState(false);


  /* =========================================
     LOAD PLAYERS FROM FIRESTORE
     
     Realtime listener
  ========================================= */

  useEffect(() => {

    const playersRef =
      collection(
        db,
        "players"
      );


    Promise.all([
      getDocs(playersRef),
      getDocs(collection(db, "battingStats")),
      getDocs(collection(db, "bowlingStats")),
    ]).then(([snapshot, battingSnapshot, bowlingSnapshot]) => {

          const firestorePlayers =
            snapshot.docs.map(
              (document) => ({

                id:
                  document.id,

                uid:
                  document.id,

                ...document.data(),

              })
            );


          const normalized =
            normalizePlayers(
              firestorePlayers
            );


          setPlayers(
            normalized
          );
          setBattingStats(
            battingSnapshot.docs.map((item) => ({
              id: item.id,
              ...item.data(),
            }))
          );
          setBowlingStats(
            bowlingSnapshot.docs.map((item) => ({
              id: item.id,
              ...item.data(),
            }))
          );


          setLoading(false);

        }).catch((error) => {
          console.error("Error loading players:", error);
          alert("Unable to load players from Firebase.");
          setLoading(false);
        });

  }, []);


  /* =========================================
     LOAD MATCH DATA WHEN A PLAYER IS VIEWED
     (once, then reused for every player)
  ========================================= */

  useEffect(() => {

    if (
      !showPlayer ||
      !selectedPlayer ||
      matchDataLoaded ||
      loadingMatchData ||
      matchDataError
    ) {
      return;
    }


    setLoadingMatchData(true);


    getDocs(
      collection(db, "matches")
    ).then((matchesSnapshot) => {

      setMatchesData(
        matchesSnapshot.docs.map((item) => ({
          ...item.data(),
          id: item.id,
        }))
      );

      return getDocs(collection(db, "tournaments"));

    }).catch((error) => {

      console.error(
        "Error loading player match statistics:",
        error
      );

      setMatchDataError(
        "Unable to load match statistics from Firebase."
      );

    }).then((tournamentsSnapshot) => {
      if (tournamentsSnapshot) {
        setTournamentsData(
          tournamentsSnapshot.docs.map((item) => ({
            ...item.data(),
            id: item.id,
          }))
        );
      }
      setMatchDataLoaded(true);
    }).finally(() => {

      setLoadingMatchData(false);

    });

  }, [
    showPlayer,
    selectedPlayer,
    matchDataLoaded,
    loadingMatchData,
    matchDataError,
  ]);

  const getPlayerStrength = (player) => {
    const playerId = String(
      player?.id ||
        player?.uid ||
        player?.playerId ||
        ""
    );
    const batting = battingStats.filter(
      (stat) =>
        String(stat.playerId || stat.uid || "") === playerId
    );
    const bowling = bowlingStats.filter(
      (stat) =>
        String(stat.playerId || stat.uid || "") === playerId
    );
    const matchIds = new Set(
      [...batting, ...bowling]
        .map((stat) => stat.matchId || stat.matchID || stat.id)
        .filter(Boolean)
        .map(String)
    );
    const matchesPlayed =
      matchIds.size ||
      Number(player?.matchesPlayed || player?.matches || 0);
    const runs = batting.reduce(
      (sum, stat) => sum + Number(stat.runs || 0),
      0
    );
    const wickets = bowling.reduce(
      (sum, stat) => sum + Number(stat.wickets || 0),
      0
    );
    return matchesPlayed > 0
      ? calculateStrengthPoints({
          runs,
          wickets,
          matchesPlayed,
        })
      : 0;
  };

  const formatStrength = (value) =>
    Number(value || 0).toFixed(1);


  /* =========================================
     OPEN ADD PLAYER
  ========================================= */

  const openAddModal = () => {

    setForm(emptyForm);

    setShowModal(true);

  };


  /* =========================================
     CLOSE ADD MODAL
  ========================================= */

  const closeModal = () => {

    setShowModal(false);

    setForm(emptyForm);

  };


  /* =========================================
     INPUT CHANGE
  ========================================= */

  const handleChange = (e) => {

    const {
      name,
      value,
    } = e.target;


    setForm((prev) => ({

      ...prev,

      [name]: value,

    }));

  };


  /* =========================================
     PLAYER TYPE CHANGE
  ========================================= */

  const handleTypeChange = (e) => {

    const type =
      e.target.value;


    setForm((prev) => ({

      ...prev,

      type,

      battingHand: "",
      battingPosition: "",

      bowlingHand: "",
      bowlingStyle: "",

    }));

  };


  /* =========================================
     CHECK PLAYER TYPE
  ========================================= */

  const isBattingType =
    form.type === "Batsman" ||
    form.type === "All-rounder" ||
    form.type === "Wicketkeeper";


  const isBowlingType =
    form.type === "Bowler" ||
    form.type === "All-rounder";


  /* =========================================
     SUBMIT PLAYER
  ========================================= */

  const handleSubmit = async (e) => {

    e.preventDefault();


    if (saving) {
      return;
    }


    /* -----------------------------------------
       BASIC VALIDATION
    ----------------------------------------- */

    if (!form.name.trim()) {

      alert(
        "Please enter player name."
      );

      return;

    }

    const playerName =
      form.name
        .trim()
        .replace(/\s+/g, " ");

    const normalizedPlayerName =
      playerName.toLowerCase();

    const duplicatePlayer =
      players.some(
        (player) =>
          String(player.name || "")
            .trim()
            .replace(/\s+/g, " ")
            .toLowerCase() ===
          normalizedPlayerName
      );

    if (duplicatePlayer) {

      alert(
        "A player with this name already exists."
      );

      return;

    }


    if (!form.type) {

      alert(
        "Please select player type."
      );

      return;

    }


    const trimmedEmail =
      form.email
        .trim()
        .toLowerCase();


    if (!trimmedEmail) {

      alert(
        "Please enter email address."
      );

      return;

    }


    /* -----------------------------------------
       EMAIL VALIDATION
    ----------------------------------------- */

    const emailRegex =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


    if (!emailRegex.test(trimmedEmail)) {

      alert(
        "Please enter a valid email address."
      );

      return;

    }


    /* -----------------------------------------
       PASSWORD
    ----------------------------------------- */

    const playerPassword =
      form.password ||
      DEFAULT_PASSWORD;


    if (playerPassword.length < 6) {

      alert(
        "Password must be at least 6 characters."
      );

      return;

    }


    /* -----------------------------------------
       DUPLICATE EMAIL CHECK
       
       This checks the players already
       stored in Firestore.
    ----------------------------------------- */

    const duplicateEmail =
      players.some(

        (player) =>

          String(player.id) !==
            ADMIN_UID &&

          String(
            player.email || ""
          )
            .trim()
            .toLowerCase() ===
            trimmedEmail

      );


    if (duplicateEmail) {

      alert(
        "This email is already registered."
      );

      return;

    }


    /* -----------------------------------------
       BATTING VALIDATION
    ----------------------------------------- */

    if (isBattingType) {

      if (!form.battingHand) {

        alert(
          "Please select batting hand."
        );

        return;

      }


      if (!form.battingPosition) {

        alert(
          "Please select batting position."
        );

        return;

      }

    }


    /* -----------------------------------------
       BOWLING VALIDATION
    ----------------------------------------- */

    if (isBowlingType) {

      if (!form.bowlingHand) {

        alert(
          "Please select bowling hand."
        );

        return;

      }


      if (!form.bowlingStyle) {

        alert(
          "Please select bowling style."
        );

        return;

      }

    }


    /* -----------------------------------------
       SAVE
    ----------------------------------------- */

    setSaving(true);


    try {

      /* =======================================
         CREATE FIREBASE AUTH USER
      ======================================= */

      const playerAuth =
        getPlayerCreationAuth();


      const userCredential =
        await createUserWithEmailAndPassword(
          playerAuth,
          trimmedEmail,
          playerPassword
        );


      const user =
        userCredential.user;


      /* =======================================
         CREATE COMPLETE FIRESTORE PROFILE
      ======================================= */

      const playerData = {

        uid: user.uid,

        id: user.uid,

        name:
          playerName,

        email:
          trimmedEmail,

        type:
          form.type,

        battingHand:
          form.battingHand ||
          null,

        battingPosition:
          form.battingPosition ||
          null,

        bowlingHand:
          form.bowlingHand ||
          null,

        bowlingStyle:
          form.bowlingStyle ||
          null,

        createdAt:
          serverTimestamp(),

      };


      await setDoc(

        doc(
          db,
          "players",
          user.uid
        ),

        playerData

      );


      /* =======================================
         CLOSE MODAL
      ======================================= */

      closeModal();


      alert(
        "Player added successfully."
      );


    } catch (error) {

      console.error(
        "Error adding player:",
        error
      );


      /* ---------------------------------------
         FIREBASE AUTH ERRORS
      --------------------------------------- */

      if (
        error.code ===
        "auth/email-already-in-use"
      ) {

        alert(
          "This email is already registered."
        );

      } else if (
        error.code ===
        "auth/invalid-email"
      ) {

        alert(
          "Please enter a valid email address."
        );

      } else if (
        error.code ===
        "auth/weak-password"
      ) {

        alert(
          "Password must be at least 6 characters."
        );

      } else if (
        error.code ===
        "permission-denied"
      ) {

        alert(
          "Firebase permission denied. Please check Firestore Rules."
        );

      } else {

        alert(
          error.message ||
          "Unable to add player."
        );

      }

    } finally {

      setSaving(false);

    }

  };


  /* =========================================
     DELETE PLAYER
  ========================================= */

  const handleDelete = async () => {

    if (!deletePlayer) {
      return;
    }


    try {
      await saveLastAdminDelete({
        type: "player",
        documents: [{
          collection: "players",
          id: deletePlayer.uid || deletePlayer.id,
          data: deletePlayer,
        }],
      });

      /* ---------------------------------------
         DELETE FIRESTORE PROFILE
      --------------------------------------- */

      await deleteDoc(

        doc(
          db,
          "players",
          deletePlayer.uid ||
          deletePlayer.id
        )

      );


      /* ---------------------------------------
         CLOSE VIEW IF OPEN
      --------------------------------------- */

      if (

        selectedPlayer &&

        selectedPlayer.id ===
          deletePlayer.id

      ) {

        setSelectedPlayer(null);

        setShowPlayer(false);

      }


      setDeletePlayer(null);


    } catch (error) {

      console.error(
        "Error deleting player:",
        error
      );


      alert(
        error.message ||
        "Unable to delete player."
      );

    }

  };


  /* =========================================
     SEARCH
  ========================================= */

const isAdmin =
  Boolean(ADMIN_UID) &&
  auth.currentUser?.uid === ADMIN_UID;

  const maskEmail = (
    email = ""
  ) => {

    if (!email) {
      return "-";
    }


    const parts =
      email.split("@");


    if (parts.length !== 2) {
      return email;
    }


    const username =
      parts[0];

    const domain =
      parts[1];


    if (username.length <= 2) {

      return (
        `${username[0] || ""}***@${domain}`
      );

    }


    return (
      `${username.slice(0, 2)}***@${domain}`
    );

  };


  /* =========================================
     REMOVE ADMIN FROM PLAYER LIST
  ========================================= */

  const visiblePlayers =
    players.filter(

      (player) =>
        String(player.id) !==
        ADMIN_UID

    );


  /* =========================================
     FILTER
  ========================================= */

  const filteredPlayers =
    visiblePlayers.filter(

      (player) =>
        player.name
          .toLowerCase()
          .includes(
            search.toLowerCase()
          )

    );


  /* =========================================
     CAREER STATISTICS OF THE VIEWED PLAYER
  ========================================= */

  const statistics =
    showPlayer &&
    selectedPlayer &&
    matchDataLoaded
      ? computePlayerStatistics({
          playerIds:
            new Set(
              [
                selectedPlayer.uid,
                selectedPlayer.id,
              ]
                .filter(Boolean)
                .map(idString)
            ),
          battingStats,
          bowlingStats,
          matches:
            matchesData,
          tournaments: tournamentsData,
          playerStrength:
            formatStrength(
              getPlayerStrength(
                selectedPlayer
              )
            ),
        })
      : null;


  /* =========================================
     JSX
  ========================================= */

  return (

    <div className="page players-page">


      {/* =====================================
          HEADER
      ===================================== */}

      <div className="page-header">

        <div>

          <p className="eyebrow">
            PLAYER MANAGEMENT
          </p>


          <h2>
            Players
          </h2>


          <p className="subtitle">

            {players.length}{" "}

            {players.length === 1
              ? "player"
              : "players"}{" "}

            registered

          </p>

        </div>


        <button
          className="add-button"
          onClick={openAddModal}
        >

          ＋Add player


        </button>

      </div>


      {/* =====================================
          SEARCH
      ===================================== */}

      <div className="search-box">

        <span>
          🔍
        </span>


        <input
          type="text"
          placeholder="Search players..."
          value={search}
          onChange={(e) =>
            setSearch(
              e.target.value
            )
          }
        />


        {search && (

          <button
            type="button"
            className="clear-search"
            onClick={() =>
              setSearch("")
            }
          >
            ×
          </button>

        )}

      </div>


      {/* =====================================
          LOADING
      ===================================== */}

      {loading ? (
        <LoadingOverlay message="Fetching player data..." inline />

      ) : players.length === 0 ? (


        /* =====================================
           EMPTY
        ===================================== */

        <div className="empty-card">

          <div className="empty-icon">
            👤
          </div>


          <h3>
            No players yet
          </h3>


          <p>
            Add your first player to start
            building your local cricket
            database.
          </p>


          <button
            className="primary-button"
            onClick={openAddModal}
          >
            ＋ Add Player
          </button>

        </div>


      ) : filteredPlayers.length === 0 ? (


        /* =====================================
           NO SEARCH RESULT
        ===================================== */

        <div className="empty-card">

          <div className="empty-icon">
            🔍
          </div>


          <h3>
            No player found
          </h3>


          <p>
            No player matches "{search}".
          </p>


          <button
            className="secondary-button"
            onClick={() =>
              setSearch("")
            }
          >
            Clear Search
          </button>

        </div>


      ) : (


        /* =====================================
           PLAYER LIST
        ===================================== */

        <div className="players-list">

          {filteredPlayers.map(
            (player) => (

              <div
                className="player-card"
                key={player.id}
              >


                {/* PLAYER AVATAR */}

                <div className="player-avatar">

                  {player.name
                    .charAt(0)
                    .toUpperCase()}

                </div>


                {/* PLAYER INFORMATION */}

                <div className="player-info">

                  <h3>
                    {player.name}
                  </h3>


                  <span className="player-type">

                    {player.type}

                  </span>

                  <span className="player-strength">
                    Strength:{" "}
                    {formatStrength(
                      getPlayerStrength(player)
                    )}
                  </span>


                  <div className="player-tags">


                    {player.battingHand && (

                      <span>

                        🏏{" "}

                        {player.battingHand}

                      </span>

                    )}


                    {player.battingPosition && (

                      <span>

                        {player.battingPosition}

                      </span>

                    )}


                    {player.bowlingHand && (

                      <span>

                        ⚾{" "}

                        {player.bowlingHand}

                      </span>

                    )}


                    {player.bowlingStyle && (

                      <span>

                        {player.bowlingStyle}

                      </span>

                    )}

                  </div>

                </div>


                {/* ACTIONS */}

                <div className="player-actions">


                  <button
                    className="view-button"
                    onClick={() => {

                      setSelectedPlayer(
                        player
                      );

                      setShowPlayer(true);

                    }}
                  >

                    View

                  </button>


                  {isAdmin && (

                    <button
                      className="delete-button"
                      onClick={() =>
                        setDeletePlayer(
                          player
                        )
                      }
                    >

                      🗑

                    </button>

                  )}

                </div>

              </div>

            )
          )}

        </div>

      )}


      {/* =====================================
          ADD PLAYER MODAL
      ===================================== */}

      {showModal && (

        <div
          className="modal-overlay"
          onMouseDown={(e) => {

            if (
              e.target ===
              e.currentTarget
            ) {

              closeModal();

            }

          }}
        >

          <div className="modal">


            {/* MODAL HEADER */}

            <div className="modal-header">

              <div>

                <p className="eyebrow">
                  PLAYER
                </p>


                <h3>
                  Add Player
                </h3>

              </div>


              <button
                type="button"
                className="modal-close"
                onClick={closeModal}
              >
                ×
              </button>

            </div>


            <form
              onSubmit={handleSubmit}
            >


              {/* =================================
                  PLAYER NAME
              ================================= */}

              <div className="form-group">

                <label>

                  Player name{" "}

                  <span className="required">
                    *
                  </span>

                </label>


                <input
                  type="text"
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  placeholder="Enter player name"
                  autoFocus
                />

              </div>


              {/* =================================
                  PLAYER TYPE
              ================================= */}

              <div className="form-group">

                <label>

                  Player type{" "}

                  <span className="required">
                    *
                  </span>

                </label>


                <select
                  name="type"
                  value={form.type}
                  onChange={handleTypeChange}
                >

                  <option value="">
                    Select player type
                  </option>


                  {PLAYER_TYPES.map(
                    (type) => (

                      <option
                        value={type}
                        key={type}
                      >

                        {type}

                      </option>

                    )
                  )}

                </select>

              </div>


              {/* =================================
                  EMAIL
              ================================= */}

              <div className="form-group">

                <label>

                  Email{" "}

                  <span className="required">
                    *
                  </span>

                </label>


                <input
                  type="email"
                  name="email"
                  value={form.email}
                  onChange={handleChange}
                  placeholder="Enter email address"
                  autoComplete="email"
                />

              </div>


              {/* =================================
                  PASSWORD
              ================================= */}

              <div className="form-group">

                <label>

                  Password{" "}

                  <span className="required">
                    *
                  </span>

                </label>


                <input
                  type="text"
                  name="password"
                  value={form.password}
                  readOnly
                  onChange={handleChange}
                />

              </div>


              {/* =================================
                  BATTING SECTION
              ================================= */}

              {isBattingType && (

                <div className="form-section">

                  <h4>
                    Batting
                  </h4>


                  {/* BATTING HAND */}

                  <div className="form-group">

                    <label>

                      Batting hand{" "}

                      <span className="required">
                        *
                      </span>

                    </label>


                    <div className="choice-grid">

                      {BATTING_HANDS.map(
                        (hand) => (

                          <button
                            type="button"
                            key={hand}
                            className={
                              form.battingHand ===
                              hand
                                ? "choice-button selected"
                                : "choice-button"
                            }
                            onClick={() =>
                              setForm(
                                (prev) => ({
                                  ...prev,
                                  battingHand:
                                    hand,
                                })
                              )
                            }
                          >

                            {hand}

                          </button>

                        )
                      )}

                    </div>

                  </div>


                  {/* BATTING POSITION */}

                  <div className="form-group">

                    <label>

                      Batting position{" "}

                      <span className="required">
                        *
                      </span>

                    </label>


                    <div className="choice-grid">

                      {BATTING_POSITIONS.map(
                        (position) => (

                          <button
                            type="button"
                            key={position}
                            className={
                              form.battingPosition ===
                              position
                                ? "choice-button selected"
                                : "choice-button"
                            }
                            onClick={() =>
                              setForm(
                                (prev) => ({
                                  ...prev,
                                  battingPosition:
                                    position,
                                })
                              )
                            }
                          >

                            {position}

                          </button>

                        )
                      )}

                    </div>

                  </div>

                </div>

              )}


              {/* =================================
                  BOWLING SECTION
              ================================= */}

              {isBowlingType && (

                <div className="form-section">

                  <h4>
                    Bowling
                  </h4>


                  {/* BOWLING HAND */}

                  <div className="form-group">

                    <label>

                      Bowling hand{" "}

                      <span className="required">
                        *
                      </span>

                    </label>


                    <div className="choice-grid">

                      {BOWLING_HANDS.map(
                        (hand) => (

                          <button
                            type="button"
                            key={hand}
                            className={
                              form.bowlingHand ===
                              hand
                                ? "choice-button selected"
                                : "choice-button"
                            }
                            onClick={() =>
                              setForm(
                                (prev) => ({
                                  ...prev,
                                  bowlingHand:
                                    hand,
                                })
                              )
                            }
                          >

                            {hand}

                          </button>

                        )
                      )}

                    </div>

                  </div>


                  {/* BOWLING STYLE */}

                  <div className="form-group">

                    <label>

                      Bowling style{" "}

                      <span className="required">
                        *
                      </span>

                    </label>


                    <div className="choice-grid">

                      {BOWLING_STYLES.map(
                        (style) => (

                          <button
                            type="button"
                            key={style}
                            className={
                              form.bowlingStyle ===
                              style
                                ? "choice-button selected"
                                : "choice-button"
                            }
                            onClick={() =>
                              setForm(
                                (prev) => ({
                                  ...prev,
                                  bowlingStyle:
                                    style,
                                })
                              )
                            }
                          >

                            {style}

                          </button>

                        )
                      )}

                    </div>

                  </div>

                </div>

              )}


              {/* =================================
                  SAVE
              ================================= */}

              <button
                type="submit"
                className="primary-button"
                disabled={saving}
              >

                {saving
                  ? "Saving..."
                  : "Save Player"}

              </button>

            </form>

          </div>

        </div>

      )}


      {/* =====================================
          VIEW PLAYER
      ===================================== */}

      {showPlayer &&
        selectedPlayer && (

          <div
            className="modal-overlay"
            onMouseDown={(e) => {

              if (
                e.target ===
                e.currentTarget
              ) {

                setShowPlayer(false);

              }

            }}
          >

            <div className="modal player-details-modal">


              {/* HEADER */}

              <div className="modal-header">

                <div className="player-detail-heading">


                  <div className="large-player-avatar">

                    {selectedPlayer.name
                      .charAt(0)
                      .toUpperCase()}

                  </div>


                  <div>

                    <p className="eyebrow">
                      PLAYER PROFILE
                    </p>


                    <h3>
                      {selectedPlayer.name}
                    </h3>

                  </div>

                </div>


                <button
                  type="button"
                  className="modal-close"
                  onClick={() =>
                    setShowPlayer(false)
                  }
                >

                  ×

                </button>

              </div>


              {/* TYPE */}

              <div className="details-type">

                {selectedPlayer.type}

              </div>

              <div className="details-section">

                <div className="details-grid">

                  <div className="detail-item">

                    <span>
                      Player Strength
                    </span>

                    <strong>
                      {formatStrength(
                        getPlayerStrength(
                          selectedPlayer
                        )
                      )}
                    </strong>

                  </div>

                </div>

              </div>


              {/* =================================
                  CONTACT
              ================================= */}

              <div className="details-section">

                <h4>
                  Contact
                </h4>


                <div className="details-grid">

                  <div className="detail-item">

                    <span>
                      Email
                    </span>


                    <strong>
                      {maskEmail(
                        selectedPlayer.email
                      )}
                    </strong>

                  </div>

                </div>

              </div>


              {/* =================================
                  BATTING DETAILS
              ================================= */}

              {selectedPlayer.battingHand && (

                <div className="details-section">

                  <h4>
                    Batting
                  </h4>


                  <div className="details-grid">

                    <div className="detail-item">

                      <span>
                        Hand
                      </span>


                      <strong>

                        {
                          selectedPlayer
                            .battingHand
                        }

                      </strong>

                    </div>


                    <div className="detail-item">

                      <span>
                        Position
                      </span>


                      <strong>

                        {
                          selectedPlayer
                            .battingPosition
                        }

                      </strong>

                    </div>

                  </div>

                </div>

              )}


              {/* =================================
                  BOWLING DETAILS
              ================================= */}

              {selectedPlayer.bowlingStyle && (

                <div className="details-section">

                  <h4>
                    Bowling
                  </h4>


                  <div className="details-grid">

                    <div className="detail-item">

                      <span>
                        Hand
                      </span>


                      <strong>

                        {
                          selectedPlayer
                            .bowlingHand
                        }

                      </strong>

                    </div>


                    <div className="detail-item">

                      <span>
                        Style
                      </span>


                      <strong>

                        {
                          selectedPlayer
                            .bowlingStyle
                        }

                      </strong>

                    </div>

                  </div>

                </div>

              )}


              {/* =====================================================
                  STATISTICS
                  ===================================================== */}

              <section className="profile-section">

                <div className="profile-section-header">

                  <div>

                    <p className="profile-section-eyebrow">
                      PERFORMANCE
                    </p>


                    <h2>
                      Statistics
                    </h2>


                    <p>
                      Career performance across
                      recorded matches.
                    </p>

                  </div>

                </div>


                {matchDataError && (

                  <div className="profile-message profile-error">

                    ⚠️ {matchDataError}

                  </div>

                )}


                {loadingMatchData && (

                  <p className="match-scorecard-note">
                    Loading statistics...
                  </p>

                )}


                {statistics && (

                <>


                {/* ===================================================
                    OVERALL STATS
                    =================================================== */}

                <div className="profile-stat-grid">

                  <StatCard
                    icon="🏏"
                    label="Matches Played"
                    value={
                      statistics.totalMatches
                    }
                  />


                  <StatCard
                    icon="💪"
                    label="Player Strength"
                    value={
                      statistics.playerStrength
                    }
                  />


                  <StatCard
                    icon="🏆"
                    label="Win Percentage"
                    value={
                      `${statistics.winPercentage}%`
                    }
                  />


                  <StatCard
                    icon="📉"
                    label="Lose Percentage"
                    value={
                      `${statistics.losePercentage}%`
                    }
                  />

                </div>


                {/* ===================================================
                    BATTING
                    =================================================== */}

                <div className="profile-stat-section">

                  <div className="profile-stat-title">

                    <span className="profile-stat-title-icon">
                      🏏
                    </span>


                    <div>

                      <h3>
                        Batting
                      </h3>


                      <p>
                        Career batting performance
                      </p>

                    </div>

                  </div>


                  <div className="profile-stat-grid">

                    <StatCard
                      label="Career Runs"
                      value={
                        statistics.battingRuns
                      }
                    />


                    <StatCard
                      label="Batting Average"
                      value={
                        statistics.battingAverage
                      }
                    />


                    <StatCard
                      label="Strike Rate"
                      value={
                        statistics.strikeRate
                      }
                    />


                    <StatCard
                      label="Times Out"
                      value={
                        statistics.timesOut
                      }
                    />


                    <StatCard
                      label="20+ Run Innings"
                      value={
                        statistics.twentyRunInnings
                      }
                    />

                  </div>


                  <div className="profile-highlight-card">

                    <div className="profile-highlight-icon">
                      🔥
                    </div>


                    <div className="profile-highlight-content">

                      <span>
                        Highest Score
                      </span>


                      <strong>
                        {statistics.highestScore}
                      </strong>


                      <p>
                        {statistics.highestScoreMatch}
                      </p>

                    </div>

                  </div>

                </div>


                {/* ===================================================
                    BOWLING
                    =================================================== */}

                <div className="profile-stat-section">

                  <div className="profile-stat-title">

                    <span className="profile-stat-title-icon">
                      🎯
                    </span>


                    <div>

                      <h3>
                        Bowling
                      </h3>


                      <p>
                        Career bowling performance
                      </p>

                    </div>

                  </div>


                  <div className="profile-stat-grid">

                    <StatCard
                      label="Total Overs"
                      value={
                        formatBowlingOvers(statistics.totalBowls)
                      }
                    />

                    <StatCard
                      label="Maidens"
                      value={
                        statistics.maidens
                      }
                    />


                    <StatCard
                      label="Economy"
                      value={
                        statistics.economy
                      }
                    />


                    <StatCard
                      label="Wickets"
                      value={
                        statistics.wickets
                      }
                    />


                    <StatCard
                      label="3 Wicket Hauls"
                      value={
                        statistics.threeWicketHauls
                      }
                    />

                  </div>


                  <div className="profile-highlight-card">

                    <div className="profile-highlight-icon">
                      🎯
                    </div>


                    <div className="profile-highlight-content">

                      <span>
                        Best Bowling Performance
                      </span>


                      <strong>

                        {statistics.bestBowlingWickets}

                        {" "}

                        {statistics.bestBowlingWickets === 1
                          ? "Wicket"
                          : "Wickets"}

                      </strong>


                      <p>
                        {statistics.bestBowlingMatch}
                      </p>

                    </div>

                  </div>

                </div>


                {/* ===================================================
                    MATCH RESULTS
                    =================================================== */}

                <div className="profile-stat-section">

                  <div className="profile-stat-title">

                    {/* <span className="profile-stat-title-icon">
                      🏆
                    </span> */}


                    {/* <div>

                      <h3>
                        Match Results
                      </h3>


                      <p>
                        Recorded match results
                      </p>

                    </div> */}

                    <div className="profile-stat-section career-format-section">
                      <div className="profile-stat-title">
                        <span className="profile-stat-title-icon">📈</span>
                        <div>
                          <h3>Match & Tournament Record</h3>
                          <p>Results across the player&apos;s recorded career</p>
                        </div>
                      </div>
                      <div className="career-format-grid">
                        <div className="career-format-card"><span>🏏 Test Matches</span><strong>{statistics.testPlayed}</strong><small className="career-result-counts"><b className="career-result-win">{statistics.testWon} won</b><b className="career-result-loss">{statistics.testLost} lost</b><b className="career-result-draw">{statistics.testDraw} drawn</b></small></div>
                        <div className="career-format-card"><span>⚡ Limited Overs</span><strong>{statistics.limitedPlayed}</strong><small className="career-result-counts"><b className="career-result-win">{statistics.limitedWon} won</b><b className="career-result-loss">{statistics.limitedLost} lost</b><b className="career-result-draw">{statistics.limitedDraw} drawn</b></small></div>
                        <div className="career-format-card"><span>🏆 Tournaments</span><strong>{statistics.tournamentPlayed}</strong><small>{statistics.tournamentWon} won • {statistics.tournamentLost} lost</small></div>
                      </div>
                      <div className="career-award-card"><span>🌟</span><div><strong>{statistics.manOfMatch}</strong><small>Man of the Match awards</small></div></div>
                    </div>

                  </div>


                  <div className="profile-result-grid">


                    <div className="profile-result-card">

                      <span className="result-icon">
                        🏆
                      </span>


                      <div>

                        <span>
                          Wins
                        </span>


                        <strong>
                          {statistics.wins}
                        </strong>

                      </div>

                    </div>


                    <div className="profile-result-card">

                      <span className="result-icon">
                        ❌
                      </span>


                      <div>

                        <span>
                          Losses
                        </span>


                        <strong>
                          {statistics.losses}
                        </strong>

                      </div>

                    </div>


                    <div className="profile-result-card">

                      <span className="result-icon">
                        📊
                      </span>


                      <div>

                        <span>
                          Win Rate
                        </span>


                        <strong>
                          {statistics.winPercentage}%
                        </strong>

                      </div>

                    </div>

                  </div>

                </div>

                </>

                )}

              </section>


              {/* CLOSE */}

              <button
                type="button"
                className="secondary-button full-button"
                onClick={() =>
                  setShowPlayer(false)
                }
              >

                Close

              </button>

            </div>

          </div>

        )}


      {/* =====================================
          DELETE CONFIRMATION
      ===================================== */}

      {deletePlayer && (

        <div className="modal-overlay">

          <div className="modal delete-modal">

            <div className="delete-icon">
              🗑
            </div>


            <h3>
              Delete player?
            </h3>


            <p>

              Are you sure you want to
              delete{" "}

              <strong>
                {deletePlayer.name}
              </strong>

              ?

            </p>


            <div className="delete-actions">

              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  setDeletePlayer(null)
                }
              >

                Cancel

              </button>


              <button
                type="button"
                className="danger-button"
                onClick={handleDelete}
              >

                Delete

              </button>

            </div>

          </div>

        </div>

      )}

    </div>

  );

}


export default Players;