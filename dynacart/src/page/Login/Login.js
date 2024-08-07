import React, { useState, useEffect } from 'react';
import { signInWithCustomToken } from 'firebase/auth';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../../firebase';
import { NavLink, useNavigate } from 'react-router-dom';
import './Login.css'; // Import the CSS file

const Login = () => {
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    const onLogin = (e) => {
        e.preventDefault();
        setLoading(true);
        signInWithEmailAndPassword(auth, email, password)
            .then((userCredential) => {
                setLoading(false);
                setSuccess(true);
                setTimeout(() => {
                    navigate("/home");
                }, 2000); // Redirect to /home after 2 seconds
            })
            .catch((error) => {
                setLoading(false);
                setError('Incorrect credentials');
                setTimeout(() => {
                    setError('');
                }, 5000); // Clear error after 5 seconds
            });
    };

    const onOrcidLogin = () => {
        window.location.href = 'https://maps-backend-git-orcid-api-muhammad-bilals-projects-bd7acfbb.vercel.app//orcid/login'; // Redirect to your server's ORCID login endpoint
    };

    const handleCustomTokenLogin = async (firebaseToken) => {
        try {
            await signInWithCustomToken(auth, firebaseToken);
            navigate('/home');
        } catch (error) {
            setError('ORCID authentication failed');
            setTimeout(() => {
                setError('');
            }, 5000);
        }
    };

    // Call this function after redirecting back from ORCID and getting the token
    const handleOrcidCallback = () => {
        const urlParams = new URLSearchParams(window.location.search);
        const firebaseToken = urlParams.get('firebaseToken');
        if (firebaseToken) {
            handleCustomTokenLogin(firebaseToken);
        }
    };

    useEffect(() => {
        handleOrcidCallback();
    }, []);

    return (
        <div className="container">
            <div className="header">
                <h1>Dynamic Maps</h1>
                <h2>Sign in</h2>
            </div>
            <form>
                <div className="form-group">
                    <label htmlFor="email-address">Email address</label>
                    <input
                        id="email-address"
                        name="email"
                        type="email"
                        required
                        placeholder="Email address"
                        onChange={(e) => setEmail(e.target.value)}
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="password">Password</label>
                    <input
                        id="password"
                        name="password"
                        type="password"
                        required
                        placeholder="Password"
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </div>
                <button className="button" onClick={onLogin}>
                    {loading ? 'Loading...' : 'Login'}
                </button>
            </form>
            <button className="button" onClick={onOrcidLogin}>
                Sign in with ORCID
            </button>
            {error && <div className="error-message">{error}</div>}
            {success && (
                <div className="success-message">
                    <span>Sign in successful</span>
                    <span className="checkmark">✔️</span>
                </div>
            )}
            <div className="footer">
                <NavLink to="/signup">Don't have an account? Sign up</NavLink>
            </div>
        </div>
    );
};

export default Login;
