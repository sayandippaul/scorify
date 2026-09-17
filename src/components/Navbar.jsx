import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./navbar.css";

function Navbar({
  user,
  onProfileClick,
}) {

  const navigate = useNavigate();


  /* =========================================================
     DARK MODE
     ========================================================= */

  const [darkMode, setDarkMode] = useState(() => {

    const savedTheme =
      localStorage.getItem("theme");

    if (savedTheme) {
      return savedTheme === "dark";
    }

    return true;
  });


  /* =========================================================
     APPLY THEME
     ========================================================= */

  useEffect(() => {

    if (darkMode) {

      document.documentElement.setAttribute(
        "data-theme",
        "dark"
      );

      localStorage.setItem(
        "theme",
        "dark"
      );

    } else {

      document.documentElement.setAttribute(
        "data-theme",
        "light"
      );

      localStorage.setItem(
        "theme",
        "light"
      );

    }

  }, [darkMode]);


  /* =========================================================
     PROFILE BUTTON
     ========================================================= */

  const handleProfileClick = () => {

    if (onProfileClick) {

      onProfileClick();

    } else {

      navigate("/profile");

    }

  };


  /* =========================================================
     GET PLAYER NAME
     ========================================================= */

  const playerName =
    user?.name ||
    user?.displayName ||
    "Player";


  /* =========================================================
     NAVBAR
     ========================================================= */

  return (

    <header className="navbar">


      {/* =====================================================
          LEFT SIDE
          ===================================================== */}

      <div className="navbar-left">

        <div className="logo-icon">
          🏏
        </div>


        <div>

          <h1>
            Scorify
          </h1>

          <p>
            Local Cricket
          </p>

        </div>

      </div>


      {/* =====================================================
          THEME BUTTON
          ===================================================== */}

      <button
        type="button"
        className="theme-button"
        onClick={() =>
          setDarkMode(
            !darkMode
          )
        }
        aria-label="Toggle theme"
      >

        {darkMode
          ? "☀️"
          : "🌙"}

      </button>


      {/* =====================================================
          PROFILE BUTTON
          ===================================================== */}

      <div className="navbar-account">

        <button
          type="button"
          className="profile-button"
          onClick={
            handleProfileClick
          }
          aria-label="Open profile"
          title={playerName}
        >

          <span className="profile-button-icon">
            👤
          </span>


          {/* <span className="profile-button-name">
            {playerName}
          </span> */}

        </button>

      </div>

    </header>

  );
}


export default Navbar;