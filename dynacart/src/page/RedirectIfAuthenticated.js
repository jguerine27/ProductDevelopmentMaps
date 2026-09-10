import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import '../auth/AuthScreens.css';

/**
 * Keep a signed-in visitor off the sign-in and registration screens.
 *
 * Reads the auth context, not Firebase. The old version used
 * useAuthState(auth), which would have let a signed-in ORCID reviewer — who has
 * no Firebase state at all — walk back onto the sign-in page and be told to
 * authenticate again.
 *
 * Sends them where they were originally heading if a guard put them here, and
 * to the map otherwise.
 */
const RedirectIfAuthenticated = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="pdm-auth-pending" role="status" aria-live="polite">
        Checking your session…
      </div>
    );
  }

  if (user) {
    const destination = (location.state && location.state.from && location.state.from.pathname) || '/map';
    return <Navigate to={destination} replace />;
  }

  return children;
};

export default RedirectIfAuthenticated;
