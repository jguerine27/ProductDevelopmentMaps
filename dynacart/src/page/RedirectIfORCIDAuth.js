import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

const RedirectIfORCIDAuth = ({ children }) => {
  const [isORCIDAuthenticated, setIsORCIDAuthenticated] = useState(false);

  useEffect(() => {
    // Check for ORCID API authentication
    const orcidAuth = localStorage.getItem('orcidAuth');
    if (orcidAuth) {
      setIsORCIDAuthenticated(true);
    }
  }, []);

  if (isORCIDAuthenticated) {
    return <Navigate to="/home" />;
  }

  return children;
};

export default RedirectIfORCIDAuth;
