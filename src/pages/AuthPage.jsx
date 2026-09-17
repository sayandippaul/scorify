import { useEffect, useState } from "react";
import "./authpage.css";

import {
  registerPlayer,
  loginPlayer,
} from "../services/authService";


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


const emptyForm = {
  name: "",
  email: "",
  password: "",
  type: "",
  battingHand: "",
  battingPosition: "",
  bowlingHand: "",
  bowlingStyle: "",
};


function AuthPage({ onLogin }) {

  const [mode, setMode] = useState("login");

  const [form, setForm] = useState(emptyForm);

  const [rememberMe, setRememberMe] = useState(true);

  const [showPassword, setShowPassword] = useState(false);

  const [message, setMessage] = useState("");

  const [loading, setLoading] = useState(false);

  const [darkMode, setDarkMode] = useState(
    () => localStorage.getItem("theme") === "dark"
  );


  const isRegister = mode === "register";


  const isBattingType = [
    "Batsman",
    "All-rounder",
    "Wicketkeeper",
  ].includes(form.type);


  const isBowlingType = [
    "Bowler",
    "All-rounder",
  ].includes(form.type);


  // ===============================
  // DARK MODE
  // ===============================

  useEffect(() => {

    document.documentElement.setAttribute(
      "data-theme",
      darkMode ? "dark" : "light"
    );

    localStorage.setItem(
      "theme",
      darkMode ? "dark" : "light"
    );

  }, [darkMode]);


  // ===============================
  // CHANGE LOGIN / REGISTER
  // ===============================

  const changeMode = (nextMode) => {

    setMode(nextMode);

    setForm(emptyForm);

    setMessage("");

    setShowPassword(false);

  };


  // ===============================
  // UPDATE FORM
  // ===============================

  const updateForm = (event) => {

    const {
      name,
      value,
    } = event.target;

    setForm((previous) => ({
      ...previous,
      [name]: value,
    }));

  };


  // ===============================
  // CHANGE PLAYER TYPE
  // ===============================

  const changePlayerType = (event) => {

    const type = event.target.value;

    setForm((previous) => ({
      ...previous,

      type,

      battingHand: "",
      battingPosition: "",

      bowlingHand: "",
      bowlingStyle: "",
    }));

  };


  // ===============================
  // CHOICE BUTTON
  // ===============================

  const setChoice = (name, value) => {

    setForm((previous) => ({
      ...previous,
      [name]: value,
    }));

  };


  // ===============================
  // SUBMIT
  // ===============================

  const submit = async (event) => {

    event.preventDefault();

    setMessage("");

    setLoading(true);


    try {

      // =====================================
      // LOGIN
      // =====================================

      if (!isRegister) {

        if (!form.email.trim()) {
          setMessage("Enter your email address.");
          return;
        }

        if (!form.password) {
          setMessage("Enter your password.");
          return;
        }


        const player = await loginPlayer(
          form.email,
          form.password
        );


        onLogin(
          {
            id: player.id,
            name: player.name,
            email: player.email,
            type: player.type,
          },
          rememberMe
        );

        return;
      }


      // =====================================
      // REGISTER VALIDATION
      // =====================================

      if (!form.name.trim()) {
        setMessage("Enter your name.");
        return;
      }


      if (!form.email.trim()) {
        setMessage("Enter your email address.");
        return;
      }


      if (!form.password) {
        setMessage("Enter your password.");
        return;
      }


      if (form.password.length < 6) {
        setMessage(
          "Password must be at least 6 characters."
        );
        return;
      }


      if (!form.type) {
        setMessage("Choose a player type.");
        return;
      }


      if (
        isBattingType &&
        (!form.battingHand ||
          !form.battingPosition)
      ) {
        setMessage(
          "Complete the batting details."
        );
        return;
      }


      if (
        isBowlingType &&
        (!form.bowlingHand ||
          !form.bowlingStyle)
      ) {
        setMessage(
          "Complete the bowling details."
        );
        return;
      }


      // =====================================
      // FIREBASE REGISTRATION
      // =====================================

      const player = await registerPlayer({

        name: form.name,

        email: form.email,

        password: form.password,

        type: form.type,

        battingHand: form.battingHand,

        battingPosition: form.battingPosition,

        bowlingHand: form.bowlingHand,

        bowlingStyle: form.bowlingStyle,

      });


      // Automatically login after registration
      onLogin(
        {
          id: player.id,
          name: player.name,
          email: player.email,
          type: player.type,
        },
        rememberMe
      );


    } catch (error) {

      console.error(
        "Authentication error:",
        error
      );


      // Firebase errors
      if (
        error.code ===
        "auth/email-already-in-use"
      ) {

        setMessage(
          "This email is already registered."
        );

      } else if (
        error.code ===
        "auth/invalid-email"
      ) {

        setMessage(
          "Enter a valid email address."
        );

      } else if (
        error.code ===
        "auth/weak-password"
      ) {

        setMessage(
          "Password must be at least 6 characters."
        );

      } else if (
        error.code ===
        "auth/invalid-credential"
      ) {

        setMessage(
          "Email or password is incorrect."
        );

      } else if (
        error.code ===
        "auth/user-not-found"
      ) {

        setMessage(
          "Email or password is incorrect."
        );

      } else if (
        error.code ===
        "auth/wrong-password"
      ) {

        setMessage(
          "Email or password is incorrect."
        );

      } else {

        setMessage(
          error.message ||
          "Something went wrong. Please try again."
        );

      }

    } finally {

      setLoading(false);

    }

  };


  return (

    <main className="auth-page">

      {/* ================================= */}
      {/* LEFT VISUAL SECTION */}
      {/* ================================= */}

      <section className="auth-visual">

        <div className="auth-brand-mark">
          🏏
        </div>


        <p className="auth-kicker">
          LOCAL CRICKET, ORGANIZED
        </p>


        <h1>
          Every over has a story.
        </h1>


        <p className="auth-intro">
          Build your player database, create
          balanced teams, and score every
          delivery with confidence.
        </p>


        <div className="auth-stat-row">

          <div>
            <strong>01</strong>
            <span>Live scoring</span>
          </div>


          <div>
            <strong>02</strong>
            <span>Team drafts</span>
          </div>


          <div>
            <strong>03</strong>
            <span>Full scorecards</span>
          </div>

        </div>

      </section>


      {/* ================================= */}
      {/* AUTH PANEL */}
      {/* ================================= */}

      <section className="auth-panel">

        <div className="auth-panel-header">

          <div>

            <p className="auth-panel-kicker">
              WELCOME TO THE DUGOUT
            </p>


            <h2>
              {isRegister
                ? "Create your player profile"
                : "Sign in to your scoring desk"}
            </h2>

          </div>


          <button
            type="button"
            className="auth-theme-button"
            onClick={() =>
              setDarkMode(
                (enabled) => !enabled
              )
            }
            aria-label="Toggle dark mode"
            title="Toggle dark mode"
          >

            {darkMode
              ? "☀️"
              : "🌙"}

          </button>

        </div>


        {/* ================================= */}
        {/* TABS */}
        {/* ================================= */}

        <div
          className="auth-tabs"
          role="tablist"
        >

          <button
            type="button"
            className={
              !isRegister
                ? "active"
                : ""
            }
            onClick={() =>
              changeMode("login")
            }
          >
            Login
          </button>


          <button
            type="button"
            className={
              isRegister
                ? "active"
                : ""
            }
            onClick={() =>
              changeMode("register")
            }
          >
            Register
          </button>

        </div>


        {/* ================================= */}
        {/* FORM */}
        {/* ================================= */}

        <form
          className="auth-form"
          onSubmit={submit}
        >


          {/* NAME */}
          {isRegister && (

            <label>

              Full name

              <input
                name="name"
                value={form.name}
                onChange={updateForm}
                placeholder="Enter your name"
                autoComplete="name"
              />

            </label>

          )}


          {/* EMAIL */}
          <label>

            Email address

            <input
              name="email"
              type="email"
              value={form.email}
              onChange={updateForm}
              placeholder="Enter your email"
              autoComplete={
                isRegister
                  ? "email"
                  : "username"
              }
            />

          </label>


          {/* PASSWORD */}
          <label>

            Password

            <span className="auth-password-field">

              <input
                name="password"
                type={
                  showPassword
                    ? "text"
                    : "password"
                }
                value={form.password}
                onChange={updateForm}
                placeholder="Enter password"
                autoComplete={
                  isRegister
                    ? "new-password"
                    : "current-password"
                }
              />


              <button
                type="button"
                onClick={() =>
                  setShowPassword(
                    (visible) =>
                      !visible
                  )
                }
              >

                {showPassword
                  ? "Hide"
                  : "Show"}

              </button>

            </span>

          </label>


          {/* ================================= */}
          {/* REGISTER-ONLY FIELDS */}
          {/* ================================= */}

          {isRegister && (

            <>

              {/* PLAYER TYPE */}

              <label>

                Player type

                <select
                  name="type"
                  value={form.type}
                  onChange={changePlayerType}
                  required
                >

                  <option value="">
                    Select player type
                  </option>


                  {PLAYER_TYPES.map(
                    (type) => (

                      <option
                        key={type}
                        value={type}
                      >
                        {type}
                      </option>

                    )
                  )}

                </select>

              </label>


              {/* BATTING DETAILS */}

              {isBattingType && (

                <div className="auth-detail-section">

                  <p>
                    Batting details
                  </p>


                  <ChoiceGroup
                    label="Hand"
                    name="battingHand"
                    values={
                      BATTING_HANDS
                    }
                    selected={
                      form.battingHand
                    }
                    onSelect={setChoice}
                  />


                  <ChoiceGroup
                    label="Position"
                    name="battingPosition"
                    values={
                      BATTING_POSITIONS
                    }
                    selected={
                      form.battingPosition
                    }
                    onSelect={setChoice}
                  />

                </div>

              )}


              {/* BOWLING DETAILS */}

              {isBowlingType && (

                <div className="auth-detail-section">

                  <p>
                    Bowling details
                  </p>


                  <ChoiceGroup
                    label="Hand"
                    name="bowlingHand"
                    values={
                      BOWLING_HANDS
                    }
                    selected={
                      form.bowlingHand
                    }
                    onSelect={setChoice}
                  />


                  <ChoiceGroup
                    label="Style"
                    name="bowlingStyle"
                    values={
                      BOWLING_STYLES
                    }
                    selected={
                      form.bowlingStyle
                    }
                    onSelect={setChoice}
                  />

                </div>

              )}

            </>

          )}


          {/* ================================= */}
          {/* REMEMBER ME */}
          {/* ================================= */}

          <label className="auth-check">

            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) =>
                setRememberMe(
                  event.target.checked
                )
              }
            />


            <span>
              Remember me on this device
            </span>

          </label>


          {/* ================================= */}
          {/* MESSAGE */}
          {/* ================================= */}

          {message && (

            <p
              className="auth-message"
              role="alert"
            >
              {message}
            </p>

          )}


          {/* ================================= */}
          {/* SUBMIT */}
          {/* ================================= */}

          <button
            className="auth-submit"
            type="submit"
            disabled={loading}
          >

            {loading
              ? "Please wait..."
              : isRegister
                ? "Create account"
                : "Login to scoring"}

            <span>
              →
            </span>

          </button>


        </form>


        {/* ================================= */}
        {/* SWITCH */}
        {/* ================================= */}

        <p className="auth-switch">

          {isRegister
            ? "Already have an account?"
            : "New to the scoring desk?"}

          {" "}

          <button
            type="button"
            onClick={() =>
              changeMode(
                isRegister
                  ? "login"
                  : "register"
              )
            }
          >

            {isRegister
              ? "Login"
              : "Register"}

          </button>

        </p>


        <p className="auth-note">
          Your player profile is securely
          stored in Firebase.
        </p>

      </section>

    </main>

  );
}


// =====================================
// CHOICE GROUP
// =====================================

function ChoiceGroup({
  label,
  name,
  values,
  selected,
  onSelect,
}) {

  return (

    <div className="auth-choice-group">

      <span>
        {label}
      </span>


      <div>

        {values.map(
          (value) => (

            <button
              type="button"
              key={value}
              className={
                selected === value
                  ? "selected"
                  : ""
              }
              onClick={() =>
                onSelect(
                  name,
                  value
                )
              }
            >

              {value}

            </button>

          )
        )}

      </div>

    </div>

  );

}


export default AuthPage;