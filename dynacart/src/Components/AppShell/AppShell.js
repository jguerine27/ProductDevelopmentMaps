import React from 'react';
import { useNavigate } from 'react-router-dom';
import './AppShell.css';
import Navbar from '../Navbar/Navbar';
import { useAuth } from '../../auth/AuthContext';

/**
 * The navbar and the page under it — the frame every full-page route shares.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The navbar used to be mounted inside Home, so it existed on /map and nowhere
 * else. Following the Collaborate or Review link took the whole bar off screen:
 * no account controls, no way back except the one in-page "← Back to the map"
 * link, and no sign of which section you were in. Contributing felt like leaving
 * the application rather than moving around inside it.
 *
 * The frame is therefore a component the routes wrap, not something Home owns.
 * Wrapping the route ELEMENT in App.js — outside RequireAuth and
 * RequireReviewer — means the bar is also present on the guards' own screens,
 * which is where it is needed most: "this area is for peer reviewers" with no
 * navigation is a dead end.
 *
 * ── THE AUTH WIRING LIVES HERE, NOT IN Navbar ────────────────────────────────
 * Navbar stays presentational — `user`, `loading` and the callbacks arrive as
 * props, so it renders in tests without a provider and without a Router. This
 * component is the one that calls useAuth() and useNavigate(), so that wiring is
 * written once rather than repeated by every page that wants a bar.
 *
 * ── SECTIONS ARE Home's STATE, SO OTHER PAGES NAVIGATE ───────────────────────
 * The map is a view Home.js switches to in place with `activeForm`; there is no
 * route for it. A page that owns that state passes `activeForm`/`setActiveForm`
 * and keeps switching in place. A page that does not — Collaborate, Review —
 * passes the name of the section it is in (for the aria-current mark) and gets a
 * `setActiveForm` that navigates to /map instead, handing the wanted section
 * along in location state for Home to open on.
 */
/**
 * `stayOnSignOut` is for a public page that owns no sections of its own.
 *
 * handleLogout's rule is "end up somewhere you are allowed to be", and it reads
 * `setActiveForm` to decide: a page that has sections switches one in place and
 * therefore stays put, and a page that has none is assumed to be guarded, so it
 * leaves for the map. The landing page is neither — public, but sectionless —
 * and without this it would eject a reader to /map for signing out on a page
 * they are perfectly entitled to keep reading.
 */
const AppShell = ({
    activeForm = null,
    setActiveForm = null,
    stayOnSignOut = false,
    children,
}) => {
    const navigate = useNavigate();
    const { user, loading, signOut } = useAuth();

    /**
     * Reach a section of Home. In place when Home is what is showing, by
     * navigation from anywhere else.
     */
    const goToSection = (form) => {
        if (setActiveForm) {
            setActiveForm(form);
            return;
        }
        navigate('/map', { state: { form } });
    };

    const handleLogout = async () => {
        await signOut();
        if (stayOnSignOut) return;
        // The map is public, so signing out there should not eject the reader
        // from what they were reading — goToSection keeps them on it.
        //
        // Collaborate and Review are not public, and staying would put the
        // reader on a page their guard is about to redirect away from. From
        // those, goToSection navigates to the map, which is somewhere real.
        goToSection('graph');
    };

    return (
        <div className="app-shell">
            <Navbar
                setActiveForm={goToSection}
                activeForm={activeForm}
                user={user}
                loading={loading}
                onHome={() => navigate('/')}
                onSignIn={() => navigate('/login')}
                onRegister={() => navigate('/signup')}
                onCollaborate={() => navigate('/collaborate')}
                onReview={() => navigate('/review')}
                onLogout={handleLogout}
            />
            <div className="app-shell-view">
                {children}
            </div>
        </div>
    );
};

export default AppShell;
