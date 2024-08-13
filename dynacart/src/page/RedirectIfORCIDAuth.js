import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

const RedirectIfORCIDAuth = ({ children }) => {
  const [isORCIDAuthenticated, setIsORCIDAuthenticated] = useState(false);

  useEffect(() => {
    // Check for ORCID API authentication from URL parameters
    const orcidAuth = localStorage.getItem('orcidAuth');
  const orcidUser = orcidAuth === 'true';

    if (orcidUser) {
      setIsORCIDAuthenticated(true);
    } else {
      setIsORCIDAuthenticated(false);
    }
  }, []);

  if (isORCIDAuthenticated) {
    return <Navigate to="/home" />;
  }

  return children;
};

export default RedirectIfORCIDAuth;
