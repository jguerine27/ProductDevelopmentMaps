import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Home from './page/Home';
import Signup from './page/Signup/Signup';
import Login from './page/Login/Login';
import Privacy from './page/Privacy';
import Review from './page/Review';
import Collaborate from './collaborate/Collaborate';
import { AuthProvider } from './auth/AuthContext';
import RequireAuth from './auth/RequireAuth';
import RequireReviewer from './auth/RequireReviewer';
import RedirectIfAuthenticated from './page/RedirectIfAuthenticated';
import AppShell from './Components/AppShell/AppShell';

/**
 * Routes.
 *
 * ── THE MAP IS PUBLIC ────────────────────────────────────────────────────────
 * /map and everything it reads are open to anyone. The cartographies are
 * published research; requiring an account to look at them would be the wrong
 * default, and the API serves every read route unauthenticated to match. Only
 * contributing and reviewing need a session.
 *
 * This is a change: the map used to sit behind a Firebase guard at /home, so a
 * signed-out visitor was bounced to a login screen before seeing anything.
 *
 * ── / IS AN INTERIM REDIRECT ─────────────────────────────────────────────────
 * The map lives at /map, which matches the navbar and gives people a real URL to
 * share. That leaves / free for a landing page, which this project genuinely
 * wants — opening straight into a dense circular graph with no explanation is
 * hard on a first-time visitor. Nobody has designed that page yet, so / redirects
 * to /map for now. Replace this redirect with the landing page; do not move the
 * map back to /.
 *
 * /home redirects too, so links from the previous structure still work.
 *
 * ── THE PROVIDER SITS ABOVE THE ROUTER ───────────────────────────────────────
 * so the session is read once per page load rather than once per navigation, and
 * so a route guard and the navbar always agree about who is signed in.
 *
 * ── THE SHELL WRAPS THE GUARD, NOT THE PAGE ──────────────────────────────────
 * The navbar used to be mounted inside Home, so following the Collaborate or
 * Review link took the entire bar off screen. AppShell puts it back, and it is
 * wrapped OUTSIDE RequireAuth and RequireReviewer on purpose: a guard renders
 * screens of its own — "checking your session", and the notice a signed-in
 * non-reviewer gets — and those are exactly the moments when being left with no
 * navigation is worst. Inside the guard, they would have none.
 *
 * /login and /signup stay bare. They are the one place a bar offering "Sign in"
 * would be pointing at the page the visitor is already on.
 */
function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/map" element={<Home />} />

          <Route path="/login" element={
            <RedirectIfAuthenticated>
              <Login />
            </RedirectIfAuthenticated>
          } />
          <Route path="/signup" element={
            <RedirectIfAuthenticated>
              <Signup />
            </RedirectIfAuthenticated>
          } />

          {/* Public: the consent checkbox links here, and consent to a notice
              nobody can read is not consent. */}
          <Route path="/privacy" element={<Privacy />} />

          {/* Contributing needs a session, so the whole Collaborate subtree sits
              behind ONE guard rather than each form carrying its own — a form
              added inside it cannot end up public by omission. A signed-out
              visitor is sent to sign in and returned here afterwards, because
              RequireAuth carries the attempted location in state.from. */}
          <Route path="/collaborate/*" element={
            <AppShell activeForm="collaborate">
              <RequireAuth>
                <Collaborate />
              </RequireAuth>
            </AppShell>
          } />

          {/* A signed-out visitor is sent to sign in; a signed-in contributor
              gets an explanation, never a login screen. */}
          <Route path="/review" element={
            <AppShell activeForm="review">
              <RequireReviewer>
                <Review />
              </RequireReviewer>
            </AppShell>
          } />

          <Route path="/" element={<Navigate to="/map" replace />} />
          <Route path="/home" element={<Navigate to="/map" replace />} />
          <Route path="*" element={<Navigate to="/map" replace />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
