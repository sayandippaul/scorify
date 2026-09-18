import { useCallback, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useNavigate,
} from "react-router-dom";

import Sidebar from "./components/Sidebar";
import Navbar from "./components/Navbar";
import AuthPage from "./pages/AuthPage";

import Dashboard from "./pages/Dashboard";
import Players from "./pages/Players";
import Teams from "./pages/Teams";
import Matches from "./pages/Matches";
import Scoring from "./pages/Scoring";
import Profile from "./pages/Profile";
import PageLoader from "./components/PageLoader";


/* =========================================================
   AUTH STORAGE
   ========================================================= */

const AUTH_STORAGE_KEY =
  "cricket_auth_session";

const REMEMBERED_AUTH_KEY =
  "cricket_remembered_auth";

const LEGACY_AUTH_KEYS = [
  "cricket_auth_user",
  "cricket_current_user",
];


/* =========================================================
   CLEAR AUTH STORAGE
   ========================================================= */

const clearAuthStorage = () => {

  localStorage.removeItem(
    REMEMBERED_AUTH_KEY
  );

  sessionStorage.removeItem(
    AUTH_STORAGE_KEY
  );

  LEGACY_AUTH_KEYS.forEach((key) => {

    localStorage.removeItem(key);

    sessionStorage.removeItem(key);

  });
};


/* =========================================================
   GET SAVED USER
   ========================================================= */

const getSavedUser = () => {
  try {
    const saved =
      localStorage.getItem(
        REMEMBERED_AUTH_KEY
      ) ||
      sessionStorage.getItem(
        AUTH_STORAGE_KEY
      );

    if (!saved) {
      return null;
    }

    const parsed =
      JSON.parse(saved);

    if (
      !parsed ||
      (!parsed.id && !parsed.uid)
    ) {
      return null;
    }

    return {
      ...parsed,

      id:
        parsed.id ||
        parsed.uid,

      uid:
        parsed.uid ||
        parsed.id,

      name:
        parsed.name ||
        parsed.displayName ||
        "Player",
    };

  } catch (error) {
    console.error(
      "Unable to load saved user:",
      error
    );

    return null;
  }
};

/* =========================================================
   NAVBAR WRAPPER
   ========================================================= */

function AppNavbar({ user }) {

  const navigate =
    useNavigate();


  /* =======================================================
     PROFILE BUTTON CLICK
     ======================================================= */

  const handleProfileClick = () => {

    if (!user) {

      navigate("/");

      return;
    }

    navigate("/profile");
  };


  return (
    <Navbar
      user={user}
      onProfileClick={
        handleProfileClick
      }
    />
  );
}


/* =========================================================
   APP
   ========================================================= */

function App() {

  const [user, setUser] =
    useState(getSavedUser);
  const [isLoading, setIsLoading] = useState(true);
  const completeLoading = useCallback(
    () => setIsLoading(false),
    []
  );


  /* =======================================================
     LOGIN
     ======================================================= */

  const handleLogin = (
    nextUser,
    rememberMe
  ) => {

    /*
      Make sure the object coming from AuthPage
      has a consistent id and name.
    */

    const loggedInUser = {

      ...nextUser,

      id:
        nextUser?.id ||
        nextUser?.uid,

      name:
        nextUser?.name ||
        nextUser?.displayName ||
        "Player",

    };


    /*
      Convert user to JSON.
    */

    const serialized =
      JSON.stringify(
        loggedInUser
      );


    /*
      Remove previous login.
    */

    clearAuthStorage();


    /*
      Save login.
    */

    if (rememberMe) {

      localStorage.setItem(
        REMEMBERED_AUTH_KEY,
        serialized
      );

    } else {

      sessionStorage.setItem(
        AUTH_STORAGE_KEY,
        serialized
      );

    }


    /*
      Update React state.

      This is the important part:
      Navbar receives this same object,
      including the player's name.
    */

    setUser(
      loggedInUser
    );
  };


  /* =======================================================
     LOGOUT
     ======================================================= */

  const handleLogout = () => {

    /*
      Clear browser storage.
    */

    clearAuthStorage();


    /*
      Remove logged-in user from React state.

      This automatically returns the application
      to AuthPage.
    */

    setUser(null);
  };


  /* =========================================================
     APP UI
     ========================================================= */

  if (isLoading) {
    return <PageLoader onComplete={completeLoading} />;
  }

  return (
    <BrowserRouter>

      {!user ? (

        /* =================================================
           NOT LOGGED IN

           AuthPage is displayed.
           ================================================= */

        <AuthPage
          onLogin={handleLogin}
        />

      ) : (

        /* =================================================
           LOGGED IN
           ================================================= */

        <div className="app">


          {/* ===============================================
              NAVBAR

              Shows the player's name as the profile button.
              =============================================== */}

          <AppNavbar
            user={user}
          />


          {/* ===============================================
              APP BODY
              =============================================== */}

          <div className="app-body">


            {/* =============================================
                SIDEBAR
                ============================================= */}

            <Sidebar />


            {/* =============================================
                MAIN CONTENT
                ============================================= */}

            <main className="main-content">

              <Routes>


                {/* =========================================
                    DASHBOARD
                    ========================================= */}

                <Route
                  path="/"
                  element={
                    <Dashboard />
                  }
                />


                {/* =========================================
                    PROFILE
                    ========================================= */}

                <Route
                  path="/profile"
                  element={
                    <Profile
                      user={user}
                      onUserUpdated={(updatedUser) =>
                        setUser((current) => ({
                          ...current,
                          ...updatedUser,
                          id: current?.id || updatedUser.id,
                          uid: current?.uid || updatedUser.uid,
                        }))
                      }
                      onLogout={
                        handleLogout
                      }
                    />
                  }
                />


                {/* =========================================
                    PLAYERS
                    ========================================= */}

                <Route
                  path="/players"
                  element={
                    <Players />
                  }
                />


                {/* =========================================
                    TEAMS
                    ========================================= */}

                <Route
                  path="/teams"
                  element={
                    <Teams />
                  }
                />


                {/* =========================================
                    MATCHES
                    ========================================= */}

                <Route
                  path="/matches"
                  element={
                    <Matches />
                  }
                />


                {/* =========================================
                    SCORING
                    ========================================= */}

                <Route
                  path="/scoring/:matchId"
                  element={
                    <Scoring />
                  }
                />

              </Routes>

            </main>

          </div>

        </div>

      )}

    </BrowserRouter>
  );
}


export default App;