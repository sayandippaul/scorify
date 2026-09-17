import { useEffect, useState } from "react";
import "./players.css";

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


import { ADMIN_UID } from "../config/security";
const DEFAULT_PASSWORD = "cricket";


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


function Players() {

  /* =========================================
     PLAYERS
  ========================================= */

  const [players, setPlayers] = useState([]);
  const [battingStats, setBattingStats] = useState([]);
  const [bowlingStats, setBowlingStats] = useState([]);


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
      ? (runs + wickets * 20) / matchesPlayed
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

        <div className="empty-card">

          <div className="empty-icon">
            👤
          </div>

          <h3>
            Loading players...
          </h3>

          <p>
            Fetching player data from Firebase.
          </p>

        </div>

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