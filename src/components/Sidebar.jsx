import { NavLink } from "react-router-dom";

function Sidebar() {
  return (
    <nav className="sidebar">

      <NavLink
        to="/"
        className={({ isActive }) =>
          isActive ? "nav-item active" : "nav-item"
        }
      >
        <span className="nav-icon">🏠</span>
        <span>Home</span>
      </NavLink>

      <NavLink
        to="/players"
        className={({ isActive }) =>
          isActive ? "nav-item active" : "nav-item"
        }
      >
        <span className="nav-icon">👤</span>
        <span>Players</span>
      </NavLink>

      <NavLink
        to="/teams"
        className={({ isActive }) =>
          isActive ? "nav-item active" : "nav-item"
        }
      >
        <span className="nav-icon">👥</span>
        <span>Teams</span>
      </NavLink>
<NavLink
  to="/matches"
  className={({ isActive }) =>
    isActive
      ? "nav-item active"
      : "nav-item"
  }
>
  <span className="nav-icon">
    🏏
  </span>

  <span>
    Matches
  </span>
</NavLink>

      <NavLink
        to="/tournaments"
        className={({ isActive }) =>
          isActive ? "nav-item active" : "nav-item"
        }
      >
        <span className="nav-icon">🏆</span>
        <span>Tournaments</span>
      </NavLink>

    </nav>
  );
}

export default Sidebar;