import React from 'react';
import './Navbar.css'; // Import CSS file for styling

const Navbar = ({ setActiveForm }) => {
    return (
        <nav>
            <ul>
                <li>
                    <button onClick={() => setActiveForm('home')}>Home</button>
                </li>
               
                <li>
                    <button onClick={() => setActiveForm('graph')}>View Graph</button>
                </li>
            </ul>
        </nav>
    );
};

export default Navbar;
