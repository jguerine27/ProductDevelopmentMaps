import React, { useState } from 'react';
import './Navbar.css';

/**
 * The application bar: wordmark left, section links and the account controls
 * right.
 *
 * These are BUTTONS rather than anchors because the app has no route for the
 * map — Home and Map are two values of Home.js's `activeForm`, switched in
 * place. An <a> without an href is not a link to anything, so a button is the
 * honest element; `aria-current` still marks which section is showing.
 *
 * Collaborate and Review are rendered exactly like the working sections but go
 * nowhere yet, deliberately: they are signposts for work not yet built, and
 * greying them out would say "broken" rather than "coming".
 */

/** Sections that switch Home's view. `form` is null for the not-yet-built ones. */
const SECTIONS = [
    { label: 'Home', form: 'home' },
    { label: 'Map', form: 'graph' },
    { label: 'Collaborate', form: null },
    { label: 'Review', form: null },
];

const Navbar = ({ setActiveForm, activeForm, onLogout }) => {
    // Owned here so opening the narrow-screen menu re-renders the bar alone,
    // never the map underneath it.
    const [menuOpen, setMenuOpen] = useState(false);

    const go = (form) => {
        if (!form) return;
        setActiveForm(form);
        setMenuOpen(false);
    };

    return (
        <nav className="pdm-nav" aria-label="Main">
            <div className="pdm-nav-inner">
                <button type="button" className="pdm-nav-brand" onClick={() => go('home')}>
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
                            const current = section.form !== null && section.form === activeForm;
                            return (
                                <button
                                    key={section.label}
                                    type="button"
                                    className={`pdm-nav-link${current ? ' is-current' : ''}`}
                                    aria-current={current ? 'page' : undefined}
                                    onClick={() => go(section.form)}
                                >
                                    {section.label}
                                </button>
                            );
                        })}
                    </div>

                    <div className="pdm-nav-account">
                        {onLogout ? (
                            // The app already has a working signed-in state, so the
                            // design's signed-out pair would strand a signed-in user
                            // with no way out.
                            <button type="button" className="pdm-nav-signout" onClick={onLogout}>
                                Log out
                            </button>
                        ) : (
                            <>
                                <button type="button" className="pdm-nav-signin">Sign in</button>
                                <button type="button" className="pdm-nav-register">Register</button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </nav>
    );
};

export default Navbar;
