import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import '../../auth/AuthScreens.css';

/**
 * Register.
 *
 * Creates the Firebase account, exchanges the ID token for a server session,
 * then sets the display name through PATCH /api/auth/me. Registration yields the
 * 'user' role; reviewer status comes from ORCID, not from this form.
 *
 * ── CONSENT ──────────────────────────────────────────────────────────────────
 * The checkbox is unticked by default and submission is blocked until it is
 * ticked, because consent that is pre-given is not consent. Quebec Law 25
 * requires it to be demonstrable, which is what AppUser.consent_version and
 * consent_at exist for. See CONSENT_VERSION in auth/AuthContext.js for the
 * backend gap that currently stops the record being written.
 */

const MIN_PASSWORD = 6;

const Signup = () => {
    const navigate = useNavigate();
    const { register, signInWithOrcid, describeError } = useAuth();

    const [form, setForm] = useState({
        displayName: '', email: '', password: '', confirm: '',
    });
    const [consent, setConsent] = useState(false);
    const [fieldErrors, setFieldErrors] = useState({});
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const update = (field) => (event) => {
        setForm((current) => ({ ...current, [field]: event.target.value }));
        setFieldErrors((current) => ({ ...current, [field]: undefined }));
    };

    /** Client-side first, so obvious mistakes never cost a round trip. */
    const validate = () => {
        const errors = {};
        if (!form.displayName.trim()) {
            errors.displayName = 'Enter the name to show on your contributions.';
        } else if (form.displayName.trim().length > 120) {
            errors.displayName = 'Use 120 characters or fewer.';
        }
        if (!form.email.trim()) errors.email = 'Enter your email address.';
        else if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) errors.email = 'That does not look like a valid email address.';

        if (!form.password) errors.password = 'Choose a password.';
        else if (form.password.length < MIN_PASSWORD) {
            errors.password = `Use at least ${MIN_PASSWORD} characters.`;
        }
        if (form.confirm !== form.password) errors.confirm = 'The two passwords do not match.';

        setFieldErrors(errors);
        return Object.keys(errors).length === 0;
    };

    const onSubmit = async (event) => {
        event.preventDefault();
        setError('');
        if (!validate()) return;
        if (!consent) {
            setError('Please read and accept the privacy notice before registering.');
            return;
        }

        setBusy(true);
        try {
            await register({
                email: form.email.trim(),
                password: form.password,
                displayName: form.displayName.trim(),
            });
            navigate('/map', { replace: true });
        } catch (err) {
            setError(describeError(err));
        } finally {
            setBusy(false);
        }
    };

    const field = (id, label, type, key, extra = {}, hint = null) => (
        <div className="pdm-auth-field">
            <label htmlFor={id}>{label}</label>
            <input
                id={id}
                type={type}
                value={form[key]}
                onChange={update(key)}
                aria-invalid={fieldErrors[key] ? 'true' : undefined}
                aria-describedby={fieldErrors[key] ? `${id}-error` : (hint ? `${id}-hint` : undefined)}
                {...extra}
            />
            {fieldErrors[key] && (
                <span className="pdm-auth-field-error" id={`${id}-error`}>{fieldErrors[key]}</span>
            )}
            {!fieldErrors[key] && hint && (
                <span className="pdm-auth-hint" id={`${id}-hint`}>{hint}</span>
            )}
        </div>
    );

    return (
        <div className="pdm-auth">
            <div className="pdm-auth-card">
                <p className="pdm-auth-brand">Product Development Maps</p>
                <h1>Create an account</h1>
                <br></br>

                {error && <div className="pdm-auth-error" role="alert">{error}</div>}

                <form onSubmit={onSubmit} noValidate>
                    {field('signup-name', 'Display name', 'text', 'displayName', {
                        autoComplete: 'name',
                    }, 'Shown alongside anything you contribute.')}

                    {field('signup-email', 'Email address', 'email', 'email', {
                        autoComplete: 'email',
                    })}
                    {field('signup-password', 'Password', 'password', 'password', {
                        autoComplete: 'new-password',
                    })}
                    {field('signup-confirm', 'Confirm password', 'password', 'confirm', {
                        autoComplete: 'new-password',
                    })}

                    <div className="pdm-auth-consent">
                        <input
                            id="signup-consent"
                            type="checkbox"
                            checked={consent}
                            onChange={(e) => setConsent(e.target.checked)}
                        />
                        <label htmlFor="signup-consent">
                            I have read and accept the{' '}
                            <Link to="/privacy">privacy notice</Link>, and consent to my
                            display name and contributions being stored and shown on this
                            site.
                        </label>
                    </div>

                    <button
                        type="submit"
                        className="pdm-auth-submit pdm-auth-submit-spaced"
                        disabled={busy || !consent}
                    >
                        {busy ? 'Creating your account…' : 'Register'}
                    </button>
                </form>

                <div className="pdm-auth-divider">or</div>

                <button type="button" className="pdm-auth-orcid" onClick={signInWithOrcid}>
                    <span className="pdm-auth-orcid-mark" aria-hidden="true">iD</span>
                    Continue with ORCID
                </button>
                <p className="pdm-auth-orcid-note">
                    ORCID identifies you as a peer reviewer through your research identity.
                </p>

                <p className="pdm-auth-footer">
                    Already have an account? <Link to="/login">Sign in</Link>
                </p>
                <p className="pdm-auth-back">
                    <Link to="/map">Back to the map</Link>
                </p>
            </div>
        </div>
    );
};

export default Signup;
