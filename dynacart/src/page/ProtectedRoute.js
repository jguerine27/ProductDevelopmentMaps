import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth } from '../firebase';

const ProtectedRoute = ({ children, ORCIDUser }) => {
  const [user, loading, error] = useAuthState(auth);
  console.log(ORCIDUser)
  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error: {error.message}</div>;
  }

  // Allow access if the user is authenticated via Firebase or ORCID
  if (!user && !ORCIDUser) {
    return <Navigate to="/" />;
  }

  return children;
};

export default ProtectedRoute;
