import React, { useState } from 'react';
import Navbar from './Components/Navbar/Navbar';
import AddNodeForm from './Components/AddNodeForm/AddNodeForm';
import AddReferenceForm from './Components/AddReferenceForm/AddReferenceForm';
import GraphVisualization from './Components/GraphVisualization/GraphVisualization';

const App = () => {
    const [activeForm, setActiveForm] = useState('graph');

    return (
        <div>
            <Navbar setActiveForm={setActiveForm} />
            {activeForm === 'node' && <AddNodeForm />}
            {activeForm === 'reference' && <AddReferenceForm />}
            {activeForm === 'graph' && <GraphVisualization />}

        </div>
    );
};

export default App;
