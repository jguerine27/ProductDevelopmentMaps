import React, { useState } from 'react';
import Navbar from './Navbar';
import AddNodeForm from './AddNodeForm';
import AddReferenceForm from './AddReferenceForm';

const App = () => {
    const [activeForm, setActiveForm] = useState('node');

    return (
        <div>
            <Navbar setActiveForm={setActiveForm} />
            {activeForm === 'node' && <AddNodeForm />}
            {activeForm === 'reference' && <AddReferenceForm />}
        </div>
    );
};

export default App;
