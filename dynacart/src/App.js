import React, { useState } from 'react';
import Navbar from './Navbar';
import AddNodeForm from './AddNodeForm';
import AddReferenceForm from './AddReferenceForm';
import DataTable from './DataTable';
import GraphVisualization from './GraphVisualization';

const App = () => {
    const [activeForm, setActiveForm] = useState('node');

    return (
        <div>
            <Navbar setActiveForm={setActiveForm} />
            {activeForm === 'node' && <AddNodeForm />}
            {activeForm === 'reference' && <AddReferenceForm />}
            {activeForm === 'data' && <DataTable />}
            {activeForm === 'graph' && <GraphVisualization />}

        </div>
    );
};

export default App;
