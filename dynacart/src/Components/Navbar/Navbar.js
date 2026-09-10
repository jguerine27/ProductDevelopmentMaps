import React, { useState } from 'react';
import './Navbar.css';

/**
 * The application bar: wordmark left, section links and the account controls
 * right.
 *
 * These are BUTTONS rather than anchors because the app has no route for the
 * map's sub-sections — Home and Map are two values of Home.js's `activeForm`,
 * switched in place. An <a> without an href is not a link to anything, so a
 * button is the honest element; `aria-current` still marks which section is
 * showing. The account controls are buttons too, and the parent turns them into
 * navigation, which keeps this component renderable without a Router.
 *
 * Presentational on purpose: it takes `user` and callbacks as props rather than
 * calling useAuth() itself, so it can be tested without a provider and without a
 * router, exactly as before.
 */

/**
 * Sections that switch Home's view. `form` is null for the ones that are not a
 * view of Home at all: Collaborate is its own route, so it travels by callback
 * like Review does rather than through `setActiveForm`. A section with neither
 * a `form` nor a handler stays inert, which is what an unbuilt one should do.
 *
 * `id` is what `activeForm` is compared against, and it is separate from `form`
 * for exactly one reason: a section that navigates has no `form` to switch to
 * but is still somewhere you can BE. The bar stays on screen inside Collaborate
 * and Review now, so a parent that knows which of those is showing can pass its
 * id and have it marked. Without that the bar would sit above those pages
 * saying nothing at all about where the reader is.
 */
const SECTIONS = [
    { id: 'home', label: 'Home', form: 'home' },
    { id: 'graph', label: 'Map', form: 'graph' },
    { id: 'collaborate', label: 'Collaborate', form: null, handler: 'onCollaborate' },
];

const Navbar = ({
    setActiveForm,
    activeForm,
    user = null,
    loading = false,
    onSignIn,
    onRegister,
    onCollaborate,
    onReview,
    onLogout,
}) => {
    // Owned here so opening the narrow-screen menu re-renders the bar alone,
    // never the map underneath it.
    const [menuOpen, setMenuOpen] = useState(false);

    const handlers = { onCollaborate };

    /**
     * A section either switches Home's view or navigates via its handler.
     *
     * The menu closes only when something actually happened. A section with no
     * destination — a handler the parent did not supply — leaves the menu open,
     * because closing it would lose the reader's place in exchange for nothing.
     */
    const go = (section) => {
        if (section.form) {
            setActiveForm(section.form);
            setMenuOpen(false);
            return;
        }
        const handler = section.handler ? handlers[section.handler] : null;
        if (handler) {
            setMenuOpen(false);
            handler();
        }
    };

    /**
     * Review is shown to reviewers only.
     *
     * THIS IS A COURTESY, NOT A SECURITY CONTROL. Every reviewer route is
     * enforced server-side by requireReviewer in the API, which reads the role
     * from the database on each request; hiding the link only spares a
     * contributor a 403 they can do nothing about. Do not treat this condition
     * as protection, and do not weaken anything on the server because of it.
     */
    const isReviewer = Boolean(user && user.role === 'reviewer');

    return (
        <nav className="pdm-nav" aria-label="Main">
            <div className="pdm-nav-inner">
                <button type="button" className="pdm-nav-brand" onClick={() => go({ form: 'home' })}>
                    ETS
                </button>

                <button
                    type="button"
                    className="pdm-nav-burger"
                    aria-label="Menu"
                    aria-expanded={menuOpen}
                    aria-controls="pdm-nav-menu"
                    onClick={() => setMenuOpen((open) => !open)}
                >
                    <span aria-hidden="true" />
                    <span aria-hidden="true" />
                    <span aria-hidden="true" />
                </button>

                <div
                    className={`pdm-nav-menu${menuOpen ? ' is-open' : ''}`}
                    id="pdm-nav-menu"
                >
                    <div className="pdm-nav-links">
                        {SECTIONS.map((section) => {
                            const current = section.id === activeForm;
                            return (
                                <button
                                    key={section.label}
                                    type="button"
                                    className={`pdm-nav-link${current ? ' is-current' : ''}`}
                                    aria-current={current ? 'page' : undefined}
                                    onClick={() => go(section)}
                                >
                                    {section.label}
                                </button>
                            );
                        })}

                        {isReviewer && (
                            <button
                                type="button"
                                className={`pdm-nav-link${activeForm === 'review' ? ' is-current' : ''}`}
                                aria-current={activeForm === 'review' ? 'page' : undefined}
                                onClick={() => { setMenuOpen(false); if (onReview) onReview(); }}
                            >
                                Review
                            </button>
                        )}
                    </div>

                    <div className="pdm-nav-account">
                        {loading ? (
                            // A neutral placeholder rather than the signed-out pair.
                            // Rendering Sign in / Register and swapping them for the
                            // account name a moment later reads as a bug, and it is
                            // the first thing every visitor would see.
                            <span className="pdm-nav-account-pending" aria-hidden="true" />
                        ) : user ? (
                            <div className="pdm-nav-account-signed-in">
                                {/* Quiet by design: a third coloured button would compete
                                    with Sign in and Register for no reason — this is a
                                    status, not a call to action. */}
                                <span className="pdm-nav-account-name" title={user.display_name}>
                                    {user.display_name}
                                </span>
                                <button type="button" className="pdm-nav-signout" onClick={onLogout}>
                                    Log out
                                </button>
                            </div>
                        ) : (
                            <>
                                <button type="button" className="pdm-nav-signin" onClick={onSignIn}>
                                    Sign in
                                </button>
                                <button type="button" className="pdm-nav-register" onClick={onRegister}>
                                    Register
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </nav>
    );
};

export default Navbar;
