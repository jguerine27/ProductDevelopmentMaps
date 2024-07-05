import React from 'react';

const Navbar = ({ setActiveForm }) => {
    return (
        <nav>
            <ul>
                <li>
                    <button onClick={() => setActiveForm('node')}>Add a Node</button>
                </li>
                <li>
                    <button onClick={() => setActiveForm('reference')}>Add a Reference/Relation</button>
                </li>
                <li>
                    <button onClick={() => setActiveForm('data')}>View Data</button>
                </li>
                <li>
                    <button onClick={() => setActiveForm('graph')}>View Graph</button>
                </li>
            </ul>
        </nav>
    );
};

export default Navbar;
