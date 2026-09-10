import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import './AuthScreens.css';

/**
 * Gate a route on there being a session.
 *
 * Reads the auth context — which reads GET /api/auth/me — and NOT Firebase.
 * A reviewer signed in through ORCID has no Firebase state whatsoever, so a
 * Firebase-based guard would lock every reviewer out of the reviewer routes.
 *
 * The attempted location travels in `state.from` so that signing in returns the
 * user where they were going, instead of dumping them on the map and making
 * them find their way back.
 */
const RequireAuth = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Never render children while the session is still unknown: a protected page
  // that flashes into view and then redirects is worse than a brief wait, and
  // any request it fired on mount would 401.
  if (loading) {
    return (
      <div className="pdm-auth-pending" role="status" aria-live="polite">
        Checking your session…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
};

export default RequireAuth;
