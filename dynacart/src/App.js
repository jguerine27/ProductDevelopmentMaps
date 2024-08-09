import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Home from './page/Home';
import Signup from './page/Signup/Signup';
import Login from './page/Login/Login';
import ProtectedRoute from './page/ProtectedRoute';
import RedirectIfAuthenticated from './page/RedirectIfAuthenticated';

function App() {
  const [isORCIDLogin, setIsORCIDLogin] = useState(false);

  useEffect(() => {
    console.log(window.location.href);
    const orcidUser = window.location.href.includes('ORCIDUser=true');

    if (orcidUser === 'true') {
        localStorage.setItem('orcidAuth', 'true');
        setIsORCIDLogin(true);
    } else {
        localStorage.setItem('orcidAuth', 'false');
        setIsORCIDLogin(false);
    }

    console.log('ORCID Auth State:', orcidUser);
}, []);


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
