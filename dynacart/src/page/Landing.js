import React from 'react';
import { Link } from 'react-router-dom';
import AppShell from '../Components/AppShell/AppShell';
import './Landing.css';

/**
 * The landing page at /.
 *
 * / used to redirect straight to /map, which dropped a first-time visitor into a
 * dense circular graph with no explanation of what they were looking at. This is
 * the page that redirect was holding the slot for; the map stays at /map.
 *
 * The page's own content is static — no session, no fetch, nothing to wait on.
 * It is copy and two links, and it reads the same for a signed-out visitor as
 * for anyone else. Only the shell above it knows who is signed in.
 *
 * It wears AppShell like every other full-page route. This page shipped without
 * one first, on the grounds that its two buttons were navigation enough — but a
 * signed-in reader who followed the bar's Home link arrived here and lost the
 * bar, their account name and Log out along with it. That is the exact failure
 * AppShell was extracted to stop, and the landing page is no exception to it.
 *
 * `activeForm="home"` marks the bar's Home link as current. No `setActiveForm`,
 * because this page has no sections to switch — the bar's Map link navigates to
 * /map instead, which is what the shell does when none is given.
 */
const Landing = () => (
    <AppShell activeForm="home" stayOnSignOut>
        <div className="pdm-landing">
            <section className="pdm-landing-hero">
                <h1 className="pdm-landing-title">Product Development</h1>
                <p className="pdm-landing-tagline">
                    A collaborative platform to bridge the gap between research and industry
                </p>
                <div className="pdm-landing-actions">
                    <Link
                        className="pdm-landing-button pdm-landing-button-secondary"
                        to="/collaborate"
                    >
                        Collaborate
                    </Link>
                    <Link
                        className="pdm-landing-button pdm-landing-button-primary"
                        to="/map"
                    >
                        View Map
                    </Link>
                </div>
            </section>

            <section className="pdm-landing-points">
                <div className="pdm-landing-point">
                    <h2>What it is?</h2>
                    <p>
                        An interactive map which visually organizes the complex
                        landscape of multidisciplinary product development, spanning
                        approaches, processes, methods, and tools
                    </p>
                </div>
                <div className="pdm-landing-point">
                    <h2>What it solves?</h2>
                    <p>
                        It supports selection of concepts and techniques by filtering through real-world engineering challenges, it transforms static academic
                        research into an actionable, dynamic engine.
                    </p>
                </div>
                <div className="pdm-landing-point">
                    <h2>How it helps?</h2>
                    <p>
                        It helps engineering teams to select the right methodologies for their
                        projects, discover intersecting practices across disciplines, and
                        allows collaborative expansion of industry knowledge.
                    </p>
                </div>
            </section>
        </div>
    </AppShell>
);

export default Landing;
