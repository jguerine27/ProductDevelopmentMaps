import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Home from './page/Home';
import Signup from './page/Signup/Signup';
import Login from './page/Login/Login';
import ProtectedRoute from './page/ProtectedRoute';
import RedirectIfAuthenticated from './page/RedirectIfAuthenticated';
import RedirectIfORCIDAuth from './page/RedirectIfORCIDAuth';

function App() {
  const [isORCIDLogin, setIsORCIDLogin] = useState(false);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const error = urlParams.get('error');

    if (code) {
      // Successful ORCID login
      localStorage.setItem('orcidAuth', 'true');
      setIsORCIDLogin(true);
    } else if (error) {
      // ORCID login failed
      localStorage.setItem('orcidAuth', 'false');
      setIsORCIDLogin(false);
    } else {
      // Check local storage for previous ORCID auth state
      const orcidAuth = localStorage.getItem('orcidAuth');
      if (orcidAuth === 'true') {
        setIsORCIDLogin(true);
      } else {
        setIsORCIDLogin(false);
      }
    }

    console.log('ORCID Auth State:', isORCIDLogin);
  }, [isORCIDLogin]);

  return (
    <Router>
      <div>
        <section>
          <Routes>
            <Route path="/home" element={
              <ProtectedRoute ORCIDUser={isORCIDLogin}>
                <Home />
              </ProtectedRoute>
            } />
            <Route path="/signup" element={
              <RedirectIfAuthenticated>
                <Signup />
              </RedirectIfAuthenticated>
            } />
            <Route path="/" element={
              <RedirectIfAuthenticated>
                <Login />
              </RedirectIfAuthenticated>
            } />
            <Route path="/login" element={
              <RedirectIfAuthenticated>
                <Login />
              </RedirectIfAuthenticated>
              
            } />
          </Routes>
        </section>
      </div>
    </Router>
  );
}

export default App;
