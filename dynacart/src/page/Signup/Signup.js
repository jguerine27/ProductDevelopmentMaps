import React, { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../../firebase';
import './Signup.css'; // Import the CSS file

const Signup = () => {
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');

    const onSubmit = async (e) => {
        e.preventDefault();

        await createUserWithEmailAndPassword(auth, email, password)
            .then((userCredential) => {
                const user = userCredential.user;
                console.log(user);
                navigate("/login");
            })
            .catch((error) => {
                const errorCode = error.code;
                const errorMessage = error.message;
                console.log(errorCode, errorMessage);
            });
    }

    return (
        <div className="container">
            <div className="header">
                <h1>Dynamic Maps</h1>
                <h2>Sign up</h2>
            </div>
            <form>
                <div className="form-group">
                    <label htmlFor="email-address">Email address</label>
                    <input
                        id="email-address"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        placeholder="Email address"
                    />
                </div>
                <div className="form-group">
                    <label htmlFor="password">Password</label>
                    <input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        placeholder="Password"
                    />
                </div>
                <button className="button" type="submit" onClick={onSubmit}>Sign up</button>
            </form>
            <div className="footer">
                <NavLink to="/login">Already have an account? Sign in</NavLink>
            </div>
        </div>
    );
}

export default Signup;
