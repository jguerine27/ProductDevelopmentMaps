import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

const RedirectIfORCIDAuth = ({ children }) => {
  const [isORCIDAuthenticated, setIsORCIDAuthenticated] = useState(false);

  useEffect(() => {
    // Check for ORCID API authentication from URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const orcidUser = urlParams.get('code') || urlParams.get('error');
    
    if (orcidUser === 'code') {
      setIsORCIDAuthenticated(true);
    } else if (urlParams.get('error')) {
      setIsORCIDAuthenticated(false);
    }
  }, []);

  if (isORCIDAuthenticated) {
    return <Navigate to="/home" />;
  }

  return children;
};

export default RedirectIfORCIDAuth;
