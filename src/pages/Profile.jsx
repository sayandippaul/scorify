import React, {
  useEffect,
  useState,
} from "react";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteField,
} from "firebase/firestore";

import {
  signOut,
} from "firebase/auth";

import {
  db,
  auth,
} from "../firebase/firebase";

import "./profile.css";


function Profile({
  user,
  onLogout,
  onUserUpdated,
}) {

  const [profile, setProfile] =
    useState({
      name: user?.name || "",
      email: user?.email || "",
      type: user?.type || "",

      battingHand:
        user?.battingHand || "",

      battingPosition:
        user?.battingPosition || "",

      bowlingHand:
        user?.bowlingHand || "",

      bowlingStyle:
        user?.bowlingStyle || "",
    });


  const [editProfile, setEditProfile] =
    useState({
      name: user?.name || "",
      email: user?.email || "",
      type: user?.type || "",

      battingHand:
        user?.battingHand || "",

      battingPosition:
        user?.battingPosition || "",

      bowlingHand:
        user?.bowlingHand || "",

      bowlingStyle:
        user?.bowlingStyle || "",
    });


  const [isEditing, setIsEditing] =
    useState(false);


  const [savingProfile, setSavingProfile] =
    useState(false);


  const [profileMessage, setProfileMessage] =
    useState("");


  const [profileError, setProfileError] =
    useState("");


  const [statistics, setStatistics] =
    useState({
      battingRuns: 0,
      ballsFaced: 0,
      strikeRate: "0.00",
      battingAverage: "—",
      timesOut: 0,
      twentyRunInnings: 0,

      highestScore: 0,
      highestScoreMatch: "—",

      totalBowls: 0,
      maidens: 0,
      economy: "0.00",
      wickets: 0,
      threeWicketHauls: 0,

      bestBowlingWickets: 0,
      bestBowlingMatch: "—",

      totalMatches: 0,
      playerStrength: "0.0",

      wins: 0,
      losses: 0,
      winPercentage: "0.00",
      losePercentage: "0.00",
    });


  const [loadingStats, setLoadingStats] =
    useState(true);


  const [statsError, setStatsError] =
    useState("");


  /* =========================================================
     FETCH PROFILE + STATISTICS
     ========================================================= */

  useEffect(() => {

    if (!user) {
      return;
    }

    fetchProfileStatistics();

  }, [user?.id, user?.uid]);


  const fetchProfileStatistics =
    async () => {

      try {

        setLoadingStats(true);
        setStatsError("");


        /* =====================================================
           GET FIREBASE AUTH USER
           ===================================================== */

        const currentFirebaseUser =
          auth.currentUser;


        const playerId =
          currentFirebaseUser?.uid ||
          user?.uid ||
          user?.id;


        if (!playerId) {

          setStatsError(
            "Your account could not be identified."
          );

          setLoadingStats(false);

          return;

        }


        /* =====================================================
           FETCH CURRENT PLAYER PROFILE
           ===================================================== */

        const playerRef =
          doc(
            db,
            "players",
            playerId
          );


        const playerSnapshot =
          await getDoc(
            playerRef
          );


        /* =====================================================
           FETCH OTHER STATISTICS
           ===================================================== */

        const [
          matchesSnapshot,
          battingStatsSnapshot,
          bowlingStatsSnapshot,
        ] = await Promise.all([

          getDocs(
            collection(
              db,
              "matches"
            )
          ),

          getDocs(
            collection(
              db,
              "battingStats"
            )
          ),

          getDocs(
            collection(
              db,
              "bowlingStats"
            )
          ),

        ]);


        /* =====================================================
           LOAD CURRENT PLAYER PROFILE
           ===================================================== */

        if (!playerSnapshot.exists()) {

          setStatsError("");

        }


        const playerData =
          playerSnapshot.data() || {};


        const updatedProfile = {

          name:
            playerData.name ||
            currentFirebaseUser?.displayName ||
            user?.name ||
            "",

          email:
            playerData.email ||
            currentFirebaseUser?.email ||
            user?.email ||
            "",

          type:
            playerData.type ||
            user?.type ||
            "",

          battingHand:
            playerData.battingHand ||
            user?.battingHand ||
            "",

          battingPosition:
            playerData.battingPosition ||
            user?.battingPosition ||
            "",

          bowlingHand:
            playerData.bowlingHand ||
            user?.bowlingHand ||
            "",

          bowlingStyle:
            playerData.bowlingStyle ||
            user?.bowlingStyle ||
            "",

        };


        setProfile(
          updatedProfile
        );


        setEditProfile(
          updatedProfile
        );


        /* =====================================================
           CAREER STATISTICS

           Built from the SAME saved scorecards the match
           scorecard screen shows (first innings, second
           innings and live state of every match), so the
           numbers always agree with the scorecard.
           ===================================================== */

        const matches =
          matchesSnapshot.docs.map(
            (matchDoc) => ({

              ...matchDoc.data(),

              id: matchDoc.id,

            })
          );


        const battingDocs =
          battingStatsSnapshot.docs.map(
            (battingDoc) =>
              battingDoc.data()
          );


        const bowlingDocs =
          bowlingStatsSnapshot.docs.map(
            (bowlingDoc) =>
              bowlingDoc.data()
          );


        const playerIds =
          new Set(
            [
              playerId,
              user?.uid,
              user?.id,
            ]
              .filter(Boolean)
              .map(idString)
          );


        const careerStats =
          computePlayerStatistics({
            playerIds,
            battingStats:
              battingDocs,
            bowlingStats:
              bowlingDocs,
            matches,
          });


        /* =====================================================
           PLAYER STRENGTH

           Same formula and source the team builder uses:
           (career runs + wickets x 20) / matches played
           ===================================================== */

        const strengthMatchIds =
          new Set();

        let strengthRuns = 0;

        let strengthWickets = 0;


        battingDocs.forEach(
          (stat) => {

            if (
              !playerIds.has(
                idString(
                  stat.playerId ||
                  stat.uid
                )
              )
            ) {

              return;

            }


            if (stat.matchId) {

              strengthMatchIds.add(
                String(stat.matchId)
              );

            }


            strengthRuns +=
              Number(
                stat.runs
              ) || 0;

          }
        );


        bowlingDocs.forEach(
          (stat) => {

            if (
              !playerIds.has(
                idString(
                  stat.playerId ||
                  stat.uid
                )
              )
            ) {

              return;

            }


            if (stat.matchId) {

              strengthMatchIds.add(
                String(stat.matchId)
              );

            }


            strengthWickets +=
              Number(
                stat.wickets
              ) || 0;

          }
        );


        const strengthMatches =
          strengthMatchIds.size ||
          careerStats.totalMatches;


        const playerStrength =
          strengthMatches > 0
            ? (
                (strengthRuns +
                  strengthWickets * 20) /
                strengthMatches
              ).toFixed(1)
            : "0.0";


        /* =====================================================
           SET STATISTICS
           ===================================================== */

        setStatistics({

          ...careerStats,

          playerStrength,

        });


      } catch (error) {

        console.error(
          "Profile statistics error:",
          error
        );


        setStatsError(
          "Unable to load your statistics from Firebase."
        );


      } finally {

        setLoadingStats(false);

      }

    };


  /* =========================================================
     UPDATE PROFILE
     ========================================================= */

  const handleUpdateProfile =
    async () => {

      try {

        setProfileError("");

        setProfileMessage("");


        if (
          !user?.id &&
          !user?.uid
        ) {

          setProfileError(
            "User information not found."
          );

          return;

        }


        const name =
          editProfile.name.trim();


        const email =
          editProfile.email
            .trim()
            .toLowerCase();


        const type =
          editProfile.type.trim();


        const battingHand =
          editProfile.battingHand?.trim() ||
          "";


        const battingPosition =
          editProfile.battingPosition?.trim() ||
          "";


        const bowlingHand =
          editProfile.bowlingHand?.trim() ||
          "";


        const bowlingStyle =
          editProfile.bowlingStyle?.trim() ||
          "";


        /* =====================================================
           BASIC VALIDATION
           ===================================================== */

        if (!name) {

          setProfileError(
            "Name cannot be empty."
          );

          return;

        }


        if (!email) {

          setProfileError(
            "Email cannot be empty."
          );

          return;

        }


        if (!isValidEmail(email)) {

          setProfileError(
            "Please enter a valid email address."
          );

          return;

        }


        if (!type) {

          setProfileError(
            "Please select a player type."
          );

          return;

        }


        /* =====================================================
           REQUIRED DETAILS BASED ON PLAYER TYPE
           ===================================================== */

        const requiresBattingDetails =
          type === "Batsman" ||
          type === "All-rounder" ||
          type === "Wicketkeeper";


        const requiresBowlingDetails =
          type === "Bowler" ||
          type === "All-rounder";


        /* =====================================================
           BATTING VALIDATION
           ===================================================== */

        if (
          requiresBattingDetails &&
          !battingHand
        ) {

          setProfileError(
            "Please select your batting hand."
          );

          return;

        }


        if (
          requiresBattingDetails &&
          !battingPosition
        ) {

          setProfileError(
            "Please select your batting position."
          );

          return;

        }


        /* =====================================================
           BOWLING VALIDATION
           ===================================================== */

        if (
          requiresBowlingDetails &&
          !bowlingHand
        ) {

          setProfileError(
            "Please select your bowling hand."
          );

          return;

        }


        if (
          requiresBowlingDetails &&
          !bowlingStyle
        ) {

          setProfileError(
            "Please select your bowling style."
          );

          return;

        }


        setSavingProfile(true);


        /* =====================================================
           FIREBASE UID
           ===================================================== */

        const playerId =
          auth.currentUser?.uid ||
          user?.uid ||
          user?.id;


        if (!playerId) {

          setProfileError(
            "Firebase user not found."
          );

          setSavingProfile(false);

          return;

        }


        const playerRef =
          doc(
            db,
            "players",
            playerId
          );


        /* =====================================================
           UPDATE DATA

           IMPORTANT CHANGE:

           When changing player type, fields that are
           NOT applicable to the new type are deleted.

           Batsman:
             batting fields saved
             bowling fields deleted

           Bowler:
             bowling fields saved
             batting fields deleted

           All-rounder:
             both saved

           Wicketkeeper:
             batting fields saved
             bowling fields deleted
           ===================================================== */

        const dataToUpdate = {

          name,

          email,

          type,

        };


        /* =====================================================
           BATTING DETAILS
           ===================================================== */

        if (
          requiresBattingDetails
        ) {

          dataToUpdate.battingHand =
            battingHand;

          dataToUpdate.battingPosition =
            battingPosition;

        } else {

          dataToUpdate.battingHand =
            deleteField();

          dataToUpdate.battingPosition =
            deleteField();

        }


        /* =====================================================
           BOWLING DETAILS
           ===================================================== */

        if (
          requiresBowlingDetails
        ) {

          dataToUpdate.bowlingHand =
            bowlingHand;

          dataToUpdate.bowlingStyle =
            bowlingStyle;

        } else {

          dataToUpdate.bowlingHand =
            deleteField();

          dataToUpdate.bowlingStyle =
            deleteField();

        }


        /* =====================================================
           SAVE TO FIRESTORE
           ===================================================== */

        await setDoc(
          playerRef,
          dataToUpdate,
          {
            merge: true,
          }
        );


        /* =====================================================
           UPDATED LOCAL PROFILE

           IMPORTANT:

           Remove irrelevant old fields locally too.
           This keeps the UI/session consistent with
           Firestore.
           ===================================================== */

        const updatedProfile = {

          ...profile,

          name,

          email,

          type,

          battingHand:
            requiresBattingDetails
              ? battingHand
              : "",

          battingPosition:
            requiresBattingDetails
              ? battingPosition
              : "",

          bowlingHand:
            requiresBowlingDetails
              ? bowlingHand
              : "",

          bowlingStyle:
            requiresBowlingDetails
              ? bowlingStyle
              : "",

        };


        /* =====================================================
           UPDATE REACT PROFILE
           ===================================================== */

        setProfile(
          updatedProfile
        );


        setEditProfile(
          updatedProfile
        );


        /* =====================================================
           UPDATE PARENT USER
           ===================================================== */

        if (onUserUpdated) {

          onUserUpdated({

            ...user,

            id: playerId,

            uid: playerId,

            ...updatedProfile,

          });

        }


        /* =====================================================
           UPDATE LOCAL SESSION
           ===================================================== */

        updateLocalUserSession(
          updatedProfile
        );


        setIsEditing(false);


        setProfileMessage(
          "Profile updated successfully."
        );


      } catch (error) {

        console.error(
          "Profile update error:",
          error
        );


        setProfileError(
          "Unable to update profile: " +
          error.message
        );


      } finally {

        setSavingProfile(false);

      }

    };


  /* =========================================================
     LOGOUT
     ========================================================= */

  const handleProfileLogout =
    async () => {

      try {

        await signOut(auth);

      } catch (error) {

        console.error(
          "Firebase logout error:",
          error
        );

      } finally {

        if (onLogout) {

          onLogout();

        }

      }

    };


  /* =========================================================
     INPUT CHANGE
     ========================================================= */

  const handleInputChange =
    (field, value) => {

      setEditProfile(
        (previous) => ({

          ...previous,

          [field]: value,

        })
      );

    };


  /* =========================================================
     CANCEL EDIT
     ========================================================= */

  const handleCancelEdit =
    () => {

      setEditProfile(
        profile
      );

      setProfileError("");

      setProfileMessage("");

      setIsEditing(false);

    };


  /* =========================================================
     CURRENT TYPE FOR DETAILS FORM

     When editing, use editProfile.type so the form
     changes immediately when the player changes type.
     ========================================================= */

  const detailsType =
    isEditing
      ? editProfile.type
      : profile.type;


  const showBattingDetails =
    detailsType === "Batsman" ||
    detailsType === "All-rounder" ||
    detailsType === "Wicketkeeper";


  const showBowlingDetails =
    detailsType === "Bowler" ||
    detailsType === "All-rounder";


  /* =========================================================
     LOADING
     ========================================================= */

  if (loadingStats) {

    return (

      <div className="profile-page">

        <section className="profile-loading-card">

          <div className="profile-loading-icon">
            👤
          </div>

          <h2>
            Loading your profile...
          </h2>

          <p>
            Fetching your profile and
            career statistics.
          </p>

        </section>

      </div>

    );

  }


  /* =========================================================
     PAGE
     ========================================================= */

  return (

    <div className="profile-page">


      {/* =====================================================
          PROFILE HEADER
          ===================================================== */}

      <section className="profile-header-card">

        <div className="profile-avatar">

          {getInitials(
            profile.name
          )}

        </div>


        <div className="profile-header-info">

          <p className="profile-eyebrow">
            MY PROFILE
          </p>


          <h1>
            {profile.name ||
              "Player"}
          </h1>


          <p>
            {profile.email ||
              "No email available"}
          </p>

        </div>

      </section>


      {/* =====================================================
          PROFILE MESSAGES
          ===================================================== */}

      {profileError && (

        <div className="profile-message profile-error">

          ⚠️ {profileError}

        </div>

      )}


      {profileMessage && (

        <div className="profile-message profile-success">

          ✓ {profileMessage}

        </div>

      )}


      {/* =====================================================
          UPDATE PROFILE
          ===================================================== */}

      <section className="profile-section">

        <div className="profile-section-header">

          <div>

            <p className="profile-section-eyebrow">
              ACCOUNT
            </p>


            <h2>
              Update My Profile
            </h2>


            <p>
              View and update your personal
              player information.
            </p>

          </div>


          {!isEditing && (

            <button
              type="button"
              className="profile-edit-button"
              onClick={() => {

                setProfileMessage("");

                setProfileError("");

                setEditProfile(
                  profile
                );

                setIsEditing(true);

              }}
            >
              ✏️ Edit Profile
            </button>

          )}

        </div>


        <div className="profile-form-grid">


          {/* =================================================
              NAME
              ================================================= */}

          <div className="profile-field">

            <label>
              Name
            </label>


            {isEditing ? (

              <input
                type="text"
                value={
                  editProfile.name
                }
                onChange={(event) =>
                  handleInputChange(
                    "name",
                    event.target.value
                  )
                }
                placeholder="Enter your name"
              />

            ) : (

              <div className="profile-value">

                {profile.name ||
                  "Not available"}

              </div>

            )}

          </div>


          {/* =================================================
              EMAIL
              ================================================= */}

          <div className="profile-field">

            <label>
              Email
            </label>


            {isEditing ? (

              <input
                type="email"
                value={
                  editProfile.email
                }
                onChange={(event) =>
                  handleInputChange(
                    "email",
                    event.target.value
                  )
                }
                placeholder="Enter your email"
              />

            ) : (

              <div className="profile-value">

                {profile.email ||
                  "Not available"}

              </div>

            )}

          </div>


          {/* =================================================
              PLAYER TYPE
              ================================================= */}

          <div className="profile-field">

            <label>
              Player Type
            </label>


            {isEditing ? (

              <select
                value={
                  editProfile.type
                }
                onChange={(event) =>
                  handleInputChange(
                    "type",
                    event.target.value
                  )
                }
              >

                <option value="">
                  Select player type
                </option>


                <option value="Batsman">
                  Batsman
                </option>


                <option value="Bowler">
                  Bowler
                </option>


                <option value="All-rounder">
                  All-rounder
                </option>


                <option value="Wicketkeeper">
                  Wicketkeeper
                </option>

              </select>

            ) : (

              <div className="profile-value">

                {profile.type ||
                  "Not available"}

              </div>

            )}

          </div>


          {/* =================================================
              PLAYER DETAILS
              ================================================= */}

          {(showBattingDetails ||
            showBowlingDetails) && (

            <div className="profile-player-details">


              {/* =============================================
                  DETAILS HEADER
                  ============================================= */}

              <div className="profile-player-details-header">

                <h3>
                  Player Details
                </h3>

                <p>
                  {isEditing
                    ? "Select the details required for your selected player type."
                    : "Your registered batting and bowling information."}
                </p>

              </div>


              {/* =============================================
                  BATTING DETAILS
                  ============================================= */}

              {showBattingDetails && (

                <div className="profile-player-details-group">

                  <div className="profile-player-details-group-title">

                    <span>
                      🏏
                    </span>

                    <h4>
                      Batting Details
                    </h4>

                  </div>


                  <div className="profile-player-details-grid">


                    {/* BATTING HAND */}

                    <div className="profile-field">

                      <label>
                        Batting Hand

                        {isEditing && (
                          <span
                            style={{
                              color: "#dc2626",
                              marginLeft: "3px",
                            }}
                          >
                            *
                          </span>
                        )}
                      </label>


                      {isEditing ? (

                        <select
                          value={
                            editProfile.battingHand
                          }
                          onChange={(event) =>
                            handleInputChange(
                              "battingHand",
                              event.target.value
                            )
                          }
                        >

                          <option value="">
                            Select batting hand
                          </option>


                          <option value="Right">
                            Right Hand
                          </option>


                          <option value="Left">
                            Left Hand
                          </option>

                        </select>

                      ) : (

                        <div className="profile-detail-value">

                          {profile.battingHand === "Right"
                            ? "Right Hand"
                            : profile.battingHand === "Left"
                            ? "Left Hand"
                            : profile.battingHand ||
                              "Not available"}

                        </div>

                      )}

                    </div>


                    {/* BATTING POSITION */}

                    <div className="profile-field">

                      <label>
                        Batting Position

                        {isEditing && (
                          <span
                            style={{
                              color: "#dc2626",
                              marginLeft: "3px",
                            }}
                          >
                            *
                          </span>
                        )}
                      </label>


                      {isEditing ? (

                        <select
                          value={
                            editProfile.battingPosition
                          }
                          onChange={(event) =>
                            handleInputChange(
                              "battingPosition",
                              event.target.value
                            )
                          }
                        >

                          <option value="">
                            Select batting position
                          </option>


                          <option value="Opener">
                            Opener
                          </option>


                          <option value="Middle Order">
                            Middle Order
                          </option>


                          <option value="Finisher">
                            Finisher
                          </option>

                        </select>

                      ) : (

                        <div className="profile-detail-value">

                          {profile.battingPosition ||
                            "Not available"}

                        </div>

                      )}

                    </div>

                  </div>

                </div>

              )}


              {/* =============================================
                  BOWLING DETAILS
                  ============================================= */}

              {showBowlingDetails && (

                <div className="profile-player-details-group">

                  <div className="profile-player-details-group-title">

                    <span>
                      🎯
                    </span>

                    <h4>
                      Bowling Details
                    </h4>

                  </div>


                  <div className="profile-player-details-grid">


                    {/* BOWLING HAND */}

                    <div className="profile-field">

                      <label>
                        Bowling Hand

                        {isEditing && (
                          <span
                            style={{
                              color: "#dc2626",
                              marginLeft: "3px",
                            }}
                          >
                            *
                          </span>
                        )}
                      </label>


                      {isEditing ? (

                        <select
                          value={
                            editProfile.bowlingHand
                          }
                          onChange={(event) =>
                            handleInputChange(
                              "bowlingHand",
                              event.target.value
                            )
                          }
                        >

                          <option value="">
                            Select bowling hand
                          </option>


                          <option value="Right">
                            Right Hand
                          </option>


                          <option value="Left">
                            Left Hand
                          </option>

                        </select>

                      ) : (

                        <div className="profile-detail-value">

                          {profile.bowlingHand === "Right"
                            ? "Right Hand"
                            : profile.bowlingHand === "Left"
                            ? "Left Hand"
                            : profile.bowlingHand ||
                              "Not available"}

                        </div>

                      )}

                    </div>


                    {/* BOWLING STYLE */}

                    <div className="profile-field">

                      <label>
                        Bowling Style

                        {isEditing && (
                          <span
                            style={{
                              color: "#dc2626",
                              marginLeft: "3px",
                            }}
                          >
                            *
                          </span>
                        )}
                      </label>


                      {isEditing ? (

                        <select
                          value={
                            editProfile.bowlingStyle
                          }
                          onChange={(event) =>
                            handleInputChange(
                              "bowlingStyle",
                              event.target.value
                            )
                          }
                        >

                          <option value="">
                            Select bowling style
                          </option>


                          <option value="Spinner">
                            Spinner
                          </option>


                          <option value="Medium Pacer">
                            Medium Pacer
                          </option>


                          <option value="Fast Pacer">
                            Fast Pacer
                          </option>

                        </select>

                      ) : (

                        <div className="profile-detail-value">

                          {profile.bowlingStyle ||
                            "Not available"}

                        </div>

                      )}

                    </div>

                  </div>

                </div>

              )}

            </div>

          )}

        </div>


        {/* =====================================================
            EDIT ACTIONS
            ===================================================== */}

        {isEditing && (

          <div className="profile-form-actions">

            <button
              type="button"
              className="profile-cancel-button"
              onClick={
                handleCancelEdit
              }
              disabled={
                savingProfile
              }
            >
              Cancel
            </button>


            <button
              type="button"
              className="profile-save-button"
              onClick={
                handleUpdateProfile
              }
              disabled={
                savingProfile
              }
            >

              {savingProfile
                ? "Updating..."
                : "Save Changes"}

            </button>

          </div>

        )}

      </section>


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
              Your Statistics
            </h2>


            <p>
              Your career performance across
              recorded matches.
            </p>

          </div>

        </div>


        {statsError && (

          <div className="profile-message profile-error">

            ⚠️ {statsError}

          </div>

        )}


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
              label="Total Balls"
              value={
                statistics.totalBowls
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

            <span className="profile-stat-title-icon">
              🏆
            </span>


            <div>

              <h3>
                Match Results
              </h3>


              <p>
                Your recorded match results
              </p>

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

      </section>


      {/* =====================================================
          LOGOUT
          ===================================================== */}

      <section className="profile-logout-section">

        <div>

          <h3>
            Sign out
          </h3>


          <p>
            Sign out of your cricket scoring
            account on this device.
          </p>

        </div>


        <button
          type="button"
          className="profile-logout-button"
          onClick={
            handleProfileLogout
          }
        >
          Logout
        </button>

      </section>

    </div>

  );

}


/* =========================================================
   STAT CARD
   ========================================================= */

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


/* =========================================================
   GET MATCH NAME
   ========================================================= */

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


/* =========================================================
   EMAIL VALIDATION
   ========================================================= */

function isValidEmail(email) {

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
  );

}


