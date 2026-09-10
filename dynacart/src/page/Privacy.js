import React from 'react';
import { Link } from 'react-router-dom';
import { CONSENT_VERSION } from '../auth/AuthContext';
import '../auth/AuthScreens.css';

/**
 * The privacy notice the registration consent checkbox links to.
 *
 * Consent to an unwritten notice is not consent, so this page exists rather than
 * a dead link. Every claim below is checked against what the backend actually
 * stores — services/users.js and services/dataRights.js — and must be updated
 * alongside them, not from memory.
 *
 * Ratings, comments and tags ship next sprint. When they do, this page and
 * CONSENT_VERSION both need revising.
 */
const Privacy = () => (
    <div className="pdm-auth-notice">
        <h1>Privacy notice</h1>
        {/* <p><strong>Version {CONSENT_VERSION}</strong></p>

        <h2>What is stored about you</h2>
        <p>When you create an account, this application stores:</p>
        <ul>
            <li>a generated identifier for your account;</li>
            <li>your display name, shown alongside anything you contribute;</li>
            <li>which sign-in provider you used, and that provider&apos;s own identifier for you;</li>
            <li>your ORCID iD, if you signed in with ORCID;</li>
            <li>your role — contributor or peer reviewer;</li>
            <li>when your account was created and when you were last seen;</li>
            <li>which version of this notice you accepted, and when.</li>
        </ul>

        <h2>What is deliberately not stored</h2>
        <p>
            <strong>Your email address is not stored here.</strong> Your sign-in
            provider holds it; copying it into this application would duplicate
            personal data into a second system for no functional gain.
        </p>
        <p>
            No IP address, no browser or device information, and no analytics or
            tracking of any kind is recorded. Nothing is shared with third parties
            beyond the sign-in provider you chose.
        </p>

        <h2>Your contributions</h2>
        <p>
            Blocks, links, references and other content you propose are recorded
            against your account so a reviewer can see who proposed them. Once
            approved they become part of the published cartographies.
        </p>

        <h2>Your rights</h2>
        <p>
            You can obtain a copy of everything held about you at any time, as a
            JSON file, from your account.
        </p>
        <p>
            You can also delete your account. Doing so removes your account record
            entirely. Content you contributed that has already been approved stays
            — it is map content at that point, and removing it would damage the
            cartographies for everyone else — but it is no longer attributed to
            you, and neither are any review decisions you made. This is anonymisation
            rather than deletion of the content itself, and it is irreversible.
        </p>

        <h2>Who to contact</h2>
        <p>
            This application is maintained by the research group behind the
            Multidisciplinary Product Development cartographies at ÉTS. Contact them
            through the repository or your usual research contact to exercise any of
            these rights or to ask a question about this notice.
        </p>

        <div className="pdm-auth-notice-actions">
            <Link className="pdm-auth-button" to="/map">Back to the map</Link>
        </div> */}
    </div>
);

export default Privacy;
