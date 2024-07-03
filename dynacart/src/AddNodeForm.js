import React, { useState, useEffect } from 'react';

const AddNodeForm = ({ fetchNodeLabels }) => {
    const [nodeLabels, setNodeLabels] = useState([]);
    const [selectedLabel, setSelectedLabel] = useState('');
    const [nodeName, setNodeName] = useState('');
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

    const handleSubmit = async (e) => {
        e.preventDefault();

        try {
            const response = await fetch('http://localhost:4000/api/create-node', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    label: selectedLabel,
                    name: nodeName,
                }),
            });

            const data = await response.json();
            setMessage(data.message || 'Node created successfully');
        } catch (error) {
            console.error('Error creating node:', error);
            setMessage('An error occurred');
        }
    };

    return (
        <div>
            <h2>Add a Node</h2>
            <form onSubmit={handleSubmit}>
                <div>
                    <label>Select Node Label:</label>
                    <select value={selectedLabel} onChange={(e) => setSelectedLabel(e.target.value)}>
                        <option value="">Select a label</option>
                        {nodeLabels.map(label => (
                            <option key={label} value={label}>{label}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label>Node Name:</label>
                    <input
                        type="text"
                        value={nodeName}
                        onChange={(e) => setNodeName(e.target.value)}
                    />
                </div>
                <button type="submit">Add Node</button>
            </form>
            {message && <p>{message}</p>}
        </div>
    );
};

export default AddNodeForm;
