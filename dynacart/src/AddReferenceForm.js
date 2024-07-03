import React, { useState, useEffect } from 'react';

const AddReferenceForm = ({ fetchNodeLabels }) => {
    const [nodeLabels, setNodeLabels] = useState([]);
    const [selectedLabel1, setSelectedLabel1] = useState('');
    const [nodeName1, setNodeName1] = useState('');
    const [selectedLabel2, setSelectedLabel2] = useState('');
    const [nodeName2, setNodeName2] = useState('');
    const [relationshipLabel, setRelationshipLabel] = useState('');
    const [relationshipName, setRelationshipName] = useState('');
    const [message, setMessage] = useState('');

    useEffect(() => {
        const fetchLabels = async () => {
            try {
                const response = await fetch('http://localhost:4000/api/node-labels');
                if (response.ok) {
                    const labels = await response.json();
                    setNodeLabels(labels);
                } else {
                    throw new Error('Failed to fetch node labels');
                }
            } catch (error) {
                console.error('Error fetching node labels:', error);
            }
        };

        fetchLabels();
    }, []);

    const handleNodeChange = async (label, setter) => {
        try {
            const response = await fetch(`http://localhost:4000/api/node-names/${label}`);
            if (response.ok) {
                const names = await response.json();
                setter(names[0] || '');
            } else {
                throw new Error('Failed to fetch node names');
            }
        } catch (error) {
            console.error(`Error fetching node names for label ${label}:`, error);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        try {
            const response = await fetch('http://localhost:4000/create-relationship', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    nodeLabel1: selectedLabel1,
                    nodeName1,
                    nodeLabel2: selectedLabel2,
                    nodeName2,
                    relationshipLabel,
                    relationshipName,
                }),
            });

            const data = await response.json();
            setMessage(data.message || 'Relationship created successfully');
        } catch (error) {
            console.error('Error creating relationship:', error);
            setMessage('An error occurred');
        }
    };

    return (
        <div>
            <h2>Add a Reference/Relation</h2>
            <form onSubmit={handleSubmit}>
                <div>
                    <label>Select Node Label 1:</label>
                    <select value={selectedLabel1} onChange={(e) => { setSelectedLabel1(e.target.value); handleNodeChange(e.target.value, setNodeName1); }}>
                        <option value="">Select a label</option>
                        {nodeLabels.map(label => (
                            <option key={label} value={label}>{label}</option>
                        ))}
                    </select>
                    <label>Node Name 1:</label>
                    <input
                        type="text"
                        value={nodeName1}
                        onChange={(e) => setNodeName1(e.target.value)}
                    />
                </div>
                <div>
                    <label>Select Node Label 2:</label>
                    <select value={selectedLabel2} onChange={(e) => { setSelectedLabel2(e.target.value); handleNodeChange(e.target.value, setNodeName2); }}>
                        <option value="">Select a label</option>
                        {nodeLabels.map(label => (
                            <option key={label} value={label}>{label}</option>
                        ))}
                    </select>
                    <label>Node Name 2:</label>
                    <input
                        type="text"
                        value={nodeName2}
                        onChange={(e) => setNodeName2(e.target.value)}
                    />
                </div>
                <div>
                    <label>Relationship Label:</label>
                    <input
                        type="text"
                        value={relationshipLabel}
                        onChange={(e) => setRelationshipLabel(e.target.value)}
                    />
                </div>
                <div>
                    <label>Relationship Name:</label>
                    <input
                        type="text"
                        value={relationshipName}
                        onChange={(e) => setRelationshipName(e.target.value)}
                    />
                </div>
                <button type="submit">Add Relationship</button>
            </form>
            {message && <p>{message}</p>}
        </div>
    );
};

export default AddReferenceForm;
