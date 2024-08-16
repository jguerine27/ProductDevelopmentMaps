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
                    <button onClick={() => setActiveForm('node')}>Add a Node</button>
                </li>
                <li>
                    <button onClick={()=> setActiveForm('reviewNode')}>Review added nodes</button>
                </li>
                <li>
                    <button onClick={() => setActiveForm('reference')}>Add a Reference/Relation</button>
                </li>
                <li>
                    <button onClick={() => setActiveForm('reviewReference')}>Review added references</button>
                </li>
                <li>
                    <button onClick={() => setActiveForm('updateNode')}>Update Node</button>
                </li>
                <li>
                    <button onClick={() => setActiveForm('delete')}>Delete References/Nodes</button>
                </li>
                <li>
                    <button onClick={() => setActiveForm('graph')}>View Graph</button>
                </li>
            </ul>
        </nav>
    );
};

export default Navbar;