/* =========================================================
   GET INITIALS
   ========================================================= */

function getInitials(name) {

  if (!name) {
    return "P";
  }


  const words =
    name.trim().split(/\s+/);


  if (words.length === 1) {

    return words[0]
      .substring(0, 2)
      .toUpperCase();

  }


  return (
    words[0][0] +
    words[words.length - 1][0]
  ).toUpperCase();

}


/* =========================================================
   UPDATE LOCAL USER SESSION
   ========================================================= */

function updateLocalUserSession(
  updatedData
) {

  const rememberedKey =
    "cricket_remembered_auth";


  const sessionKey =
    "cricket_auth_session";


  try {

    const remembered =
      localStorage.getItem(
        rememberedKey
      );


    const session =
      sessionStorage.getItem(
        sessionKey
      );


    if (remembered) {

      const currentUser =
        JSON.parse(
          remembered
        );


      localStorage.setItem(
        rememberedKey,
        JSON.stringify({
          ...currentUser,
          ...updatedData,
        })
      );

    }


    if (session) {

      const currentUser =
        JSON.parse(
          session
        );


      sessionStorage.setItem(
        sessionKey,
        JSON.stringify({
          ...currentUser,
          ...updatedData,
        })
      );

    }

  } catch (error) {

    console.error(
      "Unable to update local profile session:",
      error
    );

  }

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
          stat.uid
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
          stat.uid
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
              stat.runsConceded ??
              stat.runs
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

  };

};


export default Profile;