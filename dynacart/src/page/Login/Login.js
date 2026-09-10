import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import '../../auth/AuthScreens.css';

/**
 * Sign in.
 *
 * Email and password go through Firebase and are then exchanged for a server
 * session; ORCID leaves the app entirely and comes back through the backend
 * callback. Both paths end in the same place — a session cookie and a
 * GET /api/auth/me the rest of the app trusts.
 */
const Login = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const { signInWithEmail, signInWithOrcid, describeError } = useAuth();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    // Where the user was heading before the guard intercepted them.
    const destination = (location.state && location.state.from && location.state.from.pathname) || '/map';

    const onSubmit = async (event) => {
        event.preventDefault();
        setError('');

        if (!email.trim() || !password) {
            setError('Enter your email address and password.');
            return;
        }

        setBusy(true);
        try {
            await signInWithEmail(email.trim(), password);
            navigate(destination, { replace: true });
        } catch (err) {
            setError(describeError(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="pdm-auth">
            <div className="pdm-auth-card">
                <p className="pdm-auth-brand">Product Development Maps</p>
                <h1>Sign in</h1>
                <br></br>
                {error && <div className="pdm-auth-error" role="alert">{error}</div>}

                <form onSubmit={onSubmit} noValidate>
                    <div className="pdm-auth-field">
                        <label htmlFor="login-email">Email address</label>
                        <input
                            id="login-email"
                            name="email"
                            type="email"
                            autoComplete="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                        />
                    </div>

                    <div className="pdm-auth-field">
                        <label htmlFor="login-password">Password</label>
                        <input
                            id="login-password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </div>

                    <button type="submit" className="pdm-auth-submit" disabled={busy}>
                        {busy ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>

                <div className="pdm-auth-divider">or</div>

                <button type="button" className="pdm-auth-orcid" onClick={signInWithOrcid}>
                    <span className="pdm-auth-orcid-mark" aria-hidden="true">iD</span>
                    Sign in with ORCID
                </button>
                <p className="pdm-auth-orcid-note">
                    ORCID identifies you as a peer reviewer through your research identity,
                    which lets you review and approve proposed contributions.
                </p>

                <p className="pdm-auth-footer">
                    Don&apos;t have an account? <Link to="/signup">Register</Link>
                </p>
                <p className="pdm-auth-back">
                    <Link to="/map">Back to the map</Link>
                </p>
            </div>
        </div>
    );
};

export default Login;
