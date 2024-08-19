import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth } from '../firebase';

const RedirectIfAuthenticated = ({ children }) => {
  const [user, loading, error] = useAuthState(auth);
  const orcidAuth = localStorage.getItem('orcidAuth') === 'true'; // Check ORCID auth state

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error: {error.message}</div>;
  }

  // Allow access to /home if either Firebase user is authenticated or ORCID auth is true
  if (user || orcidAuth) {
    return <Navigate to="/home" />;
  }

  return children;
};

export default RedirectIfAuthenticated;
