import React from 'react';
import './Navbar.css'; // Import the CSS file

const Navbar = ({ setActiveForm }) => {
  return (
    <nav>
      <ul className="nav-links">
        <li>
          <button onClick={() => setActiveForm('home')}>Home</button>
        </li>
        <li className="center">
          <button onClick={() => setActiveForm('node')}>Add a Node</button>
        </li>
        <li className="upward">
          <button onClick={() => setActiveForm('reviewNode')}>Review Added Nodes</button>
        </li>
        <li className="forward">
          <button onClick={() => setActiveForm('reference')}>Add a Reference/Relation</button>
        </li>
        <li>
          <button onClick={() => setActiveForm('reviewReference')}>Review Added References</button>
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
