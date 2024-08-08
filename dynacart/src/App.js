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
    // Check if the user logged in via ORCID
    const orcidAuth = localStorage.getItem('orcidAuth');
    if (orcidAuth) {
      setIsORCIDLogin(true);
    }
  }, []);

  return (
    <Router>
      <div>
        <section>
          <Routes>
            <Route path="/home" element={
              isORCIDLogin ? (
                <RedirectIfORCIDAuth>
                  <Home />
                </RedirectIfORCIDAuth>
              ) : (
                <ProtectedRoute>
                  <Home />
                </ProtectedRoute>
              )
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
